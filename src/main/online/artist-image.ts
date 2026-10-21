import type { SourceId } from '@shared/types'
import { readBounded } from './read-bounded'
import type { AuxiliaryRequests } from './auxiliary-requests'
import { onlineContext, onlineHttpFailure, OnlineRequestError } from './reliability-policy'

/**
 * Artist portraits.
 *
 * The library only knows the artist *name* from a file tag, so getting a photo
 * means searching each platform for that name and reading the artist id the song
 * rows already carry. Verified against the live endpoints on 2026-09-21:
 *
 *  - 咪咕: `singerList[].img` is already a picture — one request, no second call.
 *  - QQ: song rows carry `singer[].mid`, and `T001R300x300M000<mid>.jpg` is a
 *    public artist-photo URL — also one request.
 *  - 网易云: song rows give `artists[].id`; the photo needs `api/artist/{id}`.
 *    Its `picUrl` without a suffix is a 1.4 MB original, so a resize parameter
 *    is mandatory — an artist grid that pulls 470 of those is a stall.
 *  - 酷狗: `SingerId` then `singer/info` → `imgurl`, a `{size}` template.
 *  - 酷我: no reachable artist photo (its search endpoint returns no artist
 *    picture and the artist API wants a signed token), so it is not tried.
 *
 * 咪咕 is asked first because it answers fastest from here and needs no second
 * request; QQ's search host intermittently stalls on connect, which is exactly why
 * each platform below is tried in its own `try`.
 */

type Row = Record<string, any>

function isRecord(value: unknown): value is Row {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function responseRecord(value: unknown, endpoint: string): Row {
  if (!isRecord(value)) throw new SyntaxError(`artist image response has invalid ${endpoint} shape`)
  return value
}

function responseRows(value: unknown, endpoint: string): Row[] {
  if (!Array.isArray(value) || value.some(row => !isRecord(row))) {
    throw new SyntaxError(`artist image response has invalid ${endpoint} shape`)
  }
  return value
}

export interface ArtistImage {
  url: string
  source: SourceId
}

/** Case, spacing and full/half-width punctuation differences are noise. */
function normalize(value: string): string {
  return value.toLowerCase().replace(/[\s&＆、,，.。·・-]/g, '')
}

/**
 * Does this platform artist name refer to the artist we asked about?
 *
 * Substring matching is allowed only when both sides are at least three
 * characters: otherwise a two-character name like 「阿杜」 would happily match
 * 「阿杜的店」and the grid gets the wrong face.
 */
export function artistNameMatches(query: string, candidate: string): boolean {
  const a = normalize(query), b = normalize(candidate)
  if (!a || !b) return false
  if (a === b) return true
  return a.length >= 3 && b.length >= 3 && (b.includes(a) || a.includes(b))
}

/** 结尾带斜杠：咪咕给的是裸路径，拼接前会把开头的斜杠去掉。 */
const MG_IMAGE_BASE = 'https://d.musicapp.migu.cn/'

function absoluteMgImage(value: string): string {
  if (/^https?:\/\//i.test(value)) return value
  return `${MG_IMAGE_BASE}${value.replace(/^\/+/, '')}`
}

/**
 * Resolve one artist's portrait, trying the platforms in the order above.
 *
 * `http` is injectable so the mapping can be tested without touching the
 * network; `firstMatch` wins and later platforms are not consulted.
 *
 * Each platform is tried inside its own `try`, and each request gets its own
 * timeout on top of the overall deadline. Both matter: from this network QQ's
 * search host sometimes stalls for the full connect timeout, and a single shared
 * signal would let that one hang end the whole chain — so every artist would come
 * back with no portrait because of the first platform that was asked.
 *
 * `null` means every consulted platform completed without finding a photo.
 * A partial failure cannot prove a miss: the failed platform may have a photo,
 * so preserve its error unless another platform supplies a positive result.
 */
export async function resolveArtistImage(
  name: string,
  http: typeof fetch = fetch,
  allowed: SourceId[] | (() => SourceId[]) = ['mg', 'tx', 'wy', 'kg'],
  auxiliary?: AuxiliaryRequests
): Promise<ArtistImage | null> {
  const query = name.trim()
  if (!query || query.length > 60) return null
  const deadline = AbortSignal.timeout(20_000)
  const allowedNow = (source: SourceId): boolean =>
    (typeof allowed === 'function' ? allowed() : allowed).includes(source)
  async function json(source: SourceId, url: string, referer: string, origin?: string): Promise<unknown> {
    if (!allowedNow(source)) throw new Error('source admission revoked')
    const res = await http(url, {
      headers: { Referer: referer, ...(origin ? { Origin: origin } : {}), 'User-Agent': 'Mozilla/5.0' },
      signal: AbortSignal.any([deadline, AbortSignal.timeout(8_000)])
    })
    if (!res.ok) {
      try { await res.body?.cancel() } catch { /* releasing a failed response is best-effort */ }
      throw onlineHttpFailure(res, onlineContext(source, 'artistImage'))
    }
    const text = (await readBounded(res, 2 * 1024 * 1024)).toString('utf8')
    try {
      return JSON.parse(text) as unknown
    } catch {
      throw new OnlineRequestError({ ...onlineContext(source, 'artistImage'), code: 'schemaChanged' })
    }
  }

  const lookups: Array<{ source: SourceId; find: () => Promise<ArtistImage | null> }> = [
    {
      // 一次请求就够，而且从本机看它答得最快。
      source: 'mg',
      async find() {
        const rows = responseRows(await json(
          'mg',
          `https://app.u.nf.migu.cn/pc/resource/song/item/search/v1.0?${new URLSearchParams({ text: query, pageNo: '1', pageSize: '10' })}`,
          'https://music.migu.cn/',
          'https://music.migu.cn'
        ), 'Migu search')
        for (const song of rows) {
          for (const singer of song?.singerList ?? []) {
            const img = typeof singer?.img === 'string' ? singer.img : ''
            if (img && artistNameMatches(query, String(singer?.name ?? ''))) return { url: absoluteMgImage(img), source: 'mg' }
          }
        }
        return null
      }
    },
    {
      // 同样一次就够：QQ 的歌曲行本身就带歌手 mid，头像是按 mid 拼出来的公开地址。
      source: 'tx',
      async find() {
        const payload = responseRecord(await json(
          'tx',
          `https://c.y.qq.com/soso/fcgi-bin/client_search_cp?${new URLSearchParams({ w: query, p: '1', n: '10', cr: '1', new_json: '1', format: 'json', t: '0' })}`,
          'https://y.qq.com/'
        ), 'QQ search')
        const data = responseRecord(payload.data, 'QQ search data')
        const songResult = responseRecord(data.song, 'QQ search songs')
        const songs = responseRows(songResult.list, 'QQ search list')
        for (const song of songs) {
          for (const singer of song?.singer ?? []) {
            const mid = typeof singer?.mid === 'string' ? singer.mid : ''
            if (mid && artistNameMatches(query, String(singer?.name ?? ''))) {
              return { url: `https://y.gtimg.cn/music/photo_new/T001R300x300M000${mid}.jpg`, source: 'tx' }
            }
          }
        }
        return null
      }
    },
    {
      // 网易云的搜索行只有 id，头像要再问一次详情端点。
      source: 'wy',
      async find() {
        const payload = responseRecord(await json(
          'wy',
          `https://music.163.com/api/search/get/web?${new URLSearchParams({ s: query, type: '1', offset: '0', limit: '10' })}`,
          'https://music.163.com/'
        ), 'Netease search')
        const result = responseRecord(payload.result, 'Netease search result')
        const songs = responseRows(result.songs, 'Netease search songs')
        for (const song of songs) {
          for (const artist of song?.artists ?? []) {
            if (!artist?.id || !artistNameMatches(query, String(artist?.name ?? ''))) continue
            const detail = responseRecord(await json('wy', `https://music.163.com/api/artist/${artist.id}`, 'https://music.163.com/'), 'Netease artist detail')
            const detailArtist = responseRecord(detail.artist, 'Netease artist')
            const rawPic = detailArtist.picUrl
            if (rawPic !== undefined && rawPic !== null && typeof rawPic !== 'string') {
              throw new Error('artist image response has invalid Netease artist picture')
            }
            const pic = typeof rawPic === 'string' ? rawPic : ''
            // `?param=` 不是装饰：去掉它拿到的是 1.4MB 原图。
            if (pic) return { url: `${pic}?param=320y320`, source: 'wy' }
          }
        }
        return null
      }
    },
    {
      source: 'kg',
      async find() {
        const payload = responseRecord(await json(
          'kg',
          `https://songsearch.kugou.com/song_search_v2?${new URLSearchParams({ keyword: query, page: '1', pagesize: '10' })}`,
          'https://www.kugou.com/'
        ), 'Kugou search')
        const data = responseRecord(payload.data, 'Kugou search data')
        const songs = responseRows(data.lists, 'Kugou search list')
        for (const song of songs) {
          const raw = song?.SingerId
          const singerId = Array.isArray(raw) ? raw[0] : raw
          if (!singerId || !artistNameMatches(query, String(song?.SingerName ?? ''))) continue
          const infoPayload = responseRecord(await json(
            'kg',
            `https://mobilecdnbj.kugou.com/api/v3/singer/info?${new URLSearchParams({ singerid: String(singerId), version: '9108', plat: '0' })}`,
            'https://www.kugou.com/'
          ), 'Kugou singer detail')
          const info = responseRecord(infoPayload.data, 'Kugou singer data')
          const rawTemplate = info.imgurl
          if (rawTemplate !== undefined && rawTemplate !== null && typeof rawTemplate !== 'string') {
            throw new Error('artist image response has invalid Kugou singer picture')
          }
          const template = typeof rawTemplate === 'string' ? rawTemplate : ''
          if (template) return { url: template.replace(/\{size\}/g, '320'), source: 'kg' }
        }
        return null
      }
    }
  ]

  let failed = false
  let lastError: unknown
  for (const lookup of lookups) {
    if (!allowedNow(lookup.source)) continue
    try {
      const found = auxiliary
        ? await auxiliary.run(lookup.source, 'artistImage', () => lookup.find(), { signal: deadline })
        : await lookup.find()
      if (found) return found
    } catch (error) {
      failed = true
      lastError = error
      // 这一家没答上，换下一家。
    }
  }
  // 任何一家失败都不能证明没有头像，避免把不完整查询永久记成未命中。
  if (failed) throw lastError
  return null
}
