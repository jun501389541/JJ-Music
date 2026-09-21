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
import { readFile, stat, writeFile } from 'node:fs/promises'
import { basename, extname } from 'node:path'
import type { AssetRef, LyricResult, LocalMusicInfo, OnlineLyricSource, OnlineMusicInfo, SourceId } from '@shared/types'
import { ONLINE_LYRIC_SOURCES } from '@shared/types'
import type { ResolvedLyric, LyricCandidate } from '@shared/library-types'
import { readEmbeddedLyric } from '../library/embedded-lyrics'
import { sidecarPathFor } from './asset-files'
import { fetchOnlineLyric } from '../online/lyrics'
import { matchMetadata } from '../library/metadata-match'
import { stripBom } from '../store/json-file'

export type { ResolvedLyric }

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
  steps: Record<OnlineLyricSource, () => Promise<LyricResult>>
): Promise<{ lyric: LyricResult; asset: AssetRef | null }> {
  for (const source of order) {
    try {
      const result = await steps[source]()
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
  } = {}
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
  const others: SourceId[] = (['tx', 'wy', 'kw', 'kg', 'mg'] as SourceId[]).filter((source) => source !== music.source)

  let matches
  try {
    matches = await match(query, { sources: others, limit: 6 })
  } catch {
    return { lyric: '' }
  }
  for (const candidate of matches) {
    if (candidate.score < MIN_OTHER_PLATFORM_SCORE) continue
    const result = await fetchLyric(candidate.music)
    if (result.lyric.trim()) return result
  }
  return { lyric: '' }
}

/** LRU-ish cache keyed by track id, so re-opening a track is instant. */
const cache = new Map<string, ResolvedLyric>()
const CACHE_LIMIT = 64

function cacheSet(key: string, value: ResolvedLyric): void {
  if (cache.size >= CACHE_LIMIT) {
    const oldest = cache.keys().next().value
    if (oldest !== undefined) cache.delete(oldest)
  }
  cache.set(key, value)
}

export function clearLyricCache(trackId?: string): void {
  if (trackId) cache.delete(trackId)
  else cache.clear()
}

/**
 * Put a resolved lyric into the cache under this track.
 *
 * The caller uses it when it learns something the resolver could not know — that
 * the online lyric it just handed over is now also sitting in the 待写入 queue.
 * Without this, the second read of the same track comes from the cache and
 * reports the lyric as if nothing were pending, so the badge would blink the
 * truth once and then lie.
 */
export function primeLyricCache(trackId: string, resolved: ResolvedLyric): void {
  cacheSet(trackId, resolved)
}

/** True when the text contains at least one LRC timestamp. */
function looksSynchronized(text: string): boolean {
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
  options: { allowOnline?: boolean; force?: boolean } = {}
): Promise<ResolvedLyric> {
  const allowOnline = options.allowOnline !== false
  if (!options.force) {
    const cached = cache.get(track.id)
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
        cacheSet(track.id, resolved)
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
        cacheSet(track.id, resolved)
        return resolved
      }
    }
    // Anything else recorded (a cached or user-supplied lyric) has no on-disk
    // reader yet, so it falls through to the network rather than being trusted.
  }

  // 3. online, matched by the track's own tags
  if (allowOnline) {
    const online = await searchLyricOnline(track)
    if (online.lyric.trim()) {
      cacheSet(track.id, online)
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
  track: Pick<LocalMusicInfo, 'id' | 'path' | 'name' | 'singer' | 'albumName' | 'duration'>
): Promise<ResolvedLyric> {
  const candidates = await lyricCandidates(track)
  const best = candidates.find((entry) => entry.lyric.trim())
  if (!best) return { lyric: '', source: 'none', synchronized: false, note: '在线未匹配到歌词' }

  return {
    lyric: best.lyric,
    ...(best.tlyric ? { tlyric: best.tlyric } : {}),
    ...(best.rlyric ? { rlyric: best.rlyric } : {}),
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
 * returned so the user can pick. Their choice is saved as a sidecar, which then
 * wins on every later load.
 *
 * Candidates below the confidence floor are dropped, because offering obvious
 * mismatches makes the picker useless.
 */
const MIN_CANDIDATE_SCORE = 0.5

export async function lyricCandidates(
  track: Pick<LocalMusicInfo, 'id' | 'path' | 'name' | 'singer' | 'albumName' | 'duration'>
): Promise<LyricCandidate[]> {
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
      matches = await matchMetadata(query, { limit: 5 })
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
        const result = await fetchOnlineLyric(candidate.music)
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
  await writeFile(target, lyric.replace(/\r\n/g, '\n'), 'utf8')
  return target
}

/** Import a `.lrc` file's contents, returning the text. */
export async function readLyricFile(path: string): Promise<string> {
  const text = await readSidecar(path)
  if (text === null) throw new Error('歌词文件不存在或无法读取')
  return text
}

/** Lyrics for an online track, used by the player when a source provides them. */
export async function resolveOnlineLyric(music: OnlineMusicInfo): Promise<LyricResult> {
  return fetchOnlineLyric(music)
}
