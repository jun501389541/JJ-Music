/**
 * Windows' system media controls (SMTC): the transport buttons on the lock
 * screen, in the volume flyout and on the taskbar.
 *
 * ## Why this is only the Media Session API
 *
 * Measured on this machine before the code below was written: a playing
 * `<audio>` element in this Electron window was *already* listed by
 * `GlobalSystemMediaTransportControlsSessionManager` — with no metadata — and
 * setting `navigator.mediaSession.metadata` replaced its title and artist. The
 * audio graph starts at a media element (`createMediaElementSource`), which is
 * what makes that possible; a player that decoded through
 * `AudioBufferSourceNode` would have needed a helper process to register the
 * session by hand.
 *
 * ## Why the position is pushed sparsely
 *
 * `setPositionState` is how the system learns the track length and where the
 * scrubber is. Chromium *extrapolates* between calls, so the position only has
 * to be corrected when the estimate stops matching reality — a seek, a pause, a
 * new track, or a slow drift. Calling it on every 200 ms progress tick would
 * cross the process boundary five times a second to redraw a bar that is
 * already moving.
 */
import { onScopeDispose, watch } from 'vue'
import { toMediaUrl } from '@shared/media-url'
import { isLocalTrack, type PlayableTrack } from '@shared/types'
import type { usePlayerStore } from '../stores/player'

type Player = ReturnType<typeof usePlayerStore>

/** A position the system can no longer reconstruct from the value we last sent. */
const DRIFT_TOLERANCE_SECONDS = 1.5

/** How often to correct the estimate while nothing else changes. */
const RECONCILE_MS = 5000

/** The side Windows is shown: the flyout art is ~44 px, the lock screen ~240 px. */
const ARTWORK_SIDE = 320

/**
 * Re-encode an image address into same-origin bytes.
 *
 * Two things rule out the obvious routes here. `fetch()` is closed to
 * `jjmedia:` by the page's CSP (`connect-src`), and it is worth keeping closed:
 * that scheme serves files off disk, and a read channel for it would be a wider
 * surface than a lyric strip ever needs. The system's media layer cannot fetch
 * a custom scheme at all, which is what a measured `封面引用=False` said the
 * raw address was worth to it.
 *
 * An `<img>` is allowed by `img-src`, and the scheme answers with permissive
 * CORS headers, so drawing it to a canvas and taking the blob back is both
 * legal and same-origin. A CDN cover without CORS taints the canvas and this
 * throws — which is why the caller keeps the address as the fallback there.
 */
async function toArtworkUrl(source: string): Promise<string | undefined> {
  const image = await new Promise<HTMLImageElement>((resolve, reject) => {
    const element = new Image()
    element.crossOrigin = 'anonymous'
    element.onload = () => resolve(element)
    element.onerror = () => reject(new Error('cover load failed'))
    element.src = source
  })
  const scale = Math.min(1, ARTWORK_SIDE / Math.max(image.naturalWidth, image.naturalHeight, 1))
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.round(image.naturalWidth * scale))
  canvas.height = Math.max(1, Math.round(image.naturalHeight * scale))
  const context = canvas.getContext('2d')
  if (!context) return undefined
  context.drawImage(image, 0, 0, canvas.width, canvas.height)
  const blob = await new Promise<Blob | null>(done => canvas.toBlob(done, 'image/jpeg', 0.82))
  return blob ? URL.createObjectURL(blob) : undefined
}

/**
 * The cover, in a form the system can use; undefined for no cover.
 *
 * Local art has to become bytes here. A CDN address is passed through when the
 * canvas is tainted, because the media layer fetches http(s) itself and is not
 * held to this page's CORS.
 */
async function artworkFor(track: PlayableTrack): Promise<string | undefined> {
  const source = isLocalTrack(track)
    ? track.coverPath
      ? toMediaUrl(track.coverPath)
      : undefined
    : track.picUrl || undefined
  if (!source) return undefined
  try {
    return await toArtworkUrl(source)
  } catch {
    return source.startsWith('jjmedia:') ? undefined : source
  }
}

/**
 * Publish the player as a system media session.
 *
 * Called once from the app root, next to the desktop-lyric watcher: both project
 * the same player state into a place the player store does not own.
 */
export function startMediaSession(player: Player): void {
  if (!('mediaSession' in navigator)) return

  let generation = 0
  /** Where the system thinks the playhead is, and when we told it. */
  let reported = { position: 0, at: 0 }
  let objectUrl: string | undefined

  /** Revokes the previous cover: each track change would otherwise leak a blob. */
  function setArtwork(url: string | undefined): void {
    if (objectUrl && objectUrl !== url) URL.revokeObjectURL(objectUrl)
    objectUrl = url
  }

  function pushPosition(): void {
    const duration = player.duration
    if (!Number.isFinite(duration) || duration <= 0) return
    reported = { position: player.currentTime, at: Date.now() }
    try {
      navigator.mediaSession.setPositionState({
        duration,
        position: Math.min(reported.position, duration),
        playbackRate: player.rate || 1
      })
    } catch {
      /* A live stream with no known length simply gets no scrubber. */
    }
  }

  /** Only correct the system when its own extrapolation has gone stale. */
  function reconcile(): void {
    const predicted = reported.position + ((Date.now() - reported.at) / 1000) * (player.rate || 1)
    if (Math.abs(predicted - player.currentTime) < DRIFT_TOLERANCE_SECONDS) return
    pushPosition()
  }

  async function publish(track: PlayableTrack): Promise<void> {
    const current = ++generation
    const artwork = await artworkFor(track)
    // A cover that lands after the user skipped ahead must not describe the
    // track that is no longer playing.
    if (current !== generation) {
      if (artwork?.startsWith('blob:')) URL.revokeObjectURL(artwork)
      return
    }
    setArtwork(artwork)
    navigator.mediaSession.metadata = new MediaMetadata({
      title: track.name || '未知曲目',
      artist: track.singer || '未知歌手',
      album: 'albumName' in track ? track.albumName ?? '' : '',
      artwork: artwork ? [{ src: artwork }] : []
    })
    pushPosition()
  }

  /*
   * The system's buttons drive the same actions as the toolbar. The names are
   * the Media Session spec's, not the store's: `setActionHandler('next', …)`
   * throws, and a measured `可下一首=False` is what gave it away.
   *
   * There is deliberately no `seekto`. Measured through the system API on this
   * machine: asking Windows to move the playhead to 75 s and to 150 s both reach
   * the page as `seekTime: 0`, so handling that action turns the flyout's
   * scrubber into a restart button. Leaving it unhandled does not hide the
   * scrubber — `可拖动` follows the media element's own seekability, and stayed
   * True with no handler registered — but at least nothing on our side acts on a
   * number that was never delivered.
   */
  const handlers: Array<[string, (details: { seekOffset?: number }) => void]> = [
    ['play', () => { if (!player.playing) void player.toggle() }],
    ['pause', () => { if (player.playing) void player.toggle() }],
    ['nexttrack', () => void player.next()],
    ['previoustrack', () => void player.previous()],
    ['stop', () => player.stop()],
    ['seekbackward', details => {
      player.seek(player.currentTime - (details.seekOffset ?? 10))
      pushPosition()
    }],
    ['seekforward', details => {
      player.seek(player.currentTime + (details.seekOffset ?? 10))
      pushPosition()
    }]
  ]
  for (const [action, handler] of handlers) {
    try {
      navigator.mediaSession.setActionHandler(action as MediaSessionAction, handler as MediaSessionActionHandler)
    } catch {
      /* An unknown action stays out of the flyout. */
    }
  }

  let timer: ReturnType<typeof setInterval> | undefined

  watch(
    () => player.currentTrack,
    track => {
      if (!track) {
        generation += 1
        setArtwork(undefined)
        navigator.mediaSession.metadata = null
        return
      }
      void publish(track)
    },
    { immediate: true }
  )

  watch(() => player.playing, playing => {
    navigator.mediaSession.playbackState = playing ? 'playing' : 'paused'
    // Pausing stops the extrapolation, so the value at that moment is the one
    // the system will keep showing.
    if (!playing) pushPosition()
  }, { immediate: true })

  // A track whose length only becomes known once it has loaded.
  watch(() => player.duration, seconds => {
    if (seconds > 0) pushPosition()
  })

  watch(() => player.currentTime, reconcile)

  /** Re-read the clock even when no progress event arrives, e.g. after a stall. */
  timer = setInterval(() => {
    if (player.playing) reconcile()
  }, RECONCILE_MS)

  onScopeDispose(() => {
    if (timer !== undefined) clearInterval(timer)
    setArtwork(undefined)
    for (const [action] of handlers) {
      try {
        navigator.mediaSession.setActionHandler(action as MediaSessionAction, null)
      } catch {
        /* nothing to unhook */
      }
    }
  })
}
