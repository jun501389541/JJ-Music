/**
 * Online search adapters.
 *
 * ## Why this exists separately from the 音源 engine
 *
 * A custom 音源 script can only resolve a *playback URL* — the LX custom-source
 * API exposes exactly three actions (`musicUrl`, `lyric`, `pic`) and no search.
 * Search is implemented by the host application against each platform's public
 * web endpoints. This module is that host-side half.
 *
 * ## Legal / ethical note — read before enabling
 *
 * These adapters query publicly reachable endpoints that ordinary web clients
 * use; they are written clean-room from observed HTTP responses and share no
 * code with any existing player. This is nevertheless the same category of
 * functionality that led to a rights-holder complaint against LX Music in
 * October 2023, after which that project removed all built-in sources.
 *
 * The design therefore treats them as **optional and user-enabled**:
 *  - the feature is off until the user turns it on in Settings;
 *  - nothing is downloaded automatically;
 *  - the 音源 path remains the primary, user-supplied mechanism.
 *
 * If you redistribute this software, review your own position first.
 */
import vm from 'node:vm'
import type { OnlineMusicInfo, Quality, SourceId } from '@shared/types'
import { readBounded } from './read-bounded'

/** Shared HTTP helper with a browser-ish UA and a hard timeout. */
const DEFAULT_TIMEOUT_MS = 12_000

/** A search page is tens of kilobytes; this is room to grow, not a soft cap. */
const SEARCH_MAX_BYTES = 4 * 1024 * 1024

const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'

interface FetchOptions {
  headers?: Record<string, string>
  timeoutMs?: number
}

async function httpGet(url: string, options: FetchOptions = {}): Promise<string> {
  const controller = new AbortController()
  const timeout = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const timer = setTimeout(() => controller.abort(), timeout)
  try {
    const response = await fetch(url, {
      headers: {
        'User-Agent': BROWSER_UA,
        Accept: 'application/json, text/plain, */*',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
        ...options.headers
      },
      redirect: 'follow',
      signal: controller.signal
    })
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} ${response.statusText}`)
    }
    // Bounded rather than `response.text()`: the destination here is a host we
    // chose, but the size still comes from someone else's answer.
    return (await readBounded(response, SEARCH_MAX_BYTES)).toString('utf8')
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Parse a JavaScript object literal into a plain object.
 *
 * The Kuwo mobile endpoint returns `{'key':'value',...}` — valid JS, invalid
 * JSON. Evaluating it in an empty `vm` context with a short timeout parses it
 * without exposing any globals to the payload, which a bare `new Function`
 * would.
 *
 * The sandbox must stay a null-prototype object. A plain `{}` is contextified
 * over the *host* realm's `Object.prototype`, so `this.constructor.constructor`
 * becomes the main process's own `Function` and the response text — which is
 * someone else's bytes — could read `process`. Exported so the offline suite
 * pins that; see `lyrics-search.test.mts`.
 */
export function parseObjectLiteral(text: string): unknown {
  const sandbox = Object.create(null) as Record<string, unknown>
  return vm.runInNewContext(`(${text})`, sandbox, { timeout: 1000 })
}

/** Format seconds as `mm:ss`. */
function toInterval(seconds: number | string | undefined): string | undefined {
  const value = typeof seconds === 'string' ? Number.parseFloat(seconds) : seconds
  if (!value || Number.isNaN(value) || value <= 0) return undefined
  const total = Math.round(value)
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`
}

/**
 * What an adapter knows about one tier.
 *
 * A number is a real byte count. `true` means "this tier exists but its size is
 * unknown" — kw and kg answer with hashes and a `FORMATS` list, not byte counts,
 * and Migu's floor tier is declared before any format row is read. Those used to
 * be written as the literal `1`, which is a *valid* small number and therefore
 * rendered as the string `0.00 MB`: a size nobody measured, published as if
 * someone had. `size` is optional on the descriptor, so the honest encoding is
 * to leave it off rather than to invent a value for it.
 */
type SizeHint = number | true | undefined

/** Build the quality descriptor list from size information. */
function buildQualitys(sizes: Partial<Record<Quality | 'hires', SizeHint>>): Array<{
  type: string
  size?: string
}> {
  const out: Array<{ type: string; size?: string }> = []
  const push = (type: string, hint: SizeHint): void => {
    if (hint === undefined) return
    if (hint === true) {
      out.push({ type })
      return
    }
    // A platform that reports `0` means "not this tier", and a `NaN` out of a
    // malformed field is not a size either; neither may become `NaN MB`.
    if (!Number.isFinite(hint) || hint <= 0) return
    out.push({ type, size: `${(hint / 1024 / 1024).toFixed(2)} MB` })
  }
  push('128k', sizes['128k'])
  push('320k', sizes['320k'])
  push('flac', sizes.flac)
  // LX has no `hires` tier; Hi-Res maps onto `flac24bit`.
  push('flac24bit', sizes.flac24bit ?? sizes.hires)
  return out
}

export interface SearchPage {
  list: OnlineMusicInfo[]
  total?: number
  allPage?: number
}

/** A pluggable per-platform search implementation. */
export interface SearchProvider {
  id: SourceId
  name: string
  search(keyword: string, page: number): Promise<SearchPage>
}

/* ------------------------------------------------------------------ *
 * QQ 音乐 (tx)
 * ------------------------------------------------------------------ */

/** Shape of a `client_search_cp` song entry, narrowed to what we read. */
interface TencentSong {
  mid?: string
  id?: number
  name?: string
  title?: string
  interval?: number
  singer?: Array<{ name?: string }>
  album?: { mid?: string; id?: number; name?: string; title?: string }
  file?: {
    media_mid?: string
    strMediaMid?: string
    size_128mp3?: number
    size_320mp3?: number
    size_flac?: number
    size_hires?: number
  }
}

const tencentProvider: SearchProvider = {
  id: 'tx',
  name: 'QQ音乐',
  async search(keyword, page) {
    const url =
      'https://c.y.qq.com/soso/fcgi-bin/client_search_cp?' +
      new URLSearchParams({
        w: keyword,
        p: String(page),
        n: '20',
        cr: '1',
        new_json: '1',
        format: 'json',
        t: '0'
      }).toString()

    const text = await httpGet(url, { headers: { Referer: 'https://y.qq.com/' } })
    const payload = JSON.parse(text) as {
      data?: { song?: { list?: TencentSong[]; totalnum?: number } }
    }
    const song = payload.data?.song
    const list = song?.list ?? []
    const total = song?.totalnum ?? list.length

    return {
      list: list.map((item): OnlineMusicInfo => {
        const file = item.file ?? {}
        const mid = item.mid ?? ''
        const meta: OnlineMusicInfo['meta'] = {
          songmid: mid,
          songId: item.id,
          strMediaMid: file.media_mid ?? file.strMediaMid ?? '',
          albumId: item.album?.id,
          albumMid: item.album?.mid ?? '',
          qualitys: buildQualitys({
            '128k': file.size_128mp3,
            '320k': file.size_320mp3,
            flac: file.size_flac,
            hires: file.size_hires
          })
        }
        return {
          id: `tx_${mid}`,
          name: item.name ?? item.title ?? '',
          singer: (item.singer ?? []).map((s) => s.name ?? '').filter(Boolean).join('、'),
          source: 'tx',
          interval: toInterval(item.interval),
          albumName: item.album?.name ?? item.album?.title ?? '',
          picUrl: item.album?.mid
            ? `https://y.gtimg.cn/music/photo_new/T002R500x500M000${item.album.mid}.jpg`
            : '',
          meta
        }
      }),
      total,
      allPage: Math.max(1, Math.ceil(total / 20))
    }
  }
}

/* ------------------------------------------------------------------ *
 * 网易云音乐 (wy)
 * ------------------------------------------------------------------ */

interface NeteaseSong {
  id?: number
  name?: string
  duration?: number
  artists?: Array<{ name?: string }>
  album?: { id?: number; name?: string; picId?: number; picUrl?: string }
  fee?: number
}

/**
 * Fetch real cover URLs from NetEase's detail endpoint.
 *
 * ## Why this is needed
 *
 * The search endpoint returns only `album.picId`, never a URL. The intuitive
 * rule — build `p2.music.126.net/<picId>/<picId>.jpg` — returns **404 for every
 * track**, because the first path segment of a real NetEase image URL is a
 * server-side encrypted id that cannot be derived from `picId`.
 *
 * The detail endpoint (`/api/song/detail`) *does* return the authoritative
 * `picUrl`. Verified against live data: search gave no `picUrl`, the detail call
 * returned a working 951 KB JPEG. Covers are therefore resolved lazily, one
 * request per track, rather than during search.
 */
/** What NetEase's detail endpoint tells us about one track, from a single batch call. */
export interface NeteaseDetail {
  picUrl: string
  qualitys: Array<{ type: string; size?: string }>
}

/**
 * The four tiers `/api/song/detail` reports. `mMusic` is 192k, which has no tier in
 * our ladder, so it is dropped rather than rounded onto a neighbour.
 */
const NETEASE_TIERS: Array<readonly [string, Quality]> = [
  ['lMusic', '128k'],
  ['hMusic', '320k'],
  ['sqMusic', 'flac'],
  ['hrMusic', 'flac24bit']
]

/**
 * Fetch cover URLs **and real quality availability** from NetEase's detail endpoint.
 *
 * ## Why this is needed
 *
 * The search endpoint returns only `album.picId`, never a URL. The intuitive
 * rule — build `p2.music.126.net/<picId>/<picId>.jpg` — returns **404 for every
 * track**, because the first path segment of a real NetEase image URL is a
 * server-side encrypted id that cannot be derived from `picId`.
 *
 * The detail endpoint (`/api/song/detail`) *does* return the authoritative
 * `picUrl`. Verified against live data: search gave no `picUrl`, the detail call
 * returned a working 951 KB JPEG. Covers are therefore resolved lazily, one
 * request per track, rather than during search.
 *
 * ## Why qualitys come out of this same call
 *
 * The search row used to declare `128k / 320k / flac` unconditionally, because
 * availability is only exposed per track and the ladder would probe it anyway. That
 * was harmless while nothing displayed it — and a lie the moment a quality badge got
 * added, since every 网易云 result would then read as lossless. The same response this
 * function already consumes carries `lMusic/hMusic/sqMusic/hrMusic`, each with a real
 * byte `size`, so availability comes from the same request: **no extra call**.
 *
 * Only a field that is present *and* has `size > 0` counts as available.
 */
/**
 * One id list, in batches of 100.
 *
 * The cap lives here rather than in each caller so no list size can turn into one
 * enormous query string: a 5 000-track playlist would otherwise send ~20 KB of ids
 * and the endpoint's answer is not guaranteed to survive that. 100 is what the cover
 * path has always used.
 */
const NETEASE_DETAIL_BATCH = 100

export async function fetchNeteaseDetails(ids: number[]): Promise<Map<number, NeteaseDetail>> {
  const out = new Map<number, NeteaseDetail>()
  const unique = [...new Set(ids.filter((id) => Number.isFinite(id) && id > 0))]
  for (let offset = 0; offset < unique.length; offset += NETEASE_DETAIL_BATCH) {
    const batch = await fetchNeteaseDetailBatch(unique.slice(offset, offset + NETEASE_DETAIL_BATCH))
    for (const [id, detail] of batch) out.set(id, detail)
  }
  return out
}

async function fetchNeteaseDetailBatch(ids: number[]): Promise<Map<number, NeteaseDetail>> {
  const out = new Map<number, NeteaseDetail>()
  if (ids.length === 0) return out

  const url =
    'https://music.163.com/api/song/detail?' +
    // The endpoint expects a JSON array of ids.
    new URLSearchParams({ ids: JSON.stringify(ids), id: String(ids[0]) }).toString()

  try {
    const text = await httpGet(url, { headers: { Referer: 'https://music.163.com/' } })
    const json = JSON.parse(text) as {
      songs?: Array<{
        id?: number
        album?: { picUrl?: string }
      } & Partial<Record<string, { size?: number | string } | null>>>
    }
    for (const song of json.songs ?? []) {
      if (!song.id) continue
      const pic = song.album?.picUrl
      const sizes: Partial<Record<Quality | 'hires', number>> = {}
      for (const [field, tier] of NETEASE_TIERS) {
        const bytes = Number(song[field]?.size ?? 0)
        if (Number.isFinite(bytes) && bytes > 0) sizes[tier] = bytes
      }
      if (!pic && !Object.keys(sizes).length) continue
      out.set(song.id, {
        // Ask the CDN to downscale; the originals are often multi-megabyte.
        picUrl: pic ? `${pic}${pic.includes('?') ? '&' : '?'}param=300y300` : '',
        qualitys: buildQualitys(sizes)
      })
    }
  } catch {
    /* A failed detail lookup is not an error the UI should surface. */
  }
  return out
}

const neteaseProvider: SearchProvider = {
  id: 'wy',
  name: '网易云音乐',
  async search(keyword, page) {
    const offset = (page - 1) * 20
    const url =
      'https://music.163.com/api/search/get/web?' +
      new URLSearchParams({
        s: keyword,
        type: '1',
        offset: String(offset),
        limit: '20'
      }).toString()

    const text = await httpGet(url, { headers: { Referer: 'https://music.163.com/' } })
    const payload = JSON.parse(text) as {
      result?: { songs?: NeteaseSong[]; songCount?: number }
    }
    const songs = payload.result?.songs ?? []
    const total = payload.result?.songCount ?? songs.length

    // One batch call for the page: cover URLs *and* which tiers each track actually
    // has. Both used to be guessed here — covers because the search response omits
    // them, qualities because availability is per-track only.
    const details = await fetchNeteaseDetails(
      songs.map((s) => Number(s.id)).filter((id) => Number.isFinite(id) && id > 0)
    )

    return {
      list: songs.map((item): OnlineMusicInfo => {
        const id = String(item.id ?? '')
        const picUrl = item.album?.picUrl ?? details.get(Number(id))?.picUrl ?? ''
        return {
          id: `wy_${id}`,
          name: item.name ?? '',
          singer: (item.artists ?? []).map((a) => a.name ?? '').filter(Boolean).join('、'),
          source: 'wy',
          interval: toInterval(item.duration ? item.duration / 1000 : undefined),
          albumName: item.album?.name ?? '',
          picUrl,
          meta: {
            songmid: id,
            albumId: item.album?.id,
            // What this track really has, from the same detail call. An empty list is
            // a real answer (some tracks have no listed tier at all) and must stay
            // empty: the badge renders nothing for it rather than inventing one.
            qualitys: details.get(Number(id))?.qualitys ?? []
          }
        }
      }),
      total,
      allPage: Math.max(1, Math.ceil(total / 20))
    }
  }
}

/* ------------------------------------------------------------------ *
 * 酷我音乐 (kw)
 * ------------------------------------------------------------------ */

interface KuwoSong {
  DC_TARGETID?: string
  MUSICRID?: string
  NAME?: string
  ARTIST?: string
  ALBUM?: string
  ALBUMID?: string
  DURATION?: string
  web_albumpic_short?: string
  FORMATS?: string
}

const kuwoProvider: SearchProvider = {
  id: 'kw',
  name: '酷我音乐',
  async search(keyword, page) {
    // `pn` is zero-based on this endpoint.
    const url =
      'https://search.kuwo.cn/r.s?' +
      new URLSearchParams({
        all: keyword,
        ft: 'music',
        itemset: 'web_2013',
        client: 'kt',
        pn: String(Math.max(0, page - 1)),
        rn: '20',
        rformat: 'json',
        encoding: 'utf8'
      }).toString()

    const text = await httpGet(url, { headers: { Referer: 'http://www.kuwo.cn/' } })
    const payload = parseObjectLiteral(text) as {
      abslist?: KuwoSong[]
      TOTAL?: string
    }
    const list = payload.abslist ?? []
    const total = payload.TOTAL ? Number.parseInt(payload.TOTAL, 10) : list.length

    return {
      list: list
        // The endpoint pads results with ad/placeholder rows that lack an id.
        .filter((item) => item.DC_TARGETID || item.MUSICRID)
        .map((item): OnlineMusicInfo => {
          // `MUSICRID` looks like `MUSIC_62355680`; the bare id is the songmid.
          const rawRid = item.MUSICRID ?? ''
          const songmid = (item.DC_TARGETID || rawRid.replace(/^MUSIC_/, '')).trim()
          return {
            id: `kw_${songmid}`,
            name: (item.NAME ?? '').replace(/&nbsp;/g, ' ').trim(),
            singer: (item.ARTIST ?? '').trim(),
            source: 'kw',
            interval: toInterval(item.DURATION),
            albumName: (item.ALBUM ?? '').trim(),
            picUrl: item.web_albumpic_short
              ? `https://img1.kuwo.cn/star/albumcover/${item.web_albumpic_short}`
              : '',
            meta: {
              songmid,
              albumId: item.ALBUMID,
              qualitys: buildQualitys({
                '128k': true,
                '320k': item.FORMATS?.includes('MP3H') || item.FORMATS?.includes('320') ? true : undefined,
                flac: item.FORMATS?.includes('FLAC') ? true : undefined
              })
            }
          }
        }),
      total,
      allPage: Math.max(1, Math.ceil(total / 20))
    }
  }
}

/* ------------------------------------------------------------------ *
 * 酷狗音乐 (kg)
 * ------------------------------------------------------------------ */

/**
 * Kugou search.
 *
 * The `complexsearch` endpoint requires a signature, but `songsearch_v2` does
 * not and returns the same fields (verified live: HTTP 200, ~19 KB JSON with
 * `HQFileHash` / `SQFileHash` per track). The hash is what a 音源 needs to
 * resolve audio — `songmid` alone is an Audioid and is *not* sufficient, so the
 * hashes are stored in `meta` alongside the usual fields.
 */
interface KugouSong {
  FileHash?: string
  SongName?: string
  SingerName?: string
  AlbumName?: string
  AlbumID?: string | number
  Duration?: number
  MixSongID?: string | number
  Audioid?: string | number
  HQFileHash?: string
  SQFileHash?: string
  ResFileHash?: string
  OriSongName?: string
  Image?: string
}

const kugouProvider: SearchProvider = {
  id: 'kg',
  name: '酷狗音乐',
  async search(keyword, page) {
    const url =
      'https://songsearch.kugou.com/song_search_v2?' +
      new URLSearchParams({
        keyword,
        page: String(Math.max(1, page)),
        pagesize: '20'
      }).toString()

    const text = await httpGet(url, { headers: { Referer: 'https://www.kugou.com/' } })
    const payload = JSON.parse(text) as {
      data?: { lists?: KugouSong[]; total?: number }
    }
    const list = payload.data?.lists ?? []
    const total = payload.data?.total ?? list.length

    return {
      list: list.map((item): OnlineMusicInfo => {
        const songmid = String(item.MixSongID ?? item.Audioid ?? '')
        // Album art comes as a template URL with `{size}` to substitute.
        const picUrl = item.Image ? item.Image.replace('{size}', '240') : ''
        return {
          id: `kg_${songmid}`,
          name: (item.SongName ?? item.OriSongName ?? '').replace(/<[^>]*>/g, '').trim(),
          singer: (item.SingerName ?? '').replace(/<[^>]*>/g, '').trim(),
          source: 'kg',
          interval: toInterval(item.Duration),
          albumName: (item.AlbumName ?? '').replace(/<[^>]*>/g, '').trim(),
          picUrl,
          meta: {
            songmid,
            // kg resolves audio by hash, not by id. Storing the highest
            // available hash lets a source pick the right file.
            hash: item.FileHash ?? '',
            albumId: item.AlbumID,
            qualitys: buildQualitys({
              '128k': true,
              '320k': item.HQFileHash ? true : undefined,
              flac: item.SQFileHash ? true : undefined
            })
          }
        }
      }),
      total,
      allPage: Math.max(1, Math.ceil(total / 20))
    }
  }
}

/* ------------------------------------------------------------------ *
 * 咪咕音乐 (mg)
 * ------------------------------------------------------------------ */

/**
 * Migu search.
 *
 * This is the endpoint the v5 web player calls itself, discovered by observing
 * its traffic rather than from documentation. Verified live before wiring in:
 * HTTP 200 with `text=周杰伦`, from plain `curl` — no cookie, no app key and no
 * request signature. Migu's older mobile route (`m.music.migu.cn/migu/remoting/
 * scr_search_tag`, which many adapters still use) is **dead**: it now 301s to the
 * H5 home page and returns HTML.
 *
 * Three quirks to know before editing this:
 *  - `pageSize` is ignored; a page is always 20 items.
 *  - the body is a bare array with no envelope, so there is no total. `pageNo`
 *    does advance correctly (pages 1/2/3 measured with zero id overlap), so
 *    `allPage` is a fixed depth cap. Omitting it instead would hide the pager
 *    for this platform alone, because `SearchView` falls back to `?? 1`.
 *  - nearly every format carries a `vip` tag and `restrictType: 1`, so search
 *    succeeding says nothing about playback. Playback is resolved by a 音源
 *    script regardless — see the note in `lyrics.ts`.
 */
export interface MiguSong {
  songId?: number | string
  contentId?: string
  copyrightId?: string
  songName?: string
  album?: string
  albumId?: number | string
  duration?: number
  img1?: string
  img2?: string
  lrcUrl?: string
  mrcUrl?: string
  singerList?: Array<{ id?: string; name?: string }>
  audioFormats?: Array<{ formatType?: string; isize?: string; asize?: string }>
}

/** Migu's tier names, mapped onto the four tiers LX understands. */
const MG_FORMAT_TO_QUALITY: Record<string, Quality> = {
  PQ: '128k',
  HQ: '320k',
  SQ: 'flac',
  ZQ24: 'flac24bit'
}
// `Z3D` and `AV3A` also appear. They are 3D-audio and Audio-Vivid renders with
// no LX equivalent, so they are deliberately left unmapped rather than folded
// into `flac24bit`, which would offer a file the player cannot decode.

const MG_IMAGE_HOST = 'https://d.musicapp.migu.cn'

/** No total is available, so paging is capped at this depth instead. */
const MG_MAX_PAGE = 25

/**
 * Map one Migu search row onto the app's track shape.
 *
 * Exported so the mapping is testable offline: the live loop in
 * `lyrics-search.test.mts` only proves the endpoint answered, not that a tier
 * like `SQ` became `flac` or that `Z3D` stayed out of the ladder.
 */
export function miguSongToInfo(item: MiguSong): OnlineMusicInfo {
  const sizes: Partial<Record<Quality, SizeHint>> = {}
  for (const format of item.audioFormats ?? []) {
    const tier = format.formatType ? MG_FORMAT_TO_QUALITY[format.formatType] : undefined
    if (!tier) continue
    const bytes = Number.parseInt(format.isize ?? format.asize ?? '', 10)
    if (Number.isFinite(bytes) && bytes > 0) sizes[tier] = bytes
  }
  // The other adapters declare the floor tier unconditionally and let the ladder
  // probe it; do the same so an empty list never results. `true` = the tier is
  // claimed but its size is not known, so the descriptor carries no `size`
  // instead of the `0.00 MB` the old literal `1` produced.
  sizes['128k'] = sizes['128k'] ?? true

  const songId = String(item.songId ?? '')
  const cover = item.img2 ?? item.img1 ?? ''
  return {
    id: `mg_${songId}`,
    name: (item.songName ?? '').trim(),
    singer: (item.singerList ?? []).map((s) => (s.name ?? '').trim()).filter(Boolean).join('、'),
    source: 'mg',
    interval: toInterval(item.duration),
    albumName: (item.album ?? '').trim(),
    // `img*` arrives as a bare path, not a URL.
    picUrl: cover.startsWith('/') ? `${MG_IMAGE_HOST}${cover}` : cover,
    meta: {
      songmid: songId,
      songId: item.songId,
      // Migu's resolvers key on `copyrightId` (see ARCHITECTURE §1.3); `songmid`
      // keeps the short id so a script's `hash ?? songmid ?? id` fallback still
      // finds something usable.
      copyrightId: item.copyrightId ? String(item.copyrightId) : undefined,
      albumId: item.albumId,
      contentId: item.contentId,
      // Carried through so the lyric lookup costs nothing extra; the
      // custom-source API cannot supply lyrics for an online track.
      lrcUrl: item.lrcUrl,
      mrcUrl: item.mrcUrl,
      qualitys: buildQualitys(sizes)
    }
  }
}

const miguProvider: SearchProvider = {
  id: 'mg',
  name: '咪咕音乐',
  async search(keyword, page) {
    const url =
      'https://app.u.nf.migu.cn/pc/resource/song/item/search/v1.0?' +
      new URLSearchParams({
        text: keyword,
        pageNo: String(Math.max(1, page)),
        pageSize: '20'
      }).toString()

    const text = await httpGet(url, {
      headers: { Referer: 'https://music.migu.cn/', Origin: 'https://music.migu.cn' }
    })
    const payload = JSON.parse(text) as MiguSong[]
    // A bare array is the normal shape; an error envelope is not, and must not
    // turn into a page of empty rows.
    const list = Array.isArray(payload) ? payload : []

    return {
      list: list
        // Without either id the track cannot be resolved or looked up later.
        .filter((item) => item.songId || item.copyrightId)
        .map(miguSongToInfo),
      allPage: MG_MAX_PAGE
    }
  }
}

/* ------------------------------------------------------------------ *
 * Registry
 * ------------------------------------------------------------------ */

const PROVIDERS: SearchProvider[] = [tencentProvider, neteaseProvider, kuwoProvider, kugouProvider, miguProvider]

/** Platforms we can search without a user-supplied 音源 source. */
export function searchProviders(): Array<{ id: SourceId; name: string }> {
  return PROVIDERS.map((provider) => ({ id: provider.id, name: provider.name }))
}

export function hasSearchProvider(source: SourceId): boolean {
  return PROVIDERS.some((provider) => provider.id === source)
}

/**
 * Search one platform.
 *
 * A 音源 script's *playback* quality list is independent of search, so a user
 * can search here and still resolve the URL through their imported source.
 */
export async function searchOnline(
  source: SourceId,
  keyword: string,
  page = 1
): Promise<SearchPage> {
  const provider = PROVIDERS.find((item) => item.id === source)
  if (!provider) {
    throw new Error(`暂不支持搜索「${source}」，请先导入支持该平台的音源`)
  }
  const trimmed = keyword.trim()
  if (!trimmed) return { list: [], total: 0, allPage: 0 }
  return provider.search(trimmed, page)
}

/** Search every provider in parallel; failed platforms are reported, not fatal. */
export async function searchAll(
  keyword: string,
  page = 1
): Promise<Array<SearchPage & { source: SourceId; error?: string }>> {
  const results = await Promise.all(
    PROVIDERS.map(async (provider) => {
      try {
        const page_ = await provider.search(keyword.trim(), page)
        return { ...page_, source: provider.id }
      } catch (error) {
        return {
          source: provider.id,
          list: [] as OnlineMusicInfo[],
          error: error instanceof Error ? error.message : String(error)
        }
      }
    })
  )
  return results
}
