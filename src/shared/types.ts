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
export type SourceId = (typeof LX_SOURCE_IDS)[number] | (string & {})

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
 * The platforms the app will cross-reference when it has to find the same
 * recording somewhere else.
 *
 * `local` is excluded: it is this app's own library, not a song source.
 * Everything outside this list is still playable — a script that registers a
 * private id such as `qs` resolves its own playback URLs — but the app never
 * looks for a match there, because it has no host-side search for it. Scripts
 * advertise those ids freely, which is expected; `SourceId` allows them and
 * `normaliseSources` keeps the raw key as the display name on purpose.
 */
export const ONLINE_SOURCE_IDS: readonly string[] = LX_SOURCE_IDS.filter((id) => id !== 'local')

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
   * Provenance for the art and lyrics of this row.
   *
   * Online tracks carry it for the same reason local ones do: whether the cover
   * came with the platform's search row or had to be asked from the 音源 script
   * changes what a re-play has to do when it is missing.
   */
  assets?: TrackAssets
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
  /**
   * Where the cover and each lyric slot come from, best source first. Replaces
   * the old `lyricPath` / `hasEmbeddedLyric` / `hasSyncedLyric` trio, which could
   * say "there is a lyric" but not which of the three places it was in — the
   * question the whole UI keeps having to answer.
   */
  assets?: TrackAssets
}

/** Where a displayed lyric came from. */
export type LyricSource = 'embedded' | 'sidecar' | 'online' | 'none'

/* ------------------------------------------------------------------ *
 * Assets: cover art and lyrics, and where each copy actually lives
 * ------------------------------------------------------------------ */

/**
 * The five places an asset can live. This is not decoration: the value decides
 * whether deleting it loses something the user owns, and whether the app may
 * overwrite it.
 *
 *  - `embedded`  inside the audio file (APIC / Vorbis PICTURE / USLT / SYLT / ©lyr).
 *    Writing it mutates a file the user owns, so it needs a backup and an explicit
 *    action.
 *  - `sidecar`   a file next to the audio (同名 `.lrc`). Lives in the user's music
 *    folder, other players read it, and it outranks every automatic source.
 *  - `cache`     a copy inside the app's data folder (extracted cover art, downloaded
 *    artist portraits). Deleting it costs a re-extraction, nothing more.
 *  - `remote`    only an address, no local copy yet.
 *  - `user`      something the user placed or typed themselves — never overwritten
 *    by an automatic pass.
 */
export type AssetOrigin = 'embedded' | 'sidecar' | 'cache' | 'remote' | 'user'

/**
 * Where an asset can be put when the app writes one.
 *
 * `embedded` mutates a file the user owns; `sidecar` adds a file next to it.
 * Those are the only two places the app writes — `cache` and `remote` are
 * sources it reads, never destinations.
 */
export type AssetWriteTarget = 'embedded' | 'sidecar'

/** The user's choice in settings: one destination, or both at once. */
export type AssetWriteChoice = AssetWriteTarget | 'both'

/** The two things this app treats as an asset, i.e. can write for a track. */
export type AssetKind = 'lyric' | 'cover'

/**
 * An asset the app has obtained but not written anywhere yet.
 *
 * Staging rather than writing is the MusicBrainz Picard model: nothing touches
 * the user's files until they say so, and the staged list survives a restart so
 * the decision can be made later, in bulk. A lyric carries its text; a cover
 * carries the cache file it was saved to, since a binary does not belong in
 * JSON.
 */
export interface PendingAsset {
  trackId: string
  kind: AssetKind
  /** Copy of the song's own labels, so the list can name entries cheaply. */
  name: string
  singer: string
  /** The audio file this would be written into or beside. */
  path: string
  /** Lyrics only: the LRC text. */
  lyric?: string
  /** Lyrics only: the text carries per-line timestamps. */
  synced?: boolean
  /** Covers only: the cached image to embed or copy. */
  image?: { path: string; mimeType: string }
  /** Where it came from, for the label the list shows. */
  origin: AssetOrigin
  provider?: string
  /** When it was staged (ms). */
  at: number
}

/** One available source for an asset. */
export interface AssetRef {
  origin: AssetOrigin
  /**
   * Who supplied it: a platform id, `音源脚本`, a tag descriptor. Local cover art
   * needs no field of its own because the copy's path is the track's `coverPath`.
   */
  provider?: string
  /** Remote address, meaningful only when there is no local copy. */
  url?: string
  /** Lyrics only: the text carries per-line timestamps. */
  synced?: boolean
  /**
   * Obtained from the network and staged for writing: usable right now, but not
   * yet in any file the user owns. Paired with the 待写入 list (`PendingAsset`).
   */
  pending?: boolean
  /** When this was recorded (ms), so "too old, fetch again" is expressible. */
  at?: number
}

/**
 * Every source available for one asset, best first — the resolution priority
 * written down as data instead of being spread across `if` statements.
 *
 * This is what the scanner saw, not a guarantee: a `.lrc` dropped in later does
 * not change the audio's size or mtime, so an incremental scan never notices.
 * The resolver still walks the list and actually reads each candidate, which is
 * why the list can describe availability without being the last word.
 */
export type AssetSources = AssetRef[]

/**
 * Asset provenance for one track.
 *
 * Slots follow OpenSubsonic's structured lyrics (`main` / `translation` /
 * `pronunciation`) so a translation is a labelled slot rather than a naming
 * convention, and the same shape works for a local FLAC and an online row.
 */
export interface TrackAssets {
  cover?: AssetSources
  lyrics?: {
    main?: AssetSources
    translation?: AssetSources
    pronunciation?: AssetSources
  }
}

/** A short human label for an asset source, e.g. 「文件内嵌（带时间轴）」「在线·平台接口」. */
export function describeAsset(asset: AssetRef | undefined): string {
  if (!asset) return '无'
  // `provider` is a machine id for the online lyric sources and a display string
  // for everything else (an image format, a platform name); mapping the known ids
  // here keeps the label in one place.
  const named = asset.provider ? ONLINE_LYRIC_SOURCE_LABELS[asset.provider as OnlineLyricSource] ?? asset.provider : ''
  const who = named ? `·${named}` : ''
  // Staged but not written yet: the label has to say so, or 「在线获取」 reads as
  // if the text were already safe in a file.
  const pending = asset.pending ? '（待写入）' : ''
  switch (asset.origin) {
    case 'embedded':
      return asset.synced === undefined
        ? `文件内嵌${who}`
        : `${asset.synced ? '文件内嵌（带时间轴）' : '文件内嵌（无时间轴）'}${who}`
    case 'sidecar':
      return '同目录文件'
    case 'cache':
      return `应用缓存${who}${pending}`
    case 'remote':
      return `在线获取${who}${pending}`
    case 'user':
      return '用户指定'
  }
}

/**
 * Where an *online* track's lyrics can come from.
 *
 * Three genuinely different providers, in the order they became available:
 *  - `script`: the user's 音源 script's `lyric` action. Rich when the script
 *    aggregates several sites, absent when it only implements `musicUrl` — which
 *    is most of them.
 *  - `platform`: this app's own adapter for the track's platform.
 *  - `search`: match the title and artist against the *other* platforms and take
 *    their lyric — what makes a 网易云-only 现场版 still get words.
 */
export type OnlineLyricSource = 'script' | 'platform' | 'search'
export const ONLINE_LYRIC_SOURCES: OnlineLyricSource[] = ['script', 'platform', 'search']
export const ONLINE_LYRIC_SOURCE_LABELS: Record<OnlineLyricSource, string> = {
  script: '音源脚本',
  platform: '平台接口',
  search: '联网匹配其他平台'
}

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
  /**
   * Cover art, stored as a file in the same content-addressed folder as track
   * covers so `jjmedia://` can serve it without a second allow-list.
   */
  coverPath?: string
}

/* ------------------------------------------------------------------ *
 * App settings
 * ------------------------------------------------------------------ */

/**
 * Where playback stopped at the end of the previous session.
 *
 * Recorded on a throttle (periodically while playing, and once on quit) rather
 * than on every time update, which would write the settings file several times
 * a second.
 */
export interface LastSession {
  /** The track that was loaded. */
  track: PlayableTrack
  /** Position within that track, in seconds. */
  position: number
  /** The queue it was playing from, so "continue" restores the context. */
  queue: PlayableTrack[]
  /** Index of `track` within `queue`. */
  index: number
  /** When this was written, so a very old session can be ignored. */
  at: number
}

/**
 * One playback queue the user has played recently, kept so the panel can page
 * back to it.
 *
 * A snapshot of `queue` plus when it was started, and a `label` because a list
 * of 300 rows is otherwise indistinguishable from the next 300 rows — the panel
 * header names the album, playlist or search that produced it.
 *
 * The tracks are stored whole, exactly as `LastSession` stores its queue. A
 * partial record (id + name + duration) cannot be played again: an online
 * track's whole identity lives in `meta` (`songmid`, `hash`, `copyrightId`),
 * which is what the platform resolvers read.
 */
export interface QueueSnapshot {
  /** What this list was, e.g. 「歌单 · 忆」 or 「搜索 · 陈奕迅」. */
  label: string
  queue: PlayableTrack[]
  /** When it started playing, so the panel can order and age them. */
  at: number
}

export interface AppSettings extends UiPreferences {
  /** Most recently played tracks, newest first, bounded to 100 entries. */
  recentPlayed: PlayableTrack[]
  /**
   * Where playback stopped last session, for "continue where you left off".
   *
   * Kept apart from `recentPlayed` (a history list) because this is a single
   * resume point: the track, how far in, and the queue it belonged to. Merging
   * the two would mean either losing the queue or storing a position for every
   * history entry.
   *
   * `null` is an explicit "there is none", which is what clearing the queue
   * writes; it has to be a value rather than an absent key because the settings
   * writer snapshots patches through JSON, which drops undefined.
   */
  lastSession?: LastSession | null
  /**
   * The queues played most recently, newest first, at most two of them.
   *
   * The panel shows these as pages beside the live queue — three pages in
   * total, which is the user's spec ("连当前队列共 3 页"). Two stored snapshots
   * plus the queue that is playing now.
   *
   * Written when a whole list starts playing, not on a timer: unlike
   * `lastSession`, whose position changes every second, this changes once per
   * user action, so there is nothing to throttle and no 600 KB write riding on
   * every playback tick.
   */
  queueHistory?: QueueSnapshot[]
  /**
   * Search keywords the user has run, newest first, capped.
   *
   * Lives with the other things the app remembers rather than in a file of its
   * own because it is exactly the same shape of data: short strings, written
   * often, worthless if lost, and cleared by the same switch that hides it.
   * `showSearchHistory` decides whether they are recorded at all.
   */
  searchHistory: string[]
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
  /**
   * Which source to ask first for an online track's lyrics.
   *
   * A setting rather than a fixed chain because the right answer is per-library:
   * a good 音源 script aggregates several sites and should lead, while most
   * scripts only implement `musicUrl` and then the platform adapter is the only
   * thing that ever answers.
   */
  onlineLyricSource: OnlineLyricSource
  /** When the preferred source comes back empty, try the remaining ones in order. */
  onlineLyricFallback: boolean
  /** Download folder for online tracks. */
  downloadFolder: string
  downloadLyric: boolean
  downloadEmbedLyric: boolean
  downloadTranslation: boolean
  downloadRomanization: boolean
  downloadEmbedCover: boolean
  /**
   * Where 「写入封面 / 写入歌词」 puts what it writes.
   *
   * `embedded` changes a file the user owns; `sidecar` adds a new one beside it.
   * `both` is what Picard and JRiver Medley do for lyrics specifically, because
   * the two are read by different crowds and neither is a superset of the other.
   * A format the app cannot write falls back to the sidecar, and says so.
   */
  assetWriteTarget: AssetWriteChoice
  /**
   * File extensions the app may modify in place.
   *
   * This can only *narrow* the set the tag writers actually implement, so a
   * renderer that writes this key cannot make the app touch a new format — the
   * intersection is taken at write time, not at settings time.
   */
  tagWritableFormats: string[]
  /**
   * Keep playing when the window is closed.
   *
   * When true, closing the window hides it to the tray instead of quitting;
   * the audio keeps running and the tray menu is the way back. When false the
   * app quits, which is the pre-existing behaviour.
   */
  minimizeToTray: boolean
  /** Preferred audio output device id; empty means the system default. */
  outputDeviceId: string
  /**
   * Desktop-lyric overlay: an always-on-top strip of lyrics outside the window.
   *
   * The main process watches this on every settings write and creates or
   * destroys the window, so the setting means the same thing wherever it is
   * changed — the toolbar's 词 button, the 更多 menu, or the overlay's own
   * right-click menu.
   */
  desktopLyric: boolean
  /**
   * Locked overlay: the window ignores the mouse, so clicks land on whatever is
   * behind it. The price of that is that the overlay cannot be right-clicked or
   * dragged either, so unlocking has to be reachable from the app — which is
   * what the 桌面歌词 group in the 更多 menu is for.
   */
  desktopLyricLocked: boolean
  /** Overlay text size in px, independent of the now-playing page's lyric size. */
  desktopLyricFontSize: number
  /**
   * Where the user parked the overlay, as its top-left corner.
   *
   * Null until it has been moved once, so the first run can centre it against
   * the work area rather than hard-coding a position that assumes one monitor.
   */
  desktopLyricPosition: { x: number; y: number } | null
  /**
   * Sidebar playlist order, by id.
   *
   * 我喜欢的 and 默认列表 are fixed at the top, so this only ever orders the
   * user's own lists. Ids missing from the array keep store order at the end,
   * and ids left over from a deleted playlist are ignored — the list is a hint,
   * not the source of truth, which is what lets it survive renames and deletes
   * without a migration.
   */
  playlistOrder: string[]
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
  /**
   * Validators from the response that produced `.part`, kept so a resume can send
   * `If-Range`. Without them a server that rotated its file mid-download would glue
   * two different recordings into one file that still passes the length check.
   */
  etag?: string
  lastModified?: string
  /**
   * The whole-file length the first response reported, kept across retries.
   *
   * `If-Range` is what notices a rotated remote file, but some relays send no
   * ETag and no Last-Modified at all. For those the length is the only signal
   * left, so a resumed segment is checked against this instead of against
   * `total`, which is per-attempt progress and is cleared on 重试.
   */
  remoteSize?: number
  path?: string
  /**
   * The `.lrc` this download wrote next to `path`, and only that one.
   *
   * The sidecar is written with 不覆盖, so a `.lrc` sitting beside the audio may be
   * one the user wrote by hand. 「移除记录 + 删除文件」 has to be able to tell the two
   * apart, and after a restart there is no other way to know who made that file.
   */
  lyricPath?: string
  error?: string
  warnings: string[]
  createdAt: number
}
/**
 * One entry of "what is being searched right now" on a platform.
 *
 * Lives here rather than beside the fetcher because the preload bridge and the
 * search page both need it, and neither may import from `src/main`.
 */
export interface HotWord {
  text: string
  source: SourceId
}

export interface ImportedPlaylist {
  name: string
  source: SourceId
  sourceListId: string
  /** The platform's own cover, when its response carried one. */
  coverUrl?: string
  tracks: OnlineMusicInfo[]
  total: number
  warnings: string[]
}
