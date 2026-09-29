/**
 * Lyric resolution service.
 *
 * Owns the priority order and the caching, so neither the IPC layer nor the UI
 * has to know where a lyric came from. The order is deliberate:
 *
 *   1. **Sidecar `.lrc`** — an explicit file the user placed next to the audio.
 *      If they bothered to put it there, it wins over anything else.
 *   2. **Embedded tag** — ID3 SYLT/USLT, Vorbis `LYRICS`, MP4 `©lyr`. A survey
 *      of the library on this machine found 1111 of 1112 files carry these, so
 *      in practice this is the common path.
 *   3. **Online lookup** — matched by the track's own tags. Only reached when
 *      the first two produce nothing.
 *
 * Manual edits are stored as a sidecar, which then wins by rule 1. That gives
 * the user a way to override any source without a separate "pinned" concept.
 */
import { readFile, stat } from 'node:fs/promises'
import { basename, extname } from 'node:path'
import type { AssetRef, LyricResult, LocalMusicInfo, OnlineLyricSource, OnlineMusicInfo, SourceId } from '@shared/types'
import { ONLINE_LYRIC_SOURCES, ONLINE_SOURCE_IDS } from '@shared/types'
import type { ResolvedLyric, LyricCandidate } from '@shared/library-types'
import { readEmbeddedLyric } from '../library/embedded-lyrics'
import { sidecarPathFor } from './asset-files'
import { fetchOnlineLyric } from '../online/lyrics'
import { matchMetadata } from '../library/metadata-match'
import { stripBom, writeFileAtomic } from '../store/json-file'

export type { ResolvedLyric }

/**
 * Order in which the "match a lyric on another platform" fallback asks.
 *
 * A priority, not the set of platforms: anything in `ONLINE_SOURCE_IDS` that is
 * missing here is still tried, just last.
 */
const LYRIC_FALLBACK_PRIORITY: readonly string[] = ['tx', 'wy', 'kw', 'kg', 'mg']

/* ------------------------------------------------------------------ *
 * Online lyric sources
 * ------------------------------------------------------------------ */

/**
 * Which sources to ask, in what order.
 *
 * The preferred one first; with fallback enabled the rest follow in their
 * declared order. `only` is the per-track switch — when the user says "这次就用
 * 平台接口", nothing else gets asked, because the point of switching is that the
 * first answer was wrong rather than missing.
 */
export function lyricSourceOrder(
  preferred: OnlineLyricSource,
  fallback: boolean,
  only?: OnlineLyricSource
): OnlineLyricSource[] {
  if (only) return [only]
  if (!fallback) return [preferred]
  return [preferred, ...ONLINE_LYRIC_SOURCES.filter((source) => source !== preferred)]
}

/**
 * Ask each source in turn until one produces text.
 *
 * A source that throws counts as "no lyrics" and the next one is still asked:
 * one provider being down must not be the reason a song shows nothing.
 *
 * The answer is reported as an `AssetRef` — the same record the library uses for
 * what is merely available — so "who gave me these words" has one vocabulary
 * rather than a parallel `via` field that means nearly the same thing.
 */
export async function resolveOnlineLyricByOrder(
  order: OnlineLyricSource[],
  steps: Record<OnlineLyricSource, () => Promise<LyricResult>>,
  signal?: AbortSignal
): Promise<{ lyric: LyricResult; asset: AssetRef | null }> {
  for (const source of order) {
    if (signal?.aborted) break
    try {
      const result = await steps[source]()
      if (signal?.aborted) break
      if (result?.lyric?.trim()) return { lyric: result, asset: { origin: 'remote', provider: source, at: Date.now() } }
    } catch {
      /* try the next one */
    }
  }
  return { lyric: { lyric: '' }, asset: null }
}

/** Other platforms' adapters are worth trying only when they answer at all. */
const MIN_OTHER_PLATFORM_SCORE = 0.6

/**
 * Lyrics from a platform other than the track's own.
 *
 * Same-name-different-recording is the risk here, so the match has to clear the
 * same kind of confidence bar the tag-matching UI uses, and platforms are tried
 * in a fixed order so the result is reproducible rather than a race.
 */
export async function lyricFromOtherPlatforms(
  music: OnlineMusicInfo,
  deps: {
    match?: typeof matchMetadata
    fetchLyric?: typeof fetchOnlineLyric
  } = {},
  signal?: AbortSignal
): Promise<LyricResult> {
  const match = deps.match ?? matchMetadata
  const fetchLyric = deps.fetchLyric ?? fetchOnlineLyric
  const seconds = /^(\d+):(\d{1,2})$/.exec(music.interval ?? '')
  const duration = seconds ? Number(seconds[1]) * 60 + Number(seconds[2]) : 0
  const query = {
    id: music.id,
    path: '',
    name: music.name,
    singer: music.singer,
    albumName: music.albumName ?? '',
    duration
  } as LocalMusicInfo
  // Which platform to ask first is a deliberate order (QQ's lyric library is the
  // largest, so it wins most ties), but the list of platforms to ask at all is
  // `ONLINE_SOURCE_IDS`' job — a platform added to the search adapters must not
  // be skipped here just because nobody remembered to edit a second table.
  const ranked = [...LYRIC_FALLBACK_PRIORITY, ...ONLINE_SOURCE_IDS.filter((source) => !LYRIC_FALLBACK_PRIORITY.includes(source))]
  const others = ranked.filter((source) => source !== music.source)

  let matches
  try {
    matches = await match(query, { sources: others, limit: 6, signal })
  } catch {
    return { lyric: '' }
  }
  for (const candidate of matches) {
    if (signal?.aborted) break
    if (candidate.score < MIN_OTHER_PLATFORM_SCORE) continue
    const result = await fetchLyric(candidate.music, signal)
    if (result.lyric.trim()) return result
  }
  return { lyric: '' }
}

/** LRU-ish cache keyed by source version + track id, so re-opening a track is instant. */
const cache = new Map<string, ResolvedLyric>()
const CACHE_LIMIT = 64

function cacheSet(key: string, value: ResolvedLyric): void {
  if (cache.size >= CACHE_LIMIT) {
    const oldest = cache.keys().next().value
    if (oldest !== undefined) cache.delete(oldest)
  }
  cache.set(key, value)
}

/**
 * Cache identity for one resolution of a track's lyrics.
 *
 * `provider` is the source version that produced the answer, and it is part of
 * the key because the answer *is* the source's opinion about this track. A
 * script that parsed lyrics wrongly and then shipped a fix would otherwise keep
 * serving its old output from a cache whose key never changed — the cache would
 * be more durable than the bug.
 *
 * `provider` is optional so the offline suites, which never inject one, keep
 * their existing single-bucket behaviour. When it is absent the key is exactly
 * `track.id`, the same string the pre-isolation cache used.
 */
function cacheKeyFor(trackId: string, provider?: string): string {
  return provider ? `${provider}\u0000${trackId}` : trackId
}

/**
 * Drop every cached entry recorded under one source version.
 *
 * Called when a source the user just updated (or removed) had produced cached
 * answers. Waiting for the 64-entry LRU to evict them would leave the old
 * script's output winning for as long as that took.
 */
export function clearLyricCacheFor(provider: string): void {
  const prefix = `${provider}\u0000`
  for (const key of cache.keys()) {
    if (key.startsWith(prefix)) cache.delete(key)
  }
}

export function clearLyricCache(trackId?: string): void {
  if (!trackId) {
    cache.clear()
    return
  }
  // Without a provider, the isolated entries for this track cannot be named —
  // so drop them by identity rather than pretending a bare-id delete covered
  // them. A caller that knows the provider should use `clearLyricCacheFor`.
  const suffix = `\u0000${trackId}`
  for (const key of cache.keys()) {
    if (key === trackId || key.endsWith(suffix)) cache.delete(key)
  }
}

/**
 * Put a resolved lyric into the cache under this track.
 *
 * The caller uses it when it learns something the resolver could not know — that
 * the online lyric it just handed over is now also sitting in the 待写入 queue.
 * Without this, the second read of the same track comes from the cache and
 * reports the lyric as if nothing were pending, so the badge would blink the
 * truth once and then lie.
 *
 * `provider` must be the same source version the caller passed to
 * `resolveLocalLyric`, or the decorated record lands in a different bucket than
 * the one the next read looks in — which would bring back exactly the
 * once-true-then-lying badge this function exists to prevent.
 */
export function primeLyricCache(trackId: string, resolved: ResolvedLyric, provider?: string): void {
  cacheSet(cacheKeyFor(trackId, provider), resolved)
}

/**
 * True when the text contains at least one LRC timestamp.
 *
 * Exported because the picker's stage-then-write path rebuilds a resolved lyric
 * from a candidate the renderer chose; the badge and the 逐行 marker must read
 * the same predicate the resolver used, not a second one that happens to differ.
 */
export function looksSynchronized(text: string): boolean {
  return /\[\d{1,3}:\d{1,2}(?:[.:]\d{1,3})?\]/.test(text)
}

/**
 * Sidecars are small hand-maintained text files. `readFile` has no limit of its
 * own, so bound the read: whatever else is guarding this path, a lyric file that
 * claims to be hundreds of megabytes is not a lyric file.
 */
const SIDECAR_MAX_BYTES = 4 * 1024 * 1024

/** Read a sidecar `.lrc`, tolerating the encodings these files actually use. */
async function readSidecar(path: string): Promise<string | null> {
  try {
    const { size } = await stat(path)
    if (size === 0 || size > SIDECAR_MAX_BYTES) return null
    const buffer = await readFile(path)
    const utf8 = buffer.toString('utf8')
    if (!utf8.includes('\uFFFD')) return stripBom(utf8)
    // Chinese lyric files are frequently GBK.
    const { default: iconv } = await import('iconv-lite')
    return stripBom(iconv.decode(buffer, 'gbk'))
  } catch {
    return null
  }
}

/** Sidecar naming lives with the cover sidecars, so the writer and the scanner cannot drift. */
export { sidecarPathFor }

/**
 * Resolve lyrics for a local track.
 *
 * Never throws: a track with no lyrics anywhere is a normal result, reported as
 * an empty lyric plus an explanatory note.
 *
 * The order is the index's own `assets.lyrics.main` list — the resolution chain as
 * data rather than a ladder of `if`s — with each candidate actually read before it
 * is accepted. See the chain construction below for the one case where the record
 * is deliberately not believed.
 *
 * `track` must be a record this process produced — an index entry, not an object
 * assembled from IPC. Step 1 reads a sidecar path derived from `track.path`, and
 * the scanner is the only writer of that path; hand a renderer-built object to
 * this function and that becomes an arbitrary file read. The IPC layer enforces
 * this through `indexedTrack()`.
 */
export async function resolveLocalLyric(
  track: LocalMusicInfo,
  options: { allowOnline?: boolean; force?: boolean } = {},
  deps: {
    search?: SearchOnlineForMatch
    fetchLyric?: typeof fetchOnlineLyric
    /**
     * The version of the source that will answer, for cache isolation.
     *
     * See `cacheKeyFor`. Absent means the caller has no source version to
     * offer — the offline suites do exactly that, and get the single-bucket
     * cache the app had before isolation.
     */
    provider?: string
  } = {}
): Promise<ResolvedLyric> {
  const allowOnline = options.allowOnline !== false
  const key = cacheKeyFor(track.id, deps.provider)
  if (!options.force) {
    const cached = cache.get(key)
    if (cached) return cached
  }

  // The chain is the recorded sources plus one always-probed exception.
  //
  // A sidecar is a *separate* file: dropping one next to the audio changes neither
  // the audio's size nor its mtime, so an incremental scan can never notice it and
  // the record cannot be trusted to mention it. An embedded tag is the opposite —
  // writing one rewrites the audio file, which the scan does see — so when the
  // record says there is no lyric tag we can skip a full `parseFile` of the track.
  // A track indexed before records existed probes both, as before.
  const recorded = track.assets?.lyrics?.main
  const chain: AssetRef[] = [{ origin: 'sidecar' },
    ...(recorded ?? [{ origin: 'embedded' } as AssetRef]).filter((source) => source.origin !== 'sidecar')]

  for (const source of chain) {
    // 1. a sidecar `.lrc` next to the audio (an explicit user choice, or a previous edit)
    if (source.origin === 'sidecar') {
      const sidecar = await readSidecar(sidecarPathFor(track.path))
      if (sidecar?.trim()) {
        const resolved: ResolvedLyric = { lyric: sidecar, source: 'sidecar', synchronized: looksSynchronized(sidecar), asset: source }
        cacheSet(key, resolved)
        return resolved
      }
      continue
    }

    // 2. the file's own lyric tag
    if (source.origin === 'embedded') {
      const embedded = await readEmbeddedLyric(track.path)
      if (embedded?.lyric.trim()) {
        const resolved: ResolvedLyric = {
          lyric: embedded.lyric,
          source: 'embedded',
          synchronized: embedded.synchronized,
          asset: { ...source, synced: embedded.synchronized }
        }
        cacheSet(key, resolved)
        return resolved
      }
    }
    // Anything else recorded (a cached or user-supplied lyric) has no on-disk
    // reader yet, so it falls through to the network rather than being trusted.
  }

  // 3. online, matched by the track's own tags
  if (allowOnline) {
    const online = await searchLyricOnline(track, deps)
    if (online.lyric.trim()) {
      cacheSet(key, online)
      return online
    }
  }

  const empty: ResolvedLyric = {
    lyric: '',
    source: 'none',
    synchronized: false,
    note: allowOnline
      ? '文件内没有内嵌歌词，同目录没有 .lrc，在线也没有匹配到歌词'
      : '文件内没有内嵌歌词，同目录没有 .lrc'
  }
  // Deliberately not cached: availability may change once a network hiccup
  // clears, and a negative result is cheap to recompute.
  return empty
}

/**
 * Search for lyrics online using the track's tags.
 *
 * The tags are often exactly what is wrong with an untagged file, so this also
 * falls back to the filename stem — for a file named `Artist - Title.flac`
 * that recovers a usable query even with no tags at all.
 */
export async function searchLyricOnline(
  track: Pick<LocalMusicInfo, 'id' | 'path' | 'name' | 'singer' | 'albumName' | 'duration'>,
  deps: {
    search?: SearchOnlineForMatch
    fetchLyric?: typeof fetchOnlineLyric
    /**
     * The version of the source that will answer, for cache isolation.
     *
     * This entry point reads no cache itself, but the fetch it performs goes on
     * to be staged under this key by the caller (`primeLyricCache`), so the key
     * has to be decided in one place and carried — see `primeLyricCache` for
     * what happens when the two disagree.
     */
    provider?: string
  } = {}
): Promise<ResolvedLyric> {
  const candidates = await lyricCandidates(track, deps)
  const best = candidates.find((entry) => entry.lyric.trim())
  if (!best) return { lyric: '', source: 'none', synchronized: false, note: '在线未匹配到歌词' }

  return {
    lyric: best.lyric,
    ...(best.tlyric ? { tlyric: best.tlyric } : {}),
    ...(best.rlyric ? { rlyric: best.rlyric } : {}),
    /*
     * Recorded with the version key alongside the lyric, so the caller staging
     * this into the cache does not have to be told a second time which version
     * answered — a second telling is a second chance to disagree. `primeLyricCache`
     * prefers this over anything passed separately.
     */
    ...(deps.provider ? { provider: deps.provider } : {}),
    source: 'online',
    synchronized: looksSynchronized(best.lyric),
    matchedMusic: best.music,
    matchScore: best.score,
    // This path is cross-platform matching by name, whatever the winner's own
    // platform turns out to be — the record says which slot, `matchedMusic` the row.
    asset: { origin: 'remote', provider: 'search', at: Date.now() }
  }
}

/** One alternative offered to the user when picking a lyric by hand. */
export type { LyricCandidate }

/**
 * Every credible lyric match for a track, best first.
 *
 * ## Why gather alternatives instead of taking the first hit
 *
 * A metadata match is a guess. When several platforms spell a title differently
 * — a remaster suffix, a featured artist, a translated title — the highest
 * score is not reliably the right recording, and the wrong lyric is worse than
 * none: it looks like the app is broken. Rather than raise the acceptance
 * threshold (which mostly produces no lyric at all), every plausible match is
 * returned so the user can pick. Their choice displays at once and waits in the
 * 待写入 queue; nothing reaches the file until they say so.
 *
 * Candidates below the confidence floor are dropped, because offering obvious
 * mismatches makes the picker useless.
 */
const MIN_CANDIDATE_SCORE = 0.5

/**
 * How `lyricCandidates` reaches the platforms it matches against.
 *
 * Named so the injection point reads as "the search this function is allowed to
 * do" rather than an anonymous function type — the callers in `index.ts` are
 * what decide whether that search reaches the built-in adapters at all, and a
 * bare signature hides that.
 */
export type SearchOnlineForMatch = (source: SourceId, keyword: string, signal?: AbortSignal) => Promise<OnlineMusicInfo[]>

/**
 * Default search: the built-in adapters.
 *
 * Only reached when a caller passes nothing, which is what the offline test
 * suite does. Production callers in `index.ts` always inject a routed search,
 * so the gate the app actually ships with is decided there, not here.
 */
const defaultSearch: SearchOnlineForMatch = async (source, keyword, signal) => {
  const { searchOnline } = await import('../online/search')
  return (await searchOnline(source, keyword, 1, signal)).list
}

export async function lyricCandidates(
  track: Pick<LocalMusicInfo, 'id' | 'path' | 'name' | 'singer' | 'albumName' | 'duration'>,
  deps: {
    search?: SearchOnlineForMatch
    fetchLyric?: typeof fetchOnlineLyric
    /**
     * The version of the source that will answer, carried through so the caller
     * can stage the result under the same cache key it resolved with. This
     * function reads no cache itself.
     */
    provider?: string
  } = {}
): Promise<LyricCandidate[]> {
  const search = deps.search ?? defaultSearch
  const fetchLyric = deps.fetchLyric ?? fetchOnlineLyric
  const tagged = { ...track, id: track.id } as LocalMusicInfo

  // Try the tags first, then the filename stem as a second query.
  const queries: Array<LocalMusicInfo> = [tagged]
  const stem = basename(track.path, extname(track.path))
  if (stem && stem !== track.name) {
    // `Artist - Title` is the most common naming convention; split it so the
    // search gets both halves as separate signals.
    const parts = stem.split(/\s+-\s+/)
    queries.push({
      ...tagged,
      name: parts.length > 1 ? parts.slice(1).join(' - ') : stem,
      singer: parts.length > 1 ? parts[0] : track.singer
    })
  }

  const seen = new Set<string>()
  const found: LyricCandidate[] = []

  for (const query of queries) {
    let matches
    try {
      matches = await matchMetadata(query, { limit: 5, search })
    } catch {
      continue
    }

    // Fetch candidate lyrics in parallel: a picker that takes five round trips
    // in series is too slow to feel like a picker.
    const settled = await Promise.all(matches.map(async (candidate) => {
      if (candidate.score < MIN_CANDIDATE_SCORE) return null
      // Deduplicate across the two queries by platform id.
      const key = `${candidate.music.source}:${String(candidate.music.meta?.songmid ?? candidate.music.name)}`
      if (seen.has(key)) return null
      seen.add(key)
      try {
        const result = await fetchLyric(candidate.music)
        if (!result.lyric || !result.lyric.trim()) return null
        return {
          id: key,
          source: candidate.music.source,
          title: candidate.music.name,
          artist: candidate.music.singer,
          ...(candidate.music.albumName ? { album: candidate.music.albumName } : {}),
          score: candidate.score,
          lyric: result.lyric,
          ...(result.tlyric ? { tlyric: result.tlyric } : {}),
          ...(result.rlyric ? { rlyric: result.rlyric } : {}),
          synchronized: looksSynchronized(result.lyric),
          music: candidate.music
        } satisfies LyricCandidate
      } catch {
        return null
      }
    }))

    for (const entry of settled) {
      if (entry) found.push(entry)
    }
  }

  // Best match first; synced lyrics break ties, since they are strictly more
  // useful than plain text of equal confidence.
  found.sort((a, b) => (b.score - a.score) || (Number(b.synchronized) - Number(a.synchronized)))
  return found
}

/**
 * Save lyrics as a sidecar `.lrc` for a local track.
 * Writing the sidecar is what makes a manual edit take priority over the
 * embedded tag on the next resolve.
 */
export async function saveSidecar(audioPath: string, lyric: string): Promise<string> {
  const target = sidecarPathFor(audioPath)
  // UTF-8 with no BOM: the most widely compatible choice for .lrc consumers.
  // Atomic, because a half-written sidecar beats the intact embedded lyric.
  await writeFileAtomic(target, lyric.replace(/\r\n/g, '\n'))
  return target
}

/** Import a `.lrc` file's contents, returning the text. */
export async function readLyricFile(path: string): Promise<string> {
  const text = await readSidecar(path)
  if (text === null) throw new Error('歌词文件不存在或无法读取')
  return text
}
