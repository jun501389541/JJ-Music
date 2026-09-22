import type { SourceId } from '@shared/types'
import { readBounded } from './read-bounded'

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
 * `null` therefore means "someone answered and had no photo", never "nothing
 * could be reached": when every platform threw, the last error is thrown instead.
 */
export async function resolveArtistImage(
  name: string,
  http: typeof fetch = fetch,
  allowed: SourceId[] = ['mg', 'tx', 'wy', 'kg']
): Promise<ArtistImage | null> {
  const query = name.trim()
  if (!query || query.length > 60) return null
  const deadline = AbortSignal.timeout(20_000)
  async function json(url: string, referer: string, origin?: string): Promise<Row> {
    const res = await http(url, {
      headers: { Referer: referer, ...(origin ? { Origin: origin } : {}), 'User-Agent': 'Mozilla/5.0' },
      signal: AbortSignal.any([deadline, AbortSignal.timeout(8_000)])
    })
    const text = (await readBounded(res, 2 * 1024 * 1024)).toString('utf8')
    try {
      return JSON.parse(text) as Row
    } catch {
      return {}
    }
  }

  const lookups: Array<{ source: SourceId; find: () => Promise<ArtistImage | null> }> = [
    {
      // 一次请求就够，而且从本机看它答得最快。
      source: 'mg',
      async find() {
        const rows = await json(
          `https://app.u.nf.migu.cn/pc/resource/song/item/search/v1.0?${new URLSearchParams({ text: query, pageNo: '1', pageSize: '10' })}`,
          'https://music.migu.cn/',
          'https://music.migu.cn'
        )
        for (const song of Array.isArray(rows) ? rows : []) {
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
        const data = await json(
          `https://c.y.qq.com/soso/fcgi-bin/client_search_cp?${new URLSearchParams({ w: query, p: '1', n: '10', cr: '1', new_json: '1', format: 'json', t: '0' })}`,
          'https://y.qq.com/'
        )
        for (const song of data?.data?.song?.list ?? []) {
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
        const data = await json(
          `https://music.163.com/api/search/get/web?${new URLSearchParams({ s: query, type: '1', offset: '0', limit: '10' })}`,
          'https://music.163.com/'
        )
        for (const song of data?.result?.songs ?? []) {
          for (const artist of song?.artists ?? []) {
            if (!artist?.id || !artistNameMatches(query, String(artist?.name ?? ''))) continue
            const detail = await json(`https://music.163.com/api/artist/${artist.id}`, 'https://music.163.com/')
            const pic = typeof detail?.artist?.picUrl === 'string' ? detail.artist.picUrl : ''
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
        const data = await json(
          `https://songsearch.kugou.com/song_search_v2?${new URLSearchParams({ keyword: query, page: '1', pagesize: '10' })}`,
          'https://www.kugou.com/'
        )
        for (const song of data?.data?.lists ?? []) {
          const raw = song?.SingerId
          const singerId = Array.isArray(raw) ? raw[0] : raw
          if (!singerId || !artistNameMatches(query, String(song?.SingerName ?? ''))) continue
          const info = await json(
            `https://mobilecdnbj.kugou.com/api/v3/singer/info?${new URLSearchParams({ singerid: String(singerId), version: '9108', plat: '0' })}`,
            'https://www.kugou.com/'
          )
          const template = typeof info?.data?.imgurl === 'string' ? info.data.imgurl : ''
          if (template) return { url: template.replace(/\{size\}/g, '320'), source: 'kg' }
        }
        return null
      }
    }
  ]

  let answered = 0
  let lastError: unknown
  for (const lookup of lookups) {
    if (!allowed.includes(lookup.source)) continue
    try {
      const found = await lookup.find()
      answered++
      if (found) return found
    } catch (error) {
      lastError = error
      // 这一家没答上，换下一家。
    }
  }
  // 一家都没答上时，"这位歌手没有头像"是无从得知的——断网和真没照片是两回事。
  //  Returning `null` for both would let the caller cache the outage as a
  //  permanent miss, so a fully failed chain throws and only a completed lookup
  //  ends up as an answer either way.
  if (!answered && lastError) throw lastError
  return null
}
