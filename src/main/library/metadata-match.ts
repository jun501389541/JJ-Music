/**
 * Metadata matching ("标签匹配").
 *
 * Given a local track, search the online platforms for the same recording and
 * propose corrected tags. This is the feature a local-library-first player needs
 * and that LX Music has no equivalent of.
 *
 * The design is deliberately conservative, because the failure mode of a tag
 * matcher is silent corruption of a music library:
 *
 *   1. **Never write automatically.** The caller gets a scored proposal list and
 *      the user picks one.
 *   2. **Score, do not just take the first hit.** A search for a badly-tagged
 *      track returns plenty of wrong answers; ranking by title/artist/album
 *      similarity and duration is what makes the feature usable.
 *   3. **Only fill fields that are missing or clearly wrong** unless the caller
 *      explicitly asks for an overwrite.
 */
import type { LocalMusicInfo, OnlineMusicInfo, SourceId } from '@shared/types'
import type { MatchCandidate, MatchOptions } from '@shared/library-types'
import { searchOnline } from '../online/search'
import { fetchOnlineLyric } from '../online/lyrics'
import type { TagPatch } from './tag-writer'

export type { MatchCandidate, MatchOptions }

/* ------------------------------------------------------------------ *
 * Similarity helpers
 * ------------------------------------------------------------------ */

/** Lowercase, strip punctuation and bracketed suffixes, collapse whitespace. */
function normalize(value: string): string {
  return value
    .toLowerCase()
    .replace(/[（(【\[].*?[)）】\]]/g, ' ')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * Token-set similarity (a Dice coefficient over character bigrams).
 *
 * Bigrams work noticeably better than word overlap for Chinese titles, where
 * word segmentation is unreliable and a one-character difference matters.
 */
function similarity(a: string, b: string): number {
  const left = normalize(a)
  const right = normalize(b)
  if (!left || !right) return 0
  if (left === right) return 1

  const bigrams = (text: string): Map<string, number> => {
    const map = new Map<string, number>()
    for (let i = 0; i < text.length - 1; i += 1) {
      const gram = text.slice(i, i + 2)
      map.set(gram, (map.get(gram) ?? 0) + 1)
    }
    return map
  }

  const la = bigrams(left)
  const lb = bigrams(right)
  let overlap = 0
  for (const [gram, count] of la) {
    const other = lb.get(gram)
    if (other) overlap += Math.min(count, other)
  }
  const total = [...la.values()].reduce((s, n) => s + n, 0) + [...lb.values()].reduce((s, n) => s + n, 0)
  return total === 0 ? 0 : (2 * overlap) / total
}

/** Parse `mm:ss` into seconds. */
function intervalToSeconds(interval: string | undefined): number | undefined {
  if (!interval) return undefined
  const match = /^(\d{1,3}):(\d{1,2})$/.exec(interval.trim())
  if (!match) return undefined
  return Number.parseInt(match[1], 10) * 60 + Number.parseInt(match[2], 10)
}

/* ------------------------------------------------------------------ *
 * Scoring
 * ------------------------------------------------------------------ */

interface ScoreInput {
  local: LocalMusicInfo
  candidate: OnlineMusicInfo
}

/**
 * Score one candidate against the local track.
 *
 * Weighting reflects what is reliable: the title is the strongest signal, the
 * artist next, and duration is a powerful tie-breaker when both are similar.
 * An album match adds confidence but is not required — plenty of correct
 * matches come from compilations with a different album name.
 */
function scoreCandidate({ local, candidate }: ScoreInput): { score: number; reasons: string[] } {
  const reasons: string[] = []

  const titleScore = similarity(local.name, candidate.name)
  reasons.push(`标题 ${(titleScore * 100).toFixed(0)}%`)

  // The local artist field may hold several names separated by a slash or
  // enumeration comma; compare against each and keep the best.
  const localArtists = (local.singer || '').split(/[、,;/&]|\s+feat\.?\s+/i).map((s) => s.trim()).filter(Boolean)
  const candidateArtists = (candidate.singer || '').split(/[、,;/&]|\s+feat\.?\s+/i).map((s) => s.trim()).filter(Boolean)
  let artistScore = 0
  for (const a of localArtists) {
    for (const b of candidateArtists) {
      artistScore = Math.max(artistScore, similarity(a, b))
    }
  }
  if (localArtists.length === 0 || candidateArtists.length === 0) artistScore = 0.5
  reasons.push(`艺术家 ${(artistScore * 100).toFixed(0)}%`)

  let albumScore = 0
  if (local.albumName && candidate.albumName) {
    albumScore = similarity(local.albumName, candidate.albumName)
    reasons.push(`专辑 ${(albumScore * 100).toFixed(0)}%`)
  }

  // Duration: within 2 s is essentially certain; beyond 15 s is a different cut.
  let durationScore = 0.5
  const localSeconds = local.duration
  const candidateSeconds = intervalToSeconds(candidate.interval)
  if (localSeconds && candidateSeconds) {
    const delta = Math.abs(localSeconds - candidateSeconds)
    if (delta <= 2) durationScore = 1
    else if (delta <= 5) durationScore = 0.85
    else if (delta <= 10) durationScore = 0.6
    else if (delta <= 20) durationScore = 0.3
    else durationScore = 0.05
    reasons.push(`时长差 ${delta}s`)
  }

  const score =
    titleScore * 0.45 +
    artistScore * 0.25 +
    durationScore * 0.2 +
    albumScore * 0.1

  return { score, reasons }
}

/* ------------------------------------------------------------------ *
 * Patch construction
 * ------------------------------------------------------------------ */

/** Build the patch, respecting the overwrite policy. */
function buildPatch(
  local: LocalMusicInfo,
  candidate: OnlineMusicInfo,
  overwrite: boolean
): { patch: TagPatch; fields: Array<keyof TagPatch> } {
  const patch: TagPatch = {}
  const fields: Array<keyof TagPatch> = []

  const consider = <K extends keyof TagPatch>(
    field: K,
    proposed: TagPatch[K],
    current: string | number | undefined
  ): void => {
    if (proposed === undefined || proposed === '') return
    const hasCurrent = current !== undefined && current !== '' && current !== 0
    if (hasCurrent && !overwrite) return
    // Do not propose a change that is not actually a change.
    if (hasCurrent && String(current) === String(proposed)) return
    patch[field] = proposed
    fields.push(field)
  }

  consider('title', candidate.name, local.name)
  consider('artist', candidate.singer, local.singer)
  consider('album', candidate.albumName, local.albumName)

  return { patch, fields }
}

/* ------------------------------------------------------------------ *
 * Entry point
 * ------------------------------------------------------------------ */

/**
 * Find metadata matches for a local track.
 *
 * Searches every requested platform in parallel and returns the best-scoring
 * candidates across all of them. A platform that fails is skipped rather than
 * failing the whole operation, since one dead adapter should not block a match.
 */
export async function matchMetadata(
  local: LocalMusicInfo,
  options: MatchOptions & { signal?: AbortSignal } = {}
): Promise<MatchCandidate[]> {
  const limit = options.limit ?? 8
  const overwrite = options.overwrite ?? false
  const sources = options.sources ?? (['tx', 'wy', 'kw'] as SourceId[])

  // Query on the most identifying text available. Falling back to the filename
  // stem matters for tracks whose tags are entirely absent.
  const query = [local.name, local.singer].filter(Boolean).join(' ').trim()
  if (!query) return []

  const settled = await Promise.allSettled(
    sources.map(async (source) => {
      const page = await searchOnline(source, query, 1, options.signal)
      return page.list
    })
  )

  const candidates: MatchCandidate[] = []
  for (const result of settled) {
    if (result.status !== 'fulfilled') continue
    for (const music of result.value) {
      const { score, reasons } = scoreCandidate({ local, candidate: music })
      const { patch, fields } = buildPatch(local, music, overwrite)
      candidates.push({ music, score, fields, patch, reasons })
    }
  }

  candidates.sort((a, b) => b.score - a.score)

  // Drop near-duplicates of the same recording returned by several platforms,
  // keeping the highest-scoring one so the list is not five copies of one song.
  const deduped: MatchCandidate[] = []
  const seen = new Set<string>()
  for (const candidate of candidates) {
    const key = `${normalize(candidate.music.name)}|${normalize(candidate.music.singer)}`
    if (seen.has(key)) continue
    seen.add(key)
    deduped.push(candidate)
    if (deduped.length >= limit) break
  }

  return deduped
}

/**
 * Fetch lyrics for a match, to be written alongside the tags.
 * Kept separate so the UI can request it only for the candidate the user picks.
 */
export async function lyricsForMatch(music: OnlineMusicInfo): Promise<string> {
  const result = await fetchOnlineLyric(music)
  return result.lyric ?? ''
}
