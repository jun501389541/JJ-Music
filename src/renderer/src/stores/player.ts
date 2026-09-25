/**
 * Playback store: the queue, transport state, and lyric loading.
 *
 * Everything here is engine-agnostic — it drives the `AudioEngine` interface,
 * so swapping in a native engine changes nothing in this file.
 */
import { useLibraryStore } from './library'
import { toMediaUrl } from '@shared/media-url'
import { defineStore } from 'pinia'
import { computed, ref, shallowRef, toRaw } from 'vue'
import type { AudioEngine } from '@shared/audio-engine'
import { EQUALIZER_PRESETS } from '@shared/audio-engine'
import type {
  AssetRef,
  LastSession,
  LyricSource,
  OnlineLyricSource,
  OnlineMusicInfo,
  PlayableTrack,
  PlayMode,
  Quality,
  QueueSnapshot,
  SourceId
} from '@shared/types'
import { isLocalTrack, ONLINE_SOURCE_IDS } from '@shared/types'
import type { ResolvedLyric } from '@shared/library-types'
import { WebAudioEngine } from '../audio/web-audio-engine'
import { activeLineIndex, parseLyrics, type ParsedLyrics } from '../audio/lyrics'
import { cancellableMusic } from '../utils/cancellable-music'

/** How to reach a queued track's audio. */
interface ResolvedSource {
  url: string
  quality?: Quality
  /** True when the URL came from a 音源 script and may expire. */
  ephemeral: boolean
}

const URL_CACHE_TTL_MS = 5 * 60_000
const URL_CACHE_LIMIT = 128

function urlKey(track: OnlineMusicInfo, preferred: Quality): string {
  return `${track.source}::${track.id}::${preferred}`
}

function sameRecording(a: OnlineMusicInfo, b: OnlineMusicInfo): boolean {
  const normalize = (text: string): string => text.normalize('NFKC').replace(/\s+/g, '').toLowerCase()
  // Keep version suffixes (Live/remix/伴奏): they identify different recordings.
  if (!normalize(a.name) || normalize(a.name) !== normalize(b.name)) return false
  if (!normalize(a.singer) || normalize(a.singer) !== normalize(b.singer)) return false
  const seconds = (interval?: string): number | undefined => {
    if (!interval || !/^\d+:\d{2}$/.test(interval)) return undefined
    const [minutes, seconds] = interval.split(':').map(Number)
    return seconds < 60 ? minutes * 60 + seconds : undefined
  }
  const left = seconds(a.interval)
  const right = seconds(b.interval)
  return left !== undefined && right !== undefined && Math.abs(left - right) <= 5
}

/** Stored snapshots beside the live queue: three pages in the panel, two on disk. */
const QUEUE_HISTORY_LIMIT = 2

export const usePlayerStore = defineStore('player', () => {
  const engine = shallowRef<AudioEngine | null>(null)

  const queue = ref<PlayableTrack[]>([])
  /**
   * The queues that were playing before this one, newest first.
   *
   * Two entries, not three: the live queue is the third page of the panel, so
   * "3 个历史列表" means three pages you can look at, and only two of them are
   * somewhere else.
   */
  const queueHistory = ref<QueueSnapshot[]>([])
  /** The name the live queue was started under, so it can be filed correctly later. */
  const queueLabel = ref('')
  const currentIndex = ref(-1)
  const playing = ref(false)
  const loading = ref(false)
  const waiting = ref(false)
  const currentTime = ref(0)
  const duration = ref(0)
  const volume = ref(0.8)
  const muted = ref(false)
  const playMode = ref<PlayMode>('list')
  const rate = ref(1)
  const error = ref<string | null>(null)

  const lyrics = ref<ParsedLyrics | null>(null)
  const lyricLoading = ref(false)
  /** Where the displayed lyric came from, for the UI's source badge. */
  const lyricSource = ref<LyricSource>('none')
  /**
   * The asset record for the lyric being shown — where it lives and who gave it.
   *
   * Kept apart from `lyricSource` (which only says "在线") because switching
   * provider is the action the user takes when the words are wrong, and that needs
   * to say who wrote them. Local and online lyrics use the same record, so the
   * badge does not need to know which kind of track is playing.
   */
  const lyricAsset = ref<AssetRef | null>(null)
  /**
   * A source forced for the current track, from the now-playing menu.
   *
   * Deliberately per-track rather than a setting: "this song's lyric is wrong,
   * show me another" should not silently rewrite which provider every later song
   * asks first.
   */
  const lyricSourceChoice = ref<OnlineLyricSource | null>(null)
  let lyricSourceChoiceTrack: string | null = null
  /** Why no lyric is shown, when that is the case. */
  const lyricError = ref<string | null>(null)

  const quality = ref<Quality>('flac24bit')
  /**
   * The tier the *current* track's audio was actually resolved at.
   *
   * A source may answer lower than asked (`MusicUrlResult.quality` is documented
   * as "may be lower than requested"), and the picker above records only what
   * the user requested. Showing the request back to them is how "FLAC" gets
   * displayed for a file that arrived at 320k, so the answer is kept here and
   * the UI reads this — falling back to the request when nothing was resolved
   * (a locally preferred file has no tier at all).
   */
  const resolvedQuality = ref<Quality | null>(null)
  const equalizer = ref<number[]>([...EQUALIZER_PRESETS['平坦']])
  const equalizerPreset = ref('平坦')

  /** Cache of resolved URLs, keyed by track id + quality. */
  const urlCache = new Map<string, { source: ResolvedSource; expiresAt: number }>()

  function cacheUrl(key: string, source: ResolvedSource): void {
    urlCache.delete(key)
    if (urlCache.size >= URL_CACHE_LIMIT) urlCache.delete(urlCache.keys().next().value!)
    urlCache.set(key, { source, expiresAt: Date.now() + URL_CACHE_TTL_MS })
  }

  const currentTrack = computed<PlayableTrack | null>(() =>
    currentIndex.value >= 0 ? (queue.value[currentIndex.value] ?? null) : null
  )

  const activeLyricIndex = computed(() =>
    lyrics.value ? activeLineIndex(lyrics.value.lines, currentTime.value * 1000) : -1
  )

  const progress = computed(() =>
    duration.value > 0 ? Math.min(1, currentTime.value / duration.value) : 0
  )

  const hasNext = computed(() => queue.value.length > 1)
  const hasPrevious = computed(() => queue.value.length > 1)

  /* ------------------------------------------------------------ *
   * Engine lifecycle
   * ------------------------------------------------------------ */

  let recordedGeneration = -1
  function ensureEngine(): AudioEngine {
    if (engine.value) return engine.value

    const instance = new WebAudioEngine()
    instance.on('progress', (time, total) => {
      currentTime.value = time
      duration.value = total
      // Throttled inside `snapshotSession`; the call itself is cheap.
      snapshotSession()
    })
    instance.on('ready', (total) => {
      duration.value = total
      loading.value = false
    })
    instance.on('playing', () => {
      if (currentTrack.value && loadedTrackId === currentTrack.value.id && recordedGeneration !== playGeneration) {
        recordedGeneration = playGeneration
        useLibraryStore().recordPlayed(currentTrack.value)
      }
      playing.value = true
      loading.value = false
      waiting.value = false
      // Audio is flowing again, so the stall watchdog has nothing to watch.
      clearStallTimer()
    })
    instance.on('paused', () => {
      playing.value = false
      clearStallTimer()
    })
    instance.on('waiting', (isWaiting) => {
      waiting.value = isWaiting
      if (isWaiting) armStallTimer(playGeneration)
      else clearStallTimer()
    })
    instance.on('ended', () => {
      void handleEnded()
    })
    instance.on('error', handlePlaybackError)

    instance.setVolume(volume.value)
    instance.setEqualizer(equalizer.value)
    instance.setMuted(muted.value)
    instance.setRate(rate.value)
    engine.value = instance
    return instance
  }

  /* ------------------------------------------------------------ *
   * URL resolution
   * ------------------------------------------------------------ */

  /**
   * Turn a queued track into something the engine can play.
   *
   * Local files go through the `jjmedia://` scheme so range requests and the
   * Web Audio graph both work. Online tracks are resolved through the imported
   * 音源 script, with the quality ladder handled main-side.
   */
  /**
   * Resolve a playable URL for an online track.
   *
   * ## Automatic source failover
   *
   * Online playback depends on 音源 scripts, which come and go: a relay dies,
   * a platform changes its API, an author takes a script down. When the script
   * that owns this platform fails, the track is retried on every *other* live
   * platform that can serve the same song — matched by title and artist — so a
   * dead relay becomes a one-line note instead of an error dialog.
   *
   * The cache is keyed by track id + quality, as before; a failed attempt is
   * deliberately not cached, because availability changes over time.
   */
  async function resolve(track: PlayableTrack, preferred: Quality): Promise<ResolvedSource> {
    if (isLocalTrack(track)) {
      // Encode each path segment but keep the separators intact.
      const encoded = toMediaUrl(track.path)
      return { url: encoded, ephemeral: false }
    }

    const online = track as OnlineMusicInfo
    const library = useLibraryStore()
    if (library.settings.preferLocal) {
      const local = library.tracks.find(item => sameRecording(online, { ...online, name: item.name, singer: item.singer, interval: (item.duration ? `${Math.floor(Math.round(item.duration) / 60)}:${(Math.round(item.duration) % 60).toString().padStart(2, '0')}` : '') }))
      if (local) return { url: toMediaUrl(local.path), ephemeral: false }
    }
    const key = urlKey(online, preferred)
    const cached = urlCache.get(key)
    if (cached && cached.expiresAt > Date.now()) return cached.source
    urlCache.delete(key)

    const payload = toIpcPayload(online)

    // 1. The platform the track came from.
    try {
      const result = await window.jj.music.url(online.source as SourceId, payload, preferred)
      const resolved: ResolvedSource = {
        url: result.url,
        quality: result.quality,
        ephemeral: true
      }
      cacheUrl(key, resolved)
      return resolved
    } catch (primaryError) {
      // 2. Every other live platform, matched by song rather than by id.
      const fallback = await resolveFromAlternateSource(online, preferred)
      if (fallback) return fallback

      throw primaryError
    }
  }

  /**
   * Try the remaining live platforms for the same recording.
   *
   * A match must be close: resolving the wrong song's audio would be far worse
   * than failing loudly, so the title and artist must both score well and the
   * duration must agree within a few seconds.
   */
  async function resolveFromAlternateSource(
    track: OnlineMusicInfo,
    preferred: Quality
  ): Promise<ResolvedSource | null> {
    const platforms = await window.jj.sources.available().catch(() => [])
    const others = platforms
      .filter(
        (p) =>
          p.id !== track.source &&
          p.actions.includes('musicUrl') &&
          // Only the known platforms: an unknown id is not a song source.
          ONLINE_SOURCE_IDS.includes(p.id)
      )
      .map((p) => p.id)

    if (others.length === 0) return null

    for (const platform of others) {
      try {
        // Find the same recording on this platform.
        const found = await window.jj.music.search(platform, track.name, 1)
        const candidate = found.list.find((item) => sameRecording(track, item))

        if (!candidate) continue

        const result = await window.jj.music.url(platform, toIpcPayload(candidate), preferred)
        const resolved: ResolvedSource = {
          url: result.url,
          quality: result.quality,
          ephemeral: true
        }
        cacheUrl(urlKey(track, preferred), resolved)
        return resolved
      } catch {
        /* this platform failed too; try the next one */
      }
    }

    return null
  }

  /* ------------------------------------------------------------ *
   * Transport
   * ------------------------------------------------------------ */

  /**
   * Identifies the current playback attempt.
   *
   * `playTrackAt` awaits the network, so a second call can start before the
   * first finishes. Without a generation check, the slower older request can
   * land last and start the *previous* track, which is audible as "I clicked
   * the new song but the old one kept playing". Each attempt captures the
   * generation and abandons itself if a newer one has since started.
   */
  let playGeneration = 0
  let lyricGeneration = 0
  let lyricAbort: AbortController | null = null
  let failureGeneration = -1
  let mayRetryUrl = true
  let loadedTrackId: string | null = null

  /**
   * A source that never answers must not hold the player hostage.
   *
   * The engine falls through to the next capable 音源 on an outright failure,
   * but a *hung* request (dead relay, silently dropped connection) just sits in
   * `pending` until the engine's own 20 s ceiling. Meanwhile the UI shows a
   * spinner and the user has no way to know whether it is working. Racing the
   * resolve against a shorter timer lets us report the failure and move on.
   *
   * Kept just under the engine's per-request ceiling so this fires first and
   * the message the user sees comes from here, with the track named.
   */
  const URL_RESOLVE_TIMEOUT_MS = 15_000

  /** How long audio may stall before we treat it as a failed source. */
  const STALL_TIMEOUT_MS = 20_000

  let stallTimer: ReturnType<typeof setTimeout> | undefined

  function clearStallTimer(): void {
    if (stallTimer) {
      clearTimeout(stallTimer)
      stallTimer = undefined
    }
  }

  /**
   * Arm the stall watchdog while a track is buffering.
   *
   * A source can hand back a URL that resolves but never streams — the request
   * succeeds, the element fires `waiting`, and it stays that way. Without a
   * watchdog that is an indefinite hang.
   */
  function armStallTimer(generation: number): void {
    clearStallTimer()
    stallTimer = setTimeout(() => {
      stallTimer = undefined
      if (generation !== playGeneration || !waiting.value) return
      handlePlaybackError(new Error('音源响应超时，已自动尝试切换'))
    }, STALL_TIMEOUT_MS)
  }

  /** Resolve a playable URL, giving up (and failing over) if the source hangs. */
  async function resolveWithTimeout(
    track: PlayableTrack,
    quality_: Quality
  ): Promise<ResolvedSource> {
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      return await Promise.race([
        resolve(track, quality_),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error('音源响应超时，正在尝试其他音源')),
            URL_RESOLVE_TIMEOUT_MS
          )
        })
      ])
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

  function handlePlaybackError(err: Error): void {
    if (failureGeneration === playGeneration) return
    failureGeneration = playGeneration
    clearStallTimer()
    const track = currentTrack.value
    if (track && !isLocalTrack(track)) {
      urlCache.delete(urlKey(track, quality.value))
      if (mayRetryUrl) {
        // Clearing the cached URL makes the retry ask the engine again, which
        // is what walks the source list to the next capable 音源.
        void playTrackAt(currentIndex.value, { retryUrl: false })
        return
      }
    }
    // A broken queue must not spin forever (especially in single-repeat mode).
    stop()
    failureGeneration = playGeneration
    error.value = err.message
  }

  /**
   * Guard for a lyric request.
   *
   * Two things can invalidate an in-flight request:
   *   - a different track started (the request is simply obsolete), or
   *   - a *newer lyric request* was issued for the same track.
   *
   * What must NOT invalidate it is a bump of `playGeneration` alone.
   *
   * That distinction is the "歌词有概率不会恢复" bug. `playGeneration` is bumped
   * by `playTrackAt` and by `stop()`, and it used to be part of this guard. Any
   * bump that happened while lyrics were still loading — a repeat/retry of the
   * same track, a seek-triggered re-resolve, or the auto-advance path — made
   * `isCurrent()` return false at the `return` statements inside `loadLyrics`,
   * which left `lyrics` as `null` *and* skipped the `finally` branch that clears
   * `lyricLoading`. The result was a player stuck with no lyrics and no error,
   * recoverable only by switching tracks.
   *
   * Scoping the guard to the track identity plus a lyric-request sequence keeps
   * stale responses out while letting a still-valid request finish.
   */
  function beginLyricRequest(track: PlayableTrack): () => boolean {
    lyricAbort?.abort()
    lyricAbort = new AbortController()
    const generation = ++lyricGeneration
    return () =>
      generation === lyricGeneration && currentTrack.value?.id === track.id
  }

  /**
   * Stop playback immediately, without clearing the queue.
   *
   * Called the moment a new track is requested, before any network work, so the
   * outgoing track stops at once rather than playing on through the load.
   */
  function haltEngine(): void {
    loadedTrackId = null
    const instance = engine.value
    if (!instance) return
    instance.pause()
    instance.stop()
    playing.value = false
    currentTime.value = 0
  }

  async function playTrackAt(
    index: number,
    options: { autoplay?: boolean; retryUrl?: boolean; startAt?: number } = {}
  ): Promise<void> {
    if (index < 0 || index >= queue.value.length) return
    const generation = ++playGeneration
    lyricGeneration += 1
    lyricAbort?.abort()
    mayRetryUrl = options.retryUrl !== false
    const track = queue.value[index]
    currentIndex.value = index
    if (playMode.value === 'random') rememberRandomDraw(track.id)
    error.value = null
    loading.value = true
    lyrics.value = null
    lyricSource.value = 'none'
    lyricError.value = null
    lyricLoading.value = false
    duration.value = 0
    waiting.value = false
    /*
     * Cleared per attempt, not kept: the outgoing track's tier says nothing
     * about what the incoming one will be served, and a stale `flac` on a track
     * that then resolves at 128k is the same lie in the other direction.
     */
    resolvedQuality.value = null

    // Silence the outgoing track straight away. Resolving a URL can take
    // seconds; leaving the old audio running until then is the reported bug.
    haltEngine()

    const isStale = (): boolean => generation !== playGeneration

    try {
      const source = await resolveWithTimeout(track, quality.value)
      // A newer selection superseded this one while we were resolving.
      if (isStale()) return
      // Recorded only once this attempt survived the generation check, so a
      // superseded resolve cannot leave the previous track labelled with it.
      resolvedQuality.value = source.quality ?? null

      const instance = ensureEngine()
      /*
       * Seed the store's clock before `load()`: the progress loop only runs
       * while playing, so with `autoplay: false` nothing would ever publish the
       * restored position and the UI would read 0:00 even though the engine
       * sits at the right spot.
       */
      if (options.startAt && options.startAt > 0) currentTime.value = options.startAt
      await instance.load({
        url: source.url,
        isLocal: isLocalTrack(track),
        title: track.name,
        /*
         * Hand the resume position to the engine rather than calling `seek()`
         * after `playTrackAt` returns: with `autoplay: false` the metadata may
         * not be loaded yet, `duration` is still 0, and `seek()` clamps to
         * `min(position, duration)` — the restore point silently became 0.
         * `startAt` is applied by the engine itself once metadata arrives.
         */
        startAt: options.startAt
      })
      if (isStale()) return

      loadedTrackId = track.id
      if (options.autoplay !== false) {
        await instance.play()
      }
      if (isStale()) return
      loading.value = false
      armStallTimer(generation)
      void loadLyrics(track)
    } catch (err) {
      if (isStale()) return
      // A URL that never arrived is a failed *source*, not a failed track:
      // hand it to the same failover path the engine uses so the next capable
      // 音源 gets a chance instead of stopping playback outright.
      const message = err instanceof Error ? err.message : String(err)
      if (!isLocalTrack(track) && message.includes('超时')) {
        handlePlaybackError(new Error(`${message}（${track.name}）`))
        return
      }
      error.value = message
      loading.value = false
    }
  }

  async function playTrack(track: PlayableTrack): Promise<void> {
    const index = queue.value.findIndex((item) => item.id === track.id)
    if (index >= 0) {
      await playTrackAt(index)
      return
    }
    queue.value.push(track)
    await playTrackAt(queue.value.length - 1)
  }

  /** Positions in `items`, shuffled (Fisher-Yates). */
  function shuffled<T>(items: T[]): T[] {
    const out = [...items]
    for (let index = out.length - 1; index > 0; index -= 1) {
      const swap = Math.floor(Math.random() * (index + 1))
      ;[out[index], out[swap]] = [out[swap], out[index]]
    }
    return out
  }

  /*
   * Random playback draws one shuffled pass at a time.
   *
   * Re-rolling `Math.random()` per skip repeats songs within seconds on a short
   * queue and can leave the tail of a list unheard for the whole session; a bag
   * guarantees every track plays before any can repeat. The draws are also
   * logged, because 上一首 used to share the forward roll and so jumped
   * somewhere random instead of returning the song just heard. Entries are ids
   * rather than positions — other views insert, remove and reorder rows
   * underneath this one.
   */
  const RANDOM_HISTORY_LIMIT = 200
  let randomPool: string[] = [], randomHistory: string[] = []

  function resetRandomPass(): void {
    randomPool = []
    randomHistory = []
  }

  function rememberRandomDraw(id: string): void {
    if (randomHistory[randomHistory.length - 1] === id) return
    randomHistory.push(id)
    if (randomHistory.length > RANDOM_HISTORY_LIMIT) randomHistory = randomHistory.slice(-RANDOM_HISTORY_LIMIT)
  }

  /** The next draw of the current pass, refilling from the queue when exhausted. */
  function randomNextIndex(): number {
    const tracks = queue.value
    if (tracks.length === 0) return -1
    if (tracks.length === 1) return 0
    if (randomPool.length === 0) {
      // Hold the track now playing out of a fresh pass so two passes cannot meet
      // at the same song — the one repeat a shuffled walk should never show.
      const current = currentTrack.value?.id
      randomPool = shuffled(tracks.map((track) => track.id).filter((id) => id !== current))
    }
    const positions = new Map(tracks.map((track, index) => [track.id, index]))
    while (randomPool.length > 0) {
      const id = randomPool.shift() as string
      const index = positions.get(id)
      // The row left the queue since the pass was drawn; skip rather than play a
      // neighbour that happens to have taken its position.
      if (index !== undefined) return index
    }
    return -1
  }

  /** Step back off the play log, dropping the current entry so a second 上一首
   * keeps going backwards instead of bouncing to where we just came from. */
  function randomPreviousIndex(): number {
    while (randomHistory.length > 1) {
      randomHistory.pop()
      const position = queue.value.findIndex((track) => track.id === randomHistory[randomHistory.length - 1])
      if (position >= 0) return position
    }
    return -1
  }

  async function playQueue(tracks: PlayableTrack[], startIndex = 0, label = ''): Promise<void> {
    rememberQueue(tracks)
    stop()
    queue.value = [...tracks]
    currentIndex.value = -1
    queueLabel.value = label
    resetRandomPass()
    await playTrackAt(startIndex)
  }

  /**
   * Park the queue that is about to be replaced, newest first, two deep.
   *
   * Two stored snapshots plus the live queue make the three pages the panel
   * offers. A snapshot carries **the name it was started under** (`queueLabel`),
   * not the name of the list replacing it — the page you page back to has to be
   * the list you remember, and 「专辑 · 三」 over the tracks of 二 is a lie the
   * panel would show forever.
   *
   * Replaying a list that is already one of the pages moves that page to the
   * front rather than keeping a duplicate: the live queue and the page behind it
   * holding the same list makes paging look broken.
   */
  function rememberQueue(incoming: PlayableTrack[]): void {
    const signature = (list: PlayableTrack[]): string => list.map(track => track.id).join(',')
    const outgoing = queue.value
    const next = queueHistory.value.filter(entry => signature(entry.queue) !== signature(incoming))
    if (outgoing.length > 0 && !next.some(entry => signature(entry.queue) === signature(outgoing))) {
      next.unshift({ label: queueLabel.value, queue: JSON.parse(JSON.stringify(outgoing)) as PlayableTrack[], at: Date.now() })
    }
    queueHistory.value = next.slice(0, QUEUE_HISTORY_LIMIT)
    // Written on this action alone, never on a timer: the list changes once per
    // "play this whole list", so there is no repeated megabyte-scale write to
    // throttle away. The queue is copied through JSON because a Vue proxy
    // cannot cross IPC - the same reason `writeSession` does it.
    void useLibraryStore().updateSettings({ queueHistory: queueHistory.value }).catch(() => undefined)
  }

  /**
   * Reorder the queue, keeping the playing row playing.
   *
   * `to` is the index after the source has been lifted out, which is what
   * `TrackList` emits and what the drag geometry actually says.
   *
   * The three-way `currentIndex` correction is the whole point of this function.
   * Without it, dragging an unrelated row past the playing one makes the
   * highlight - and the next 下一首 - jump to a different song.
   */
  function moveInQueue(from: number, to: number): void {
    if (from === to || to < 0 || to >= queue.value.length || from < 0 || from >= queue.value.length) return
    const list = [...queue.value]
    const [item] = list.splice(from, 1)
    if (!item) return
    list.splice(to, 0, item)
    // Replacing the array keeps reactivity predictable.
    queue.value = list
    if (currentIndex.value === from) currentIndex.value = to
    else if (from < currentIndex.value && to >= currentIndex.value) currentIndex.value -= 1
    else if (from > currentIndex.value && to <= currentIndex.value) currentIndex.value += 1
  }

  async function toggle(): Promise<void> {
    if (loading.value) {
      stop()
      return
    }
    const instance = engine.value
    if (!instance || loadedTrackId !== currentTrack.value?.id) {
      if (queue.value.length === 0) return
      await playTrackAt(Math.max(0, currentIndex.value))
      return
    }
    if (playing.value) instance.pause()
    else await instance.play().catch(() => undefined)
  }

  async function next(): Promise<void> {
    if (queue.value.length === 0) return
    const nextIndex = pickNextIndex(1)
    await playTrackAt(nextIndex)
  }

  async function previous(): Promise<void> {
    if (queue.value.length === 0) return
    // Restart the current track first, matching every mainstream player.
    if (currentTime.value > 3) {
      seek(0)
      return
    }
    await playTrackAt(pickNextIndex(-1))
  }

  /** Resolve the next index honouring the play mode and shuffle order. */
  function pickNextIndex(direction: 1 | -1): number {
    const total = queue.value.length
    if (total === 0) return -1

    if (playMode.value === 'random') {
      const drawn = direction === 1 ? randomNextIndex() : randomPreviousIndex()
      if (drawn >= 0) return drawn
    }
    return (currentIndex.value + direction + total) % total
  }

  async function handleEnded(): Promise<void> {
    if (playMode.value === 'single') {
      seek(0)
      await engine.value?.play().catch(() => undefined)
      return
    }
    if (queue.value.length === 0) return
    // Stop at the end of the list in list mode rather than wrapping silently.
    const isLast = currentIndex.value >= queue.value.length - 1
    if (playMode.value === 'list' && isLast) {
      playing.value = false
      return
    }
    await next()
  }

  function seek(time: number): void {
    if (!Number.isFinite(time)) return
    const clamped = Math.max(0, Math.min(time, duration.value || 0))
    engine.value?.seek(clamped)
    currentTime.value = clamped
  }

  function seekRatio(ratio: number): void {
    seek(Math.max(0, Math.min(1, ratio)) * duration.value)
  }

  function setVolume(value: number): void {
    if (!Number.isFinite(value)) return
    volume.value = Math.max(0, Math.min(1, value))
    engine.value?.setVolume(volume.value)
    // The toolbar renders this control as `muted ? 0 : volume`, so raising the
    // fader while muted is the user's way of asking for sound back. Without the
    // un-mute the handle springs back to zero and the control looks broken.
    if (volume.value > 0 && muted.value) setMuted(false)
  }

  function toggleMute(): void {
    setMuted(!muted.value)
  }

  function setMuted(value: boolean): void {
    muted.value = value
    engine.value?.setMuted(value)
  }

  function setPlayMode(mode: PlayMode): void {
    if (playMode.value === mode) return
    playMode.value = mode
    // Entering or leaving random starts a clean pass; carrying half a shuffle
    // over would play the leftovers before anything the user just queued up.
    resetRandomPass()
    // …but the song that is playing right now *is* where the user came from, so
    // it goes into the log. Without this the first 上一首 after switching to
    // 随机 has a one-entry history, finds nothing to step back to, and falls
    // through to the sequential neighbour — skipping the track just heard.
    if (mode === 'random' && currentTrack.value) rememberRandomDraw(currentTrack.value.id)
  }

  function setRate(value: number): void {
    if (!Number.isFinite(value)) return
    rate.value = Math.min(4, Math.max(0.25, value))
    engine.value?.setRate(rate.value)
  }

  function setQuality(value: Quality): void {
    if (quality.value === value) return
    quality.value = value
    // Cached URLs are quality-specific and may have expired; drop them.
    urlCache.clear()
  }

  /**
   * Output device handling.
   *
   * Switching the AudioContext's sink re-routes the live graph immediately, so
   * playback continues uninterrupted — no reload, no seek, no audible gap.
   * (The engine sets both the context and the element sink; the context is the
   * one that actually carries a Web Audio graph's output.)
   */
  const outputDeviceId = ref('')
  const outputDevices = ref<Array<{ deviceId: string; label: string }>>([])

  async function refreshOutputDevices(): Promise<void> {
    const instance = ensureEngine()
    outputDevices.value = await instance.listOutputDevices()
  }

  async function setOutputDevice(deviceId: string): Promise<boolean> {
    const instance = ensureEngine()
    const ok = await instance.setOutputDevice(deviceId)
    if (!ok) return false
    outputDeviceId.value = deviceId
    return true
  }

  function setEqualizer(gains: number[], preset?: string): void {
    if (preset) equalizerPreset.value = preset
    const normalized = Array.from({length: 10}, (_, index) => Number.isFinite(gains[index]) ? Math.max(-12, Math.min(12, gains[index])) : 0)
    if (normalized.every((gain, index) => gain === equalizer.value[index])) return
    equalizer.value = normalized
    engine.value?.setEqualizer(equalizer.value)
  }

  function applyEqualizerPreset(name: string): void {
    const gains = EQUALIZER_PRESETS[name]
    if (gains) setEqualizer(gains, name)
  }

  /* ------------------------------------------------------------ *
   * Queue management
   * ------------------------------------------------------------ */

  async function addToQueue(tracks: PlayableTrack[], playNow = false): Promise<void> {
    const existing = new Set(queue.value.map((track) => track.id))
    const additions = tracks.filter(track => { if (existing.has(track.id)) return false; existing.add(track.id); return true })
    if (additions.length === 0 && !playNow) return

    if (playNow && additions.length > 0) {
      queue.value = [...queue.value, ...additions]
      await playTrackAt(queue.value.length - additions.length)
      return
    }
    queue.value = [...queue.value, ...additions]
    if (playNow && tracks.length) await playTrackAt(queue.value.findIndex(track => track.id === tracks[0].id))
  }

  function removeFromQueue(trackId: string): void {
    const index = queue.value.findIndex((track) => track.id === trackId)
    if (index < 0) return
    queue.value.splice(index, 1)
    if (index < currentIndex.value) currentIndex.value -= 1
    else if (index === currentIndex.value) {
      // No queued song should appear current after the playing item is removed.
      stop()
      currentIndex.value = -1
    }
  }

  function clearQueue(): void {
    stop()
    queue.value = []
    currentIndex.value = -1
    resetRandomPass()
    // `stop()` just snapshotted the queue that is now gone, so the resume point
    // has to be dropped afterwards or the next launch restores what was cleared.
    clearSession()
    cancelSleepTimer()
  }

  function insertNext(tracks: PlayableTrack[]): void {
    const ids = new Set(tracks.map(track => track.id))
    const current = currentTrack.value
    queue.value = queue.value.filter(track => !ids.has(track.id) || track.id === current?.id)
    currentIndex.value = current ? queue.value.findIndex(track => track.id === current.id) : -1
    const seen = new Set<string>()
    const unique = tracks.filter(track => { if (track.id === current?.id || seen.has(track.id)) return false; seen.add(track.id); return true })
    queue.value.splice(currentIndex.value + 1, 0, ...unique)
  }

  const sleepAt = ref<number | null>(null)
  let sleepTimer: ReturnType<typeof setTimeout> | undefined
  function setSleepMinutes(minutes: number): void {
    cancelSleepTimer()
    sleepAt.value = minutes > 0 ? Date.now() + minutes * 60_000 : null
    if (minutes > 0) sleepTimer = setTimeout(() => { sleepTimer = undefined; stop(); sleepAt.value = null }, minutes * 60_000)
  }

  /**
   * Abandon a pending sleep timer. Without this a timer armed for a session the
   * user has already torn down goes off against whatever they start next.
   */
  function cancelSleepTimer(): void {
    if (sleepTimer !== undefined) clearTimeout(sleepTimer)
    sleepTimer = undefined
    sleepAt.value = null
  }

  /* ------------------------------------------------------------ *
   * Session resume
   * ------------------------------------------------------------ */

  /**
   * Persist where playback is, so the next launch can offer to continue.
   *
   * ## Why throttled, not written on every tick
   *
   * `currentTime` updates several times a second. Writing the settings file on
   * each update would hammer the disk and interleave with every other settings
   * write. A save every few seconds is enough for a resume point: losing the
   * last three seconds of position is not noticeable, whereas losing the track
   * entirely would be — which is why the save also fires on pause and on quit.
   *
   * `flushSession` exists for the quit path, where a pending throttle would
   * otherwise be dropped by the window closing.
   */
  let sessionTimer: number | null = null
  let sessionDirty = false
  const SESSION_INTERVAL_MS = 5_000

  function snapshotSession(): void {
    const track = currentTrack.value
    if (!track || !queue.value.length) return
    sessionDirty = true
    if (sessionTimer !== null) return
    // The global timer, not `window.setTimeout`: this store is exercised in
    // Node by the regression suites, where no `window` exists.
    sessionTimer = setTimeout(() => {
      sessionTimer = null
      writeSession()
    }, SESSION_INTERVAL_MS) as unknown as number
  }

  function writeSession(): void {
    const track = currentTrack.value
    if (!track) return
    sessionDirty = false
    const library = useLibraryStore()
    // Proxies cannot cross IPC; the queue is copied through JSON for the same
    // reason `recordPlayed` does it.
    void library.updateSettings({
      lastSession: JSON.parse(JSON.stringify({
        track: toIpcPayload(track),
        position: currentTime.value,
        queue: queue.value.length ? queue.value : [track],
        index: currentIndex.value >= 0 ? currentIndex.value : 0,
        at: Date.now()
      }))
    }).catch(() => undefined)
  }

  /** Write immediately when a save is pending (called as the app closes). */
  function flushSession(): void {
    if (sessionTimer !== null) {
      clearTimeout(sessionTimer)
      sessionTimer = null
    }
    if (sessionDirty || currentTrack.value) writeSession()
  }

  /** Forget the resume point, so the next launch does not reopen a closed book. */
  function clearSession(): void {
    if (sessionTimer !== null) {
      clearTimeout(sessionTimer)
      sessionTimer = null
    }
    sessionDirty = false
    const library = useLibraryStore()
    // `null` rather than an absent key: the writer snapshots every patch through
    // JSON, which drops undefined, so `{ lastSession: undefined }` would merge
    // into the same batch as the snapshot `stop()` just wrote and lose to it.
    void library.updateSettings({ lastSession: null }).catch(() => undefined)
  }

  /**
   * Restore the previous session's track, queue and position.
   *
   * Deliberately does **not** start playing: an app that begins making noise on
   * launch is hostile, and the user may have opened it for something else. The
   * track is loaded, seeked and left paused, so pressing play continues exactly
   * where they stopped.
   *
   * Returns false when there is nothing usable to resume, so the caller can
   * stay quiet instead of announcing a resume that did not happen.
   */
  async function restoreSession(session: LastSession | null | undefined): Promise<boolean> {
    if (!session?.track) return false
    if (!Array.isArray(session.queue) || session.queue.length === 0) return false

    const list = session.queue as PlayableTrack[]
    const index = Math.min(Math.max(0, session.index ?? 0), list.length - 1)
    queue.value = list
    currentIndex.value = index

    try {
      // `autoplay: false` loads without producing sound; `startAt` positions
      // the track once metadata is available (see the comment inside
      // `playTrackAt` for why this must not be a post-return `seek()`).
      await playTrackAt(index, { autoplay: false, startAt: session.position })
      return true
    } catch (error) {
      // A local file may have been moved or a source may be disabled; a failed
      // resume is not worth interrupting the user, but the reason should be
      // findable when diagnosing.
      console.warn('[player] 恢复上次播放失败:', error instanceof Error ? error.message : error)
      return false
    }
  }

  /**
   * Take back the recent queues after a restart, so the panel's history pages
   * survive closing the app.
   *
   * Validated rather than trusted: this arrives from a settings file, and a
   * half-written entry would otherwise appear as a page that is empty and
   * cannot be played.
   */
  function restoreQueueHistory(list: unknown): void {
    if (!Array.isArray(list)) {
      queueHistory.value = []
      return
    }
    queueHistory.value = list
      .filter((entry): entry is QueueSnapshot => !!entry && typeof entry === 'object' && Array.isArray(entry.queue) && entry.queue.length > 0)
      .slice(0, QUEUE_HISTORY_LIMIT)
      .map(entry => ({
        label: typeof entry.label === 'string' ? entry.label : '',
        queue: entry.queue,
        at: Number.isFinite(entry.at) ? entry.at : 0
      }))
  }

  function stop(): void {
    // Capture the position before clearing state, or the resume point would
    // always be at zero.
    flushSession()
    playGeneration += 1
    lyricGeneration += 1
    lyricAbort?.abort()
    clearStallTimer()
    loadedTrackId = null
    engine.value?.stop()
    playing.value = false
    currentTime.value = 0
    duration.value = 0
    loading.value = false
    waiting.value = false
    lyricLoading.value = false
    lyrics.value = null
    lyricSource.value = 'none'
    lyricError.value = null
  }

  /* ------------------------------------------------------------ *
   * Lyrics
   * ------------------------------------------------------------ */

  /**
   * Convert a track to a plain object before sending it over IPC.
   *
   * Tracks stored in `queue` are wrapped in Vue's reactive `Proxy`, and
   * Electron serialises IPC payloads with the structured clone algorithm, which
   * refuses Proxies. The renderer sees only a bare
   * "An object could not be cloned." with no field named, which makes this easy
   * to misdiagnose: the same call succeeds when tested with a raw object and
   * fails only once the track has been through the store.
   *
   * `toRaw` unwraps the outer proxy; a JSON round-trip then guarantees every
   * nested value is a plain cloneable type. Track objects are tiny, so the cost
   * is negligible beside the IPC round-trip itself.
   */
  function toIpcPayload<T>(value: T): T {
    return JSON.parse(JSON.stringify(toRaw(value))) as T
  }

  /**
   * Resolve and parse the lyric for a track.
   *
   * The priority order (sidecar `.lrc` → embedded tag → online match) lives in
   * the main process so it can be unit-tested without a browser. Here we just
   * ask for the result and parse it.
   *
   * This matters more than it looks: a survey of the library on this machine
   * found 1111 of 1112 files carry embedded lyrics, and 1092 of those are
   * line-synchronised. An earlier version only looked for a sidecar `.lrc` and
   * therefore showed nothing for essentially the entire library.
   */
  async function loadLyrics(track: PlayableTrack): Promise<void> {
    // A request for a track that is no longer current is obsolete. Clear the
    // stale lyrics explicitly: bailing out silently here used to leave the
    // *previous* track's lyrics on screen, since nothing else resets them on
    // this path.
    if (currentTrack.value?.id !== track.id) {
      lyrics.value = null
      lyricSource.value = 'none'
      lyricError.value = null
      lyricLoading.value = false
      return
    }
    const isCurrent = beginLyricRequest(track)
    const signal = lyricAbort!.signal
    lyricLoading.value = true
    lyricError.value = null
    try {
      let result: ResolvedLyric

      if (isLocalTrack(track)) {
        result = await window.jj.lyric.resolve(track.id, true)
        // Same guard the online branch has: two rapid track changes can interleave
        // here, and the provenance of the song the user has already left must not
        // land on the one now playing.
        if (!isCurrent()) return
        lyricAsset.value = result.asset ?? null
      } else {
        // A hand-picked source belongs to the track it was picked for.
        if (lyricSourceChoiceTrack !== track.id) {
          lyricSourceChoiceTrack = null
          lyricSourceChoice.value = null
        }
        // Online tracks: one call resolves lyrics *and* cover art together.
        //
        // The user's 音源 only implements `musicUrl` in practice, so lyrics come
        // from the host's built-in platform adapters. This matters because a
        // track found by search rarely carries either field.
        const onlineTrack = { ...toIpcPayload(track) } as OnlineMusicInfo
        const enriched = await cancellableMusic(signal, id => window.jj.music.enrich(onlineTrack, lyricSourceChoice.value ?? undefined, id))
        if (!isCurrent()) return

        lyricAsset.value = enriched.asset ?? null
        result = {
          lyric: enriched.lyric ?? '',
          ...(enriched.tlyric ? { tlyric: enriched.tlyric } : {}),
          ...(enriched.rlyric ? { rlyric: enriched.rlyric } : {}),
          ...(enriched.lxlyric ? { lxlyric: enriched.lxlyric } : {}),
          source: enriched.lyric ? 'online' : 'none',
          asset: enriched.asset ?? undefined,
          synchronized: false
        }

        // Fill in cover art when search did not provide one, so the now-playing
        // view does not show a placeholder for a track that has artwork.
        if (enriched.picUrl && !onlineTrack.picUrl) {
          onlineTrack.picUrl = enriched.picUrl
          const index = queue.value.findIndex((item) => item.id === onlineTrack.id)
          if (index >= 0) {
            // Mutate in place so any bound view updates without a re-sort.
            const queued = queue.value[index]
            if ('picUrl' in queued) queued.picUrl = enriched.picUrl
          }
        }

        // Provenance rides along with the art: an online row that had nothing of
        // its own now knows where the cover and the words it is showing came from,
        // so 音轨信息 can answer the same question for it as for a local file.
        if (enriched.cover || enriched.asset) {
          onlineTrack.assets = {
            ...onlineTrack.assets,
            ...(enriched.cover ? { cover: [enriched.cover] } : {}),
            ...(enriched.asset ? { lyrics: { ...onlineTrack.assets?.lyrics, main: [enriched.asset] } } : {})
          }
          // `onlineTrack` is a clone made for this call, so the row in the queue
          // has to be written too — and it has to be written *because* it may not
          // carry an `assets` key yet: a plain search result is exactly the case
          // this exists for, so gating on `'assets' in queued` skipped it.
          const queued = queue.value.find((item) => item.id === onlineTrack.id)
          if (queued) queued.assets = onlineTrack.assets
        }
      }

      if (!isCurrent()) return
      lyricSource.value = result.source

      if (!result.lyric.trim()) {
        lyrics.value = null
        lyricError.value = result.note ?? '没有找到歌词'
        return
      }

      const parsed = parseLyrics(result.lyric, result.tlyric, result.lxlyric, result.rlyric)
      if (parsed.lines.length === 0) {
        // Text exists but has no timestamps: still show it, as plain lines.
        const fallback = parseLyrics(
          result.lyric
            .split(/\r?\n/)
            .filter(Boolean)
            .map((line: string) => `[00:00.000]${line}`)
            .join('\n')
        )
        lyrics.value = fallback
      } else {
        lyrics.value = parsed
      }
    } catch (error) {
      if (!isCurrent()) return
      lyrics.value = null
      lyricError.value = error instanceof Error ? error.message : String(error)
    } finally {
      // Always release the spinner when this request is still the active one.
      // When it has been superseded the newer request owns the flag and clears
      // it itself; clearing it here would also be harmless, but leaving it set
      // on a superseded request is what strands the UI mid-load.
      if (isCurrent()) lyricLoading.value = false
    }
  }

  /** Attach a `.lrc` file to the current local track. */
  async function importLyric(): Promise<boolean> {
    const track = currentTrack.value
    if (!track || !isLocalTrack(track)) return false
    const playback = playGeneration
    const picked = await window.jj.lyric.importFile(track.id)
    if (!picked) return false
    if (playback === playGeneration) await loadLyrics(track)
    return true
  }

  /**
   * Re-read the current track's lyric.
   *
   * Used after the lyric was changed on disk (a picked candidate, an edited
   * sidecar): the store's copy is stale, and re-resolving goes through the main
   * process's cache, which the writer has already invalidated.
   */
  async function reloadLyric(): Promise<void> {
    const track = currentTrack.value
    if (!track) return
    await loadLyrics(track)
  }

  /**
   * Force one lyric source for the current online track, or `null` to hand the
   * choice back to the setting.
   *
   * Only the named source is asked — a user who just watched 音源脚本 return the
   * wrong words does not want the fallback chain to quietly produce them again.
   */
  async function useLyricSource(source: OnlineLyricSource | null): Promise<void> {
    const track = currentTrack.value
    if (!track || isLocalTrack(track)) return
    lyricSourceChoice.value = source
    lyricSourceChoiceTrack = source ? track.id : null
    await loadLyrics(track)
  }

  /** Search lyrics online for the current local track, bypassing the cache. */
  async function searchLyricOnline(): Promise<boolean> {
    const track = currentTrack.value
    if (!track || !isLocalTrack(track)) return false
    const isCurrent = beginLyricRequest(track)
    lyricLoading.value = true
    lyricError.value = null
    try {
      const result = await window.jj.lyric.searchOnline(track.id)
      if (!isCurrent()) return false
      if (!result.lyric.trim()) {
        lyricError.value = result.note ?? '在线未匹配到歌词'
        return false
      }
      lyricSource.value = result.source
      lyrics.value = parseLyrics(result.lyric, result.tlyric, result.lxlyric, result.rlyric)
      return true
    } catch (error) {
      if (!isCurrent()) return false
      lyricError.value = error instanceof Error ? error.message : String(error)
      return false
    } finally {
      if (isCurrent()) lyricLoading.value = false
    }
  }

  function getSpectrum(): Uint8Array | null {
    return engine.value?.getSpectrum() ?? null
  }

  return {
    // state
    queue,
    queueHistory,
    currentIndex,
    playing,
    loading,
    waiting,
    currentTime,
    duration,
    volume,
    muted,
    playMode,
    rate,
    error,
    lyrics,
    lyricLoading,
    lyricSource,
    lyricError,
    lyricAsset,
    lyricSourceChoice,
    quality,
    resolvedQuality,
    equalizer,
    equalizerPreset,
    outputDeviceId,
    outputDevices,
    // getters
    currentTrack,
    activeLyricIndex,
    progress,
    hasNext,
    hasPrevious,
    // actions
    playTrack,
    playTrackAt,
    playQueue,
    toggle,
    next,
    previous,
    seek,
    seekRatio,
    setVolume,
    toggleMute,
    setPlayMode,
    setRate,
    setQuality,
    setEqualizer,
    reloadLyric,
    useLyricSource,
    flushSession,
    restoreSession,
    refreshOutputDevices,
    setOutputDevice,
    applyEqualizerPreset,
    addToQueue,
    removeFromQueue,
    clearQueue,
    insertNext,
    moveInQueue,
    restoreQueueHistory,
    sleepAt,
    setSleepMinutes,
    stop,
    loadLyrics,
    importLyric,
    searchLyricOnline,
    getSpectrum
  }
})
