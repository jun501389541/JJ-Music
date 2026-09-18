/**
 * Types shared between the main process, the preload bridge and the renderer.
 *
 * These live here rather than beside their implementations on purpose. A
 * renderer typecheck must not reach into `src/main`, because those modules
 * import Node built-ins and would either fail to resolve or, worse, be pulled
 * into the renderer bundle. Only the *shapes* cross the boundary, so only the
 * shapes belong in this file.
 */
import type { LocalMusicInfo, LyricSource, OnlineMusicInfo, SourceId } from './types'

/** Source a resolved lyric came from. */
export type { LyricSource }

/**
 * A resolved lyric plus provenance, so the UI can label where it came from and
 * explain itself when there is nothing to show.
 */
export interface ResolvedLyric {
  lyric: string
  tlyric?: string
  rlyric?: string
  lxlyric?: string
  /** Where this lyric came from. */
  source: LyricSource
  /** True when the text carries line timestamps. */
  synchronized: boolean
  /** Online track the lyric was matched against, when `source === 'online'`. */
  matchedMusic?: OnlineMusicInfo
  /** Confidence of that match, 0..1. */
  matchScore?: number
  /** Explains an empty result, e.g. which sources were tried. */
  note?: string
}

/**
 * One alternative lyric offered when picking a match by hand.
 *
 * Lives in the shared file because all three layers touch it: the main process
 * builds it, the preload bridge types it, and the renderer lists it.
 */
export interface LyricCandidate {
  /** Stable handle, reused as the choice's identity in the picker. */
  id: string
  /** Platform the lyric came from (音源 id). */
  source: SourceId
  /** Matched track title, as that platform spells it. */
  title: string
  artist: string
  album?: string
  /** Match confidence, 0..1, from the metadata matcher. */
  score: number
  /** The lyric body. */
  lyric: string
  tlyric?: string
  rlyric?: string
  /** True when the lyric carries timestamps, which makes it more useful. */
  synchronized: boolean
  /** The online track this candidate belongs to. */
  music: OnlineMusicInfo
}

/** Fields a metadata match can fill in. */
export interface TagPatch {
  title?: string
  artist?: string
  album?: string
  albumArtist?: string
  year?: number
  trackNo?: number
  genre?: string
  /** LRC text to embed. */
  lyrics?: string
  /** Raw cover image bytes to embed. */
  cover?: { data: Uint8Array; mimeType: string }
}

/** Result of attempting to write tags to a file. */
export interface TagWriteResult {
  written: boolean
  /** Human-readable note about what happened, for the UI. */
  note: string
  /** Path of the backup created, when one was made. */
  backupPath?: string
}

/** One candidate recording proposed for a local track. */
export interface MatchCandidate {
  /** The online track this proposal came from. */
  music: OnlineMusicInfo
  /** 0..1 confidence. */
  score: number
  /** Which fields this candidate would change. */
  fields: Array<keyof TagPatch>
  /** The proposed values, already filtered by the caller's overwrite policy. */
  patch: TagPatch
  /** Per-signal breakdown, shown in the UI so a choice is explicable. */
  reasons: string[]
}

/** Options controlling a metadata match run. */
export interface MatchOptions {
  /** Platforms to query. Defaults to every platform with a search adapter. */
  sources?: SourceId[]
  /** How many candidates to return. */
  limit?: number
  /** Replace existing values instead of only filling gaps. */
  overwrite?: boolean
  /** Also fetch lyrics for the chosen candidate. */
  withLyrics?: boolean
}

/** Re-exported for convenience so callers need one import. */
export type { LocalMusicInfo }
