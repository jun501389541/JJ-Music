import type { UiPreferences } from './preferences'
/**
 * Shared type definitions used by both the Electron main process and the
 * renderer. Keep this file free of any runtime imports so it can be consumed
 * from either side without pulling in Node or DOM globals.
 */

/* ------------------------------------------------------------------ *
 * Music sources (音源)
 * ------------------------------------------------------------------ */

/** Built-in source identifiers used by LX Music and compatible 音源 scripts. */
export type SourceId = 'kw' | 'kg' | 'tx' | 'wy' | 'mg' | 'local' | (string & {})

/** Quality tiers, ordered from lowest to highest fidelity. */
export type Quality = '128k' | '320k' | 'flac' | 'flac24bit' | 'hires' | 'atmos' | 'master'

/**
 * The qualities LX's custom-source API can actually carry.
 *
 * LX hard-limits custom sources to these four and silently intersects them
 * with a per-source whitelist, so a script advertising `hires`/`atmos`/`master`
 * has those filtered out by the host. We do the same when talking to 音源
 * scripts. The wider `Quality` union exists for the local/native engine, where
 * Hi-Res and DSD files genuinely occur.
 */
export const LX_QUALITIES: Quality[] = ['128k', '320k', 'flac', 'flac24bit']

/** Source ids the LX custom-source API recognises. */
export const LX_SOURCE_IDS = ['kw', 'kg', 'tx', 'wy', 'mg', 'local'] as const

/**
 * The three actions a custom source may implement.
 *
 * Note that `lyric` and `pic` are only reachable for the `local` pseudo-source
 * in LX; for the real platforms only `musicUrl` is ever requested. We keep the
 * broader `SourceAction` union for internal use, but this is the set a script
 * can meaningfully register.
 */
export const LX_ACTIONS = ['musicUrl', 'lyric', 'pic'] as const

export const QUALITY_ORDER: Quality[] = [
  '128k',
  '320k',
  'flac',
  'flac24bit',
  'hires',
  'atmos',
  'master'
]

export const QUALITY_LABELS: Record<string, string> = {
  '128k': '标准 128k',
  '320k': '高品 320k',
  flac: '无损 FLAC',
  flac24bit: 'Hi-Res FLAC',
  hires: 'Hi-Res',
  atmos: '全景声',
  master: '母带'
}

/** Actions a 音源 script may declare support for. */
export type SourceAction =
  | 'musicUrl'
  | 'lyric'
  | 'pic'
  | 'search'
  | 'hotSearch'
  | 'songList'
  | 'leaderboard'
  | 'tipSearch'
  | 'auth'

/**
 * One source exposed by an imported script, exactly as the script reported it
 * through `lx.send(lx.EVENT_NAMES.inited, { sources })`.
 */
export interface SourceInfo {
  /** Platform key, e.g. `kw`, `tx`, or a custom id such as `git`. */
  id: SourceId
  /** Human readable name, e.g. `酷狗音乐`. */
  name: string
  /** Usually `music`. */
  type?: string
  /** Which actions this source implements. */
  actions: SourceAction[]
  /** Quality tiers this source can serve. */
  qualitys: Quality[]
}

/** A 音源 script the user imported, with its parsed metadata header. */
export interface UserApiMeta {
  /** Stable id assigned by us, e.g. `user_api_1`. */
  id: string
  /** `@name` from the script header, or the file name. */
  name: string
  description: string
  version: string
  author: string
  homepage: string
  /** Whether the script may raise update alerts. */
  allowShowUpdateAlert: boolean
  /** Number of sources the script advertised after init. */
  sourceCount: number
  /** Whether the script is currently enabled. */
  enabled: boolean
  /** ISO timestamp of import. */
  importedAt: string
  /** Last init error, if the script failed to initialise. */
  lastError?: string
  /**
   * Set when this source was disabled for unsafe behaviour rather than by the
   * user.
   *
   * A quarantined source stays disabled across restarts and cannot be switched
   * back on without the user explicitly clearing the quarantine — the case that
   * motivated it was a script that shut the machine down when started.
   */
  quarantined?: boolean
  /**
   * Heuristic risk rating, computed at import time.
   *
   * Reported because a source is third-party code that runs with real
   * privileges. A high rating means the script is opaque and self-protecting
   * rather than that it is definitely malicious — but the user should know
   * before enabling it.
   */
  risk?: 'low' | 'medium' | 'high'
  /** Why the script was rated as it was. */
  riskNotes?: string[]
}

/* ------------------------------------------------------------------ *
 * Music entities
 * ------------------------------------------------------------------ */

/**
 * A track from an online source.
 *
 * The `meta` object is what gets handed to the 音源 script as `info.musicInfo`.
 * LX delivers a flattened legacy shape rather than the internal model, and
 * scripts read source-specific id fields directly, so we mirror it:
 *
 *   { name, singer, source, songmid, interval, albumName, img, albumId, ... }
 *
 * Notably there is NO `id` field in what LX delivers — scripts that read
 * `musicInfo.id` get `undefined`. The correct per-platform id is:
 *   kw -> songmid | kg -> hash | tx -> songmid | wy -> songmid | mg -> copyrightId
 */
export interface OnlineMusicInfo {
  /** `${source}_${songmid}` — our app-wide unique key. */
  id: string
  /** Track title. */
  name: string
  /** Artist(s), `、` separated. */
  singer: string
  source: SourceId
  /** `mm:ss`. */
  interval?: string
  /** Album name, when known. */
  albumName?: string
  /** Cover art URL, when known. LX calls this `img` in the delivered shape. */
  picUrl?: string
  /**
   * Source-specific payload passed straight through to the 音源 script.
   *
   * Identifier fields are typed `string | number` because platforms disagree:
   * QQ's `songId` and `albumId` are numeric while its `songmid` is not, and
   * Kuwo mixes both within one response.
   */
  meta: Record<string, unknown> & {
    songmid?: string | number
    hash?: string
    copyrightId?: string
    albumId?: string | number
    albumMid?: string
    songId?: string | number
    strMediaMid?: string
    qualitys?: Array<{ type: string; size?: string }>
  }
}

/** A track on disk. */
export interface LocalMusicInfo {
  id: string
  path: string
  name: string
  singer: string
  albumName?: string
  /** Seconds. */
  duration?: number
  /** Year, when tagged. */
  year?: number
  /** Track number, when tagged. */
  trackNo?: number
  /** Disc number, when tagged. */
  discNo?: number
  /** Genre, when tagged. */
  genre?: string
  /** Bitrate in bits per second. */
  bitrate?: number
  /** Sample rate in Hz. */
  sampleRate?: number
  /** Bits per sample. */
  bitsPerSample?: number
  /** Number of audio channels. */
  channels?: number
  /** Container/codec label, e.g. `FLAC`. */
  codec?: string
  /** Whether the file is lossless. */
  lossless?: boolean
  /** File size in bytes. */
  size?: number
  /** File mtime in ms, used for incremental rescans. */
  mtimeMs?: number
  /** Absolute path to a cached cover image, if extracted. */
  coverPath?: string
  /** Absolute path to a sidecar `.lrc`, if present. */
  lyricPath?: string
  /** True when the file's tags carry lyrics (ID3 USLT/SYLT, Vorbis LYRICS, MP4 ©lyr). */
  hasEmbeddedLyric?: boolean
  /** True when the embedded lyrics carry per-line timestamps. */
  hasSyncedLyric?: boolean
}

/** Where a displayed lyric came from. */
export type LyricSource = 'embedded' | 'sidecar' | 'online' | 'none'

/** Anything the player can queue. */
export type PlayableTrack = OnlineMusicInfo | LocalMusicInfo

export function isLocalTrack(track: PlayableTrack): track is LocalMusicInfo {
  return typeof (track as LocalMusicInfo).path === 'string'
}

/* ------------------------------------------------------------------ *
 * Playback
 * ------------------------------------------------------------------ */

export interface MusicUrlResult {
  url: string
  quality: Quality
  /** Actual quality served, which may be lower than requested. */
  source: SourceId
  /** Size in bytes, when reported. */
  size?: string
}

export interface LyricResult {
  /** Original lyrics, LRC. */
  lyric: string
  /** Translation, LRC. */
  tlyric?: string
  /** Romanisation, LRC. */
  rlyric?: string
  /** Word-by-word enhanced lyrics (LX LRC format). */
  lxlyric?: string
}

export type PlayMode = 'list' | 'repeat' | 'single' | 'random'

/* ------------------------------------------------------------------ *
 * Search / playlists
 * ------------------------------------------------------------------ */

export interface SearchResult {
  source: SourceId
  list: OnlineMusicInfo[]
  total?: number
  /** Present when the source supports paging. */
  page?: number
  allPage?: number
  /** Error message when this particular source failed. */
  error?: string
}

export interface Playlist {
  id: string
  name: string
  /** `local` for user-created lists, otherwise the source it came from. */
  source: SourceId | 'local'
  /** Remote list id when this is a subscribed online list. */
  sourceListId?: string
  position: number
  locationUpdateTime?: number
  /** Track count, filled in by the store. */
  trackCount?: number
}

/* ------------------------------------------------------------------ *
 * App settings
 * ------------------------------------------------------------------ */

export interface AppSettings extends UiPreferences {
  /** Most recently played tracks, newest first, bounded to 100 entries. */
  recentPlayed: PlayableTrack[]
  /** Preferred online quality; the engine falls back when unavailable. */
  playQuality: Quality
  /** Music library folders. */
  libraryFolders: string[]
  /** File extensions to scan. */
  scanExtensions: string[]
  /** Accent colour seed; `auto` extracts it from the cover art. */
  accent: 'auto' | string
  theme: 'dark' | 'light' | 'system'
  volume: number
  playMode: PlayMode
  /** Prefer local files over online sources when both match. */
  preferLocal: boolean
  /** Download folder for online tracks. */
  downloadFolder: string
  downloadLyric: boolean
  downloadEmbedLyric: boolean
  downloadTranslation: boolean
  downloadRomanization: boolean
  downloadEmbedCover: boolean
  /** Show the desktop lyric window. */
  desktopLyric: boolean
}

/* ------------------------------------------------------------------ *
 * IPC envelope
 * ------------------------------------------------------------------ */

export interface IpcResult<T> {
  ok: boolean
  data?: T
  error?: string
}

export function ok<T>(data: T): IpcResult<T> {
  return { ok: true, data }
}

export function fail(error: unknown): IpcResult<never> {
  return { ok: false, error: error instanceof Error ? error.message : String(error) }
}

/** Result of a bounded sample playback-URL / audio-header probe. */
export interface PlatformProbeResult {
  status: 'available' | 'failed' | 'unknown'
  message: string
  checkedAt: number
  sample?: string
}

export interface DownloadTask {
  id: string
  track: OnlineMusicInfo
  quality: Quality
  status: 'queued' | 'resolving' | 'downloading' | 'tagging' | 'completed' | 'failed' | 'cancelled'
  received: number
  total?: number
  path?: string
  error?: string
  warnings: string[]
  createdAt: number
}
export interface ImportedPlaylist {
  name: string
  source: SourceId
  sourceListId: string
  tracks: OnlineMusicInfo[]
  total: number
  warnings: string[]
}
