import {
  ONLINE_ALBUM_MAX_PAGES,
  ONLINE_ALBUM_MAX_TRACKS,
  ONLINE_ARTIST_MAX_PAGES,
  ONLINE_ENTITY_PAGE_SIZE,
  type OnlineAlbumRef,
  type OnlineArtistRef,
  type OnlineEntityCandidates,
  type OnlineEntityPage,
  type OnlineMusicInfo,
  type SourceId
} from '@shared/types'
import { safeFetchText } from './url-guard'
import type { OnlineCapability } from './platform-registry'

const WY_HOST = 'music.163.com'
const PAGE_SIZE = ONLINE_ENTITY_PAGE_SIZE
const MAX_DETAIL_BYTES = 4 * 1024 * 1024
const ALBUM_CACHE_TTL_MS = 60_000
const ALBUM_CACHE_ENTRIES = 20

type EntityKind = 'artist' | 'album'
type CandidateRef = OnlineArtistRef | OnlineAlbumRef

export interface OnlineEntityDetailsOptions {
  allows: (source: SourceId, capability: OnlineCapability) => boolean
  searchTracks: (
    source: SourceId,
    keyword: string,
    page: number,
    signal?: AbortSignal
  ) => Promise<{ list?: OnlineMusicInfo[]; servedBy?: string; message?: string }>
  fetchText?: typeof safeFetchText
}

interface ParsedAlbum {
  entity: OnlineAlbumRef
  tracks: OnlineMusicInfo[]
  truncated: boolean
}

/** Source-scoped artist and album details. Only `wy` has a verified exact-ID adapter. */
export class OnlineEntityDetails {
  private readonly allows: OnlineEntityDetailsOptions['allows']
  private readonly searchTracks: OnlineEntityDetailsOptions['searchTracks']
  private readonly fetchText: typeof safeFetchText
  private readonly albumCache = new Map<string, { expiresAt: number; value: ParsedAlbum }>()

  constructor(options: OnlineEntityDetailsOptions) {
    this.allows = options.allows
    this.searchTracks = options.searchTracks
    this.fetchText = options.fetchText ?? safeFetchText
  }

  async artistPage(source: SourceId, id: string, page = 1, signal?: AbortSignal): Promise<OnlineEntityPage<OnlineArtistRef>> {
    if (source !== 'wy') return unavailablePage(page, '该平台的精确艺术家详情尚未开放。')
    if (!this.allows(source, 'artistDetail')) return unavailablePage(page, '请启用并验证对应平台的 LX 音源，并同意在线目录请求。')
    if (!isEntityId(id)) return unavailablePage(page, '缺少有效的艺术家平台 ID。')
    if (!Number.isInteger(page) || page < 1 || page > ONLINE_ARTIST_MAX_PAGES) {
      return unavailablePage(page, '艺术家曲目页码超出范围。')
    }

    const offset = (page - 1) * PAGE_SIZE
    const url = `https://${WY_HOST}/api/v1/artist/songs?${new URLSearchParams({
      id,
      limit: String(PAGE_SIZE),
      offset: String(offset)
    })}`

    try {
      const payload = parseJson(await this.fetchJson(url, signal))
      if (!payload || payload.code !== 200 || !Array.isArray(payload.songs)) {
        return unavailablePage(page, '网易云没有返回可验证的艺术家曲目。')
      }

      const songs = payload.songs.map((row) => wySongToInfo(row)).filter(isOnlineTrack)
      const artist = readArtist(payload.artist)
        ?? songs.flatMap((track) => track.artistRefs ?? []).find((item) => item.id === id)
      if (!artist || artist.id !== id) {
        return unavailablePage(page, '返回结果无法与请求的艺术家 ID 对应。')
      }

      const tracks = songs.filter((track) => track.artistRefs?.some((item) => item.id === id))
      const total = nonNegativeInteger(payload.total)
        ?? offset + tracks.length + (payload.more === true ? PAGE_SIZE : 0)
      const hasMore = (typeof payload.more === 'boolean' ? payload.more : offset + tracks.length < total)
        && page < ONLINE_ARTIST_MAX_PAGES
      return {
        status: 'available',
        entity: artist,
        tracks,
        page,
        total,
        hasMore,
        ...(page === ONLINE_ARTIST_MAX_PAGES && payload.more === true ? { truncated: true } : {})
      }
    } catch (error) {
      return unavailablePage(page, `艺术家详情暂时不可用：${safeError(error)}`)
    }
  }

  async albumPage(source: SourceId, id: string, page = 1, signal?: AbortSignal): Promise<OnlineEntityPage<OnlineAlbumRef>> {
    if (source !== 'wy') return unavailablePage(page, '该平台的精确专辑详情尚未开放。')
    if (!this.allows(source, 'albumDetail')) return unavailablePage(page, '请启用并验证对应平台的 LX 音源，并同意在线目录请求。')
    if (!isEntityId(id)) return unavailablePage(page, '缺少有效的专辑平台 ID。')
    if (!Number.isInteger(page) || page < 1 || page > ONLINE_ALBUM_MAX_PAGES) {
      return unavailablePage(page, '专辑曲目页码超出范围。')
    }

    try {
      const album = await this.loadAlbum(id, signal)
      if (!album) return unavailablePage(page, '返回结果无法与请求的专辑 ID 对应。')

      const offset = (page - 1) * PAGE_SIZE
      return {
        status: 'available',
        entity: album.entity,
        tracks: album.tracks.slice(offset, offset + PAGE_SIZE),
        page,
        total: album.tracks.length,
        hasMore: offset + PAGE_SIZE < album.tracks.length,
        ...(album.truncated ? { truncated: true } : {})
      }
    } catch (error) {
      return unavailablePage(page, `专辑详情暂时不可用：${safeError(error)}`)
    }
  }

  artistCandidates(source: SourceId, query: string, signal?: AbortSignal): Promise<OnlineEntityCandidates<OnlineArtistRef>> {
    return this.candidates('artist', source, query, signal)
  }

  albumCandidates(source: SourceId, query: string, signal?: AbortSignal): Promise<OnlineEntityCandidates<OnlineAlbumRef>> {
    return this.candidates('album', source, query, signal)
  }

  private async candidates<T extends CandidateRef>(
    kind: EntityKind,
    source: SourceId,
    query: string,
    signal?: AbortSignal
  ): Promise<OnlineEntityCandidates<T>> {
    if (typeof query !== 'string') {
      return unavailableCandidates('', '候选名称格式无效。')
    }
    const trimmed = query.trim().slice(0, 120)
    if (source !== 'wy') return unavailableCandidates(trimmed, '该平台尚无可验证的详情候选搜索。')
    if (!trimmed) return unavailableCandidates('', '请输入名称以查找候选项。')
    if (!this.allows(source, 'search')) {
      return unavailableCandidates(trimmed, '请启用并验证对应平台的 LX 音源，并同意在线目录请求。')
    }

    try {
      const result = await this.searchTracks(source, trimmed, 1, signal)
      if (result.servedBy === 'none') {
        return unavailableCandidates(trimmed, result.message || '平台候选搜索暂时不可用。')
      }

      const found = new Map<string, CandidateRef>()
      for (const track of result.list ?? []) {
        if (track.source !== source) continue
        const refs: CandidateRef[] = kind === 'artist'
          ? track.artistRefs ?? []
          : track.albumRef ? [track.albumRef] : []
        for (const ref of refs) {
          if (!ref.id || !matchesQuery(ref.name, trimmed)) continue
          const key = ref.id
          if (!found.has(key)) found.set(key, ref)
        }
      }
      return {
        status: 'candidates',
        query: trimmed,
        candidates: [...found.values()] as T[],
        ...(found.size ? {} : { message: `没有找到「${trimmed}」的${kind === 'artist' ? '艺术家' : '专辑'}候选，请换一个名称。` })
      }
    } catch (error) {
      return unavailableCandidates(trimmed, `候选搜索暂时不可用：${safeError(error)}`)
    }
  }

  private async loadAlbum(id: string, signal?: AbortSignal): Promise<ParsedAlbum | null> {
    const cached = this.albumCache.get(id)
    if (cached && cached.expiresAt > Date.now()) return cached.value
    if (cached) this.albumCache.delete(id)

    const url = `https://${WY_HOST}/api/v1/album/${encodeURIComponent(id)}?id=${encodeURIComponent(id)}`
    const payload = parseJson(await this.fetchJson(url, signal))
    if (!payload || payload.code !== 200 || !Array.isArray(payload.songs)) return null
    const albumRecord = asRecord(payload.album)
    const albumId = readId(albumRecord.id)
    const albumName = readName(albumRecord.name)
    if (albumId !== id || !albumName) return null

    const albumArtists = readArtists(albumRecord.artists ?? albumRecord.artist)
    const entity: OnlineAlbumRef = {
      id,
      name: albumName,
      ...readImage(albumRecord.picUrl ?? albumRecord.blurPicUrl, 'coverUrl'),
      ...(albumArtists.length ? { artistRefs: albumArtists } : {})
    }

    const tracks = uniqueTracks(payload.songs
      .map((row) => wySongToInfo(row, entity))
      .filter(isOnlineTrack))
      .slice(0, ONLINE_ALBUM_MAX_TRACKS)
    const value: ParsedAlbum = { entity, tracks, truncated: payload.songs.length > ONLINE_ALBUM_MAX_TRACKS }
    while (this.albumCache.size >= ALBUM_CACHE_ENTRIES) {
      const oldest = this.albumCache.keys().next().value as string | undefined
      if (!oldest) break
      this.albumCache.delete(oldest)
    }
    this.albumCache.set(id, { value, expiresAt: Date.now() + ALBUM_CACHE_TTL_MS })
    return value
  }

  private async fetchJson(url: string, signal?: AbortSignal): Promise<unknown> {
    const text = await this.fetchText(url, {
      allowedHosts: [WY_HOST],
      maxBytes: MAX_DETAIL_BYTES,
      headers: { Referer: 'https://music.163.com/' },
      ...(signal ? { init: { signal } } : {})
    })
    return JSON.parse(text) as unknown
  }
}

function wySongToInfo(value: unknown, albumOverride?: OnlineAlbumRef): OnlineMusicInfo | null {
  const row = asRecord(value)
  const id = readId(row.id)
  const name = readName(row.name ?? row.title)
  if (!id || !name) return null

  const albumRecord = asRecord(row.al ?? row.album)
  const artistRefs = readArtists(row.artists ?? row.ar)
  const albumArtists = artistRefs.length ? artistRefs : albumOverride?.artistRefs ?? []
  const albumId = readId(albumRecord.id) ?? albumOverride?.id
  const albumName = readName(albumRecord.name) ?? albumOverride?.name ?? ''
  const picUrl = readName(albumRecord.picUrl ?? albumRecord.blurPicUrl) ?? albumOverride?.coverUrl ?? ''
  const albumRef: OnlineAlbumRef | undefined = albumOverride ?? (albumId && albumName ? {
    id: albumId,
    name: albumName,
    ...(picUrl ? { coverUrl: picUrl } : {}),
    ...(albumArtists.length ? { artistRefs: albumArtists } : {})
  } : undefined)
  const duration = nonNegativeInteger(row.dt ?? row.duration)

  return {
    id: `wy_${id}`,
    name,
    singer: albumArtists.map((artist) => artist.name).join('、'),
    source: 'wy',
    ...(duration ? { interval: toInterval(duration > 10_000 ? duration / 1000 : duration) } : {}),
    albumName,
    ...(albumArtists.length ? { artistRefs: albumArtists } : {}),
    ...(albumRef ? { albumRef } : {}),
    ...(picUrl ? { picUrl } : {}),
    meta: { songmid: id, ...(albumId ? { albumId } : {}), qualitys: [] }
  }
}

function readArtists(value: unknown): OnlineArtistRef[] {
  if (Array.isArray(value)) {
    return value.flatMap((item) => {
      const row = asRecord(item)
      const name = readName(row.name)
      if (!name) return []
      const id = readId(row.id)
      const pictureUrl = readName(row.picUrl ?? row.img1v1Url)
      return [{ name, ...(id ? { id } : {}), ...(pictureUrl ? { pictureUrl } : {}) }]
    })
  }
  const row = asRecord(value)
  const name = readName(row.name)
  if (!name) return []
  const id = readId(row.id)
  const pictureUrl = readName(row.picUrl ?? row.img1v1Url)
  return [{ name, ...(id ? { id } : {}), ...(pictureUrl ? { pictureUrl } : {}) }]
}

function readArtist(value: unknown): OnlineArtistRef | undefined {
  const artist = readArtists(value)[0]
  return artist?.id ? artist : undefined
}

function readImage(value: unknown, key: 'coverUrl'): Partial<OnlineAlbumRef> {
  const url = readName(value)
  return url ? { [key]: url } : {}
}

function uniqueTracks(tracks: OnlineMusicInfo[]): OnlineMusicInfo[] {
  const seen = new Set<string>()
  return tracks.filter((track) => {
    if (seen.has(track.id)) return false
    seen.add(track.id)
    return true
  })
}

function isOnlineTrack(value: OnlineMusicInfo | null): value is OnlineMusicInfo {
  return value !== null
}

function unavailablePage<T>(page: number, message: string): OnlineEntityPage<T> {
  return { status: 'unavailable', tracks: [], page: Number.isInteger(page) ? page : 1, total: 0, hasMore: false, message }
}

function unavailableCandidates<T>(query: string, message: string): OnlineEntityCandidates<T> {
  return { status: 'unavailable', query, candidates: [], message }
}

function isEntityId(value: unknown): value is string {
  return typeof value === 'string' && /^\d{1,20}$/.test(value)
}

function readId(value: unknown): string | undefined {
  if (typeof value !== 'string' && typeof value !== 'number') return undefined
  const id = String(value)
  return /^\d{1,20}$/.test(id) ? id : undefined
}

function readName(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim().slice(0, 300) : undefined
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function parseJson(value: unknown): Record<string, any> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  return value as Record<string, any>
}

function nonNegativeInteger(value: unknown): number | undefined {
  const parsed = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : undefined
}

function matchesQuery(name: string, query: string): boolean {
  const normalise = (value: string) => value.normalize('NFKC').toLocaleLowerCase().replace(/[\s·•,，、.。!！?？_-]+/g, '')
  const candidate = normalise(name)
  const wanted = normalise(query)
  return candidate.includes(wanted) || wanted.includes(candidate)
}

function toInterval(seconds: number): string {
  const total = Math.round(seconds)
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`
}

function safeError(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error)
  return text.replace(/[\r\n]+/g, ' ').slice(0, 160)
}
