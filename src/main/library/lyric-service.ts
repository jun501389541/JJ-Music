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
import { existsSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { basename, dirname, extname, join } from 'node:path'
import type { LyricResult, LocalMusicInfo, OnlineMusicInfo } from '@shared/types'
import type { ResolvedLyric } from '@shared/library-types'
import { readEmbeddedLyric } from '../library/embedded-lyrics'
import { fetchOnlineLyric } from '../online/lyrics'
import { matchMetadata } from '../library/metadata-match'
import { stripBom } from '../store/json-file'

export type { ResolvedLyric }

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

/** True when the text contains at least one LRC timestamp. */
function looksSynchronized(text: string): boolean {
  return /\[\d{1,3}:\d{1,2}(?:[.:]\d{1,3})?\]/.test(text)
}

/** Read a sidecar `.lrc`, tolerating the encodings these files actually use. */
async function readSidecar(path: string): Promise<string | null> {
  if (!existsSync(path)) return null
  try {
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

/** Sidecar path convention: same directory, same base name, `.lrc`. */
export function sidecarPathFor(audioPath: string): string {
  return join(dirname(audioPath), `${basename(audioPath, extname(audioPath))}.lrc`)
}

/**
 * Resolve lyrics for a local track.
 *
 * Never throws: a track with no lyrics anywhere is a normal result, reported as
 * an empty lyric plus an explanatory note.
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

  // 1. sidecar (an explicit user choice, or a previous manual edit)
  const sidecar = await readSidecar(sidecarPathFor(track.path))
  if (sidecar && sidecar.trim()) {
    const resolved: ResolvedLyric = {
      lyric: sidecar,
      source: 'sidecar',
      synchronized: looksSynchronized(sidecar)
    }
    cacheSet(track.id, resolved)
    return resolved
  }

  // 1b. a path recorded during scanning (covers non-standard names)
  if (track.lyricPath && track.lyricPath !== sidecarPathFor(track.path)) {
    const recorded = await readSidecar(track.lyricPath)
    if (recorded && recorded.trim()) {
      const resolved: ResolvedLyric = {
        lyric: recorded,
        source: 'sidecar',
        synchronized: looksSynchronized(recorded)
      }
      cacheSet(track.id, resolved)
      return resolved
    }
  }

  // 2. embedded tag
  const embedded = await readEmbeddedLyric(track.path)
  if (embedded && embedded.lyric.trim()) {
    const resolved: ResolvedLyric = {
      lyric: embedded.lyric,
      source: 'embedded',
      synchronized: embedded.synchronized
    }
    cacheSet(track.id, resolved)
    return resolved
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

  for (const query of queries) {
    let candidates
    try {
      candidates = await matchMetadata(query, { limit: 5 })
    } catch {
      continue
    }

    // A weak match is worse than no lyric: showing the wrong song's words looks
    // like a bug. Require a reasonable score before accepting.
    for (const candidate of candidates) {
      if (candidate.score < 0.55) continue
      const result = await fetchOnlineLyric(candidate.music)
      if (result.lyric && result.lyric.trim()) {
        return {
          lyric: result.lyric,
          ...(result.tlyric ? { tlyric: result.tlyric } : {}),
          ...(result.rlyric ? { rlyric: result.rlyric } : {}),
          source: 'online',
          synchronized: looksSynchronized(result.lyric),
          matchedMusic: candidate.music,
          matchScore: candidate.score
        }
      }
    }
  }

  return { lyric: '', source: 'none', synchronized: false, note: '在线未匹配到歌词' }
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
