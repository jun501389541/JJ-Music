/**
 * Conversion between our stored `OnlineMusicInfo` and the flattened shape that
 * 音源 scripts actually receive.
 *
 * This matters more than it looks. LX does not hand scripts its internal model;
 * it emits a *legacy flattened* object where `songmid`, `hash`, `albumName` and
 * `img` sit at the top level alongside `name`/`singer`/`source`. Real scripts
 * read those fields directly:
 *
 *   const songId = musicInfo.hash ?? musicInfo.songmid
 *
 * so getting this shape wrong makes every third-party source fail.
 *
 * ## The `id` field: LX omits it, and we used to as well — that was a mistake
 *
 * LX's flattened shape has no `id`, so a script reading `musicInfo.id` gets
 * `undefined`. The original code reproduced that omission deliberately, on the
 * theory that matching the host exactly is the safest default.
 *
 * A static scan of the 21 sources installed on this machine says otherwise:
 * **11 of them read `musicInfo.id`**. Most use it as the final fallback in
 * `hash ?? songmid ?? id`, but 溯音音源 branches on
 * `typeof musicInfo.id === 'string' && !/^\d+$/.test(musicInfo.id)` to decide
 * which of two request shapes to send, and 统一音乐源 echoes it back as the
 * song id. With the field absent those paths compute `undefined`/`NaN` and the
 * source fails to resolve a URL for tracks the same script plays fine in
 * LX Music.
 *
 * Providing it cannot break a working script: every observed use is a
 * `??`/`||` fallback or a truthiness guard, and a value that used to be
 * `undefined` becoming a real string only ever *adds* a successful branch.
 */
import type { LocalMusicInfo, OnlineMusicInfo, Quality } from '@shared/types'

/** The object handed to a script as `info.musicInfo` for an online track. */
export interface LegacyMusicInfo {
  /**
   * Platform track id.
   *
   * See the module comment: LX omits this, and the sources we measured depend
   * on it anyway. Sourced from the track's own id so it is always populated.
   */
  id: string
  name: string
  singer: string
  source: string
  songmid: string | number
  interval: string | null
  albumName: string
  /** Cover art URL; empty string when unknown. */
  img: string
  /** Always `{}` — a legacy field LX still sends. */
  typeUrl: Record<string, never>
  albumId?: string | number
  /** Qualities this track has on its own platform. */
  types: Array<{ type: string; size: string | null; hash?: string }>
  _types: Record<string, { size: string | null; hash?: string }>
  /** Present for `kg` only. */
  hash?: string
  /** Present for `tx`. */
  strMediaMid?: string
  albumMid?: string
  songId?: string | number
  /** Present for `mg`. */
  copyrightId?: string
  lrcUrl?: string
  mrcUrl?: string
  trcUrl?: string
  /** Present for `local`. */
  filePath?: string
  ext?: string
}

/**
 * Build the script-facing object for an online track.
 *
 * Fields are copied from `meta` because that is where the search adapters park
 * the source-specific identifiers.
 */
export function toLegacyOnline(music: OnlineMusicInfo): LegacyMusicInfo {
  const meta = music.meta ?? {}
  const qualitys = Array.isArray(meta.qualitys) ? meta.qualitys : []

  const types: Array<{ type: string; size: string | null; hash?: string }> = qualitys.map((q) => {
    const entry: { type: string; size: string | null; hash?: string } = {
      type: String(q.type),
      size: q.size ?? null
    }
    const hash = (q as { hash?: string }).hash
    if (hash) entry.hash = hash
    return entry
  })

  const legacy: LegacyMusicInfo = {
    id: String(music.id ?? ''),
    name: music.name,
    singer: music.singer,
    source: music.source,
    // `songmid` is always populated by LX, falling back to the meta song id.
    songmid: (meta.songmid as string | number) ?? (meta.songId as string | number) ?? music.id,
    albumName: music.albumName ?? '',
    img: music.picUrl ?? '',
    // `null` when unknown, matching LX's own `string | null` typing.
    interval: music.interval ?? null,
    typeUrl: {},
    types,
    _types: Object.fromEntries(types.map((t) => [t.type, { size: t.size, ...(t.hash ? { hash: t.hash } : {}) }]))
  }

  if (meta.albumId !== undefined) legacy.albumId = meta.albumId as string | number
  if (meta.hash) legacy.hash = String(meta.hash)
  if (meta.strMediaMid) legacy.strMediaMid = String(meta.strMediaMid)
  if (meta.songId !== undefined) legacy.songId = meta.songId as string | number
  if (meta.albumMid) legacy.albumMid = String(meta.albumMid)
  if (meta.copyrightId) legacy.copyrightId = String(meta.copyrightId)
  // Optional lyric endpoints some Migu-backed sources expose.
  for (const key of ['lrcUrl', 'mrcUrl', 'trcUrl'] as const) {
    const value = meta[key]
    if (typeof value === 'string' && value) legacy[key] = value
  }
  return legacy
}

/** Build the script-facing object for a local file (the `local` pseudo-source). */
export function toLegacyLocal(track: LocalMusicInfo): LegacyMusicInfo {
  return {
    // For local files LX uses the file path as the song id, matching `songmid`.
    id: track.path,
    name: track.name,
    singer: track.singer,
    source: 'local',
    // For local files LX uses the file path as the song id.
    songmid: track.path,
    interval: track.duration ? formatInterval(track.duration) : null,
    albumName: track.albumName ?? '',
    img: '',
    typeUrl: {},
    albumId: '',
    types: [],
    _types: {},
    filePath: track.path,
    ext: track.path.split('.').pop() ?? ''
  }
}

/** `mm:ss`, matching LX's interval format. */
export function formatInterval(seconds: number): string {
  const total = Math.max(0, Math.round(seconds))
  const minutes = Math.floor(total / 60)
  const rest = total % 60
  return `${String(minutes).padStart(2, '0')}:${String(rest).padStart(2, '0')}`
}

/**
 * Choose the quality to request, mirroring LX's `getPlayQuality`.
 *
 * The user's preference is downgraded to the best tier present in both the
 * track's own `_types` and the qualities the source declared it can serve. If
 * the user picked `128k` (or anything outside the top three), `128k` is used
 * directly — exactly as LX does.
 */
export const TRY_QUALITYS_LIST: Quality[] = ['flac24bit', 'flac', '320k']

export function pickQuality(
  preferred: Quality,
  trackQualityKeys: string[],
  sourceQualities: Quality[]
): Quality {
  if (!TRY_QUALITYS_LIST.includes(preferred)) return '128k'

  const trackSet = new Set(trackQualityKeys)
  const sourceSet = new Set(sourceQualities)
  const start = TRY_QUALITYS_LIST.indexOf(preferred)
  const found = TRY_QUALITYS_LIST.slice(start).find(
    (quality) => trackSet.has(quality) && sourceSet.has(quality)
  )
  return found ?? '128k'
}
