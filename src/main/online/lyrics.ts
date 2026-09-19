/**
 * Online lyric lookup.
 *
 * ## Why the host implements this
 *
 * The custom-source API only exposes the `lyric` action for the `local`
 * pseudo-source. For an ordinary online track, a 音源 script *cannot* supply
 * lyrics — so lookup has to live in the host, exactly as LX Music implements it
 * with its built-in `musicSdk[source].getLyric()`.
 *
 * The endpoints below are the public web endpoints each platform's own player
 * uses. They are read-only lookups by track id; nothing is downloaded.
 *
 * All four were verified reachable from this machine before being wired in:
 *   QQ  → c.y.qq.com/lyric/fcgi-bin/fcg_query_lyric_new.fcg
 *   网易云 → music.163.com/api/song/lyric
 *   酷我  → m.kuwo.cn/newh5/singles/songinfoandlrc
 *   咪咕  → the `lrcUrl` each search result carries, on d.musicapp.migu.cn
 */
import type { LyricResult, OnlineMusicInfo, SourceId } from '@shared/types'
import { readBounded } from './read-bounded'
import { safeFetchText } from './url-guard'

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'

const TIMEOUT_MS = 12_000

/** Lyrics are tens of kilobytes; anything larger is not a lyric file. */
const LYRIC_MAX_BYTES = 512 * 1024

async function httpGet(url: string, referer: string): Promise<string> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
  try {
    const response = await fetch(url, {
      headers: {
        'User-Agent': UA,
        Referer: referer,
        Accept: 'application/json, text/plain, */*'
      },
      signal: controller.signal
    })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    // Bounded: these hosts are fixed, but a body is still a body, and `text()`
    // would happily materialise whatever size an upstream decides to send.
    return (await readBounded(response, LYRIC_MAX_BYTES)).toString('utf8')
  } finally {
    clearTimeout(timer)
  }
}

/**
 * QQ wraps some responses in a JSONP-ish envelope, and returns lyrics
 * base64-encoded unless `nobase64=1` is passed.
 */
function decodeQqLyric(value: unknown): string {
  if (typeof value !== 'string' || !value) return ''
  const decoded = Buffer.from(value, 'base64').toString('utf8')
  // Only accept the decode when it actually looks like LRC; a plain string
  // would decode to garbage.
  return decoded.includes('[') ? decoded : value
}

/* ------------------------------------------------------------------ *
 * Per-platform lookups
 * ------------------------------------------------------------------ */

async function lyricFromTencent(music: OnlineMusicInfo): Promise<LyricResult> {
  const songmid = String(music.meta?.songmid ?? '')
  if (!songmid) return { lyric: '' }

  const url =
    'https://c.y.qq.com/lyric/fcgi-bin/fcg_query_lyric_new.fcg?' +
    new URLSearchParams({
      songmid,
      format: 'json',
      nobase64: '0',
      g_tk: '5381'
    }).toString()

  const text = await httpGet(url, 'https://y.qq.com/portal/player.html')
  const json = JSON.parse(text) as { lyric?: string; trans?: string }

  return {
    lyric: decodeQqLyric(json.lyric),
    // QQ's `trans` is the translation track, when present.
    tlyric: decodeQqLyric(json.trans)
  }
}

async function lyricFromNetease(music: OnlineMusicInfo): Promise<LyricResult> {
  const id = String(music.meta?.songmid ?? '')
  if (!id) return { lyric: '' }

  const url =
    'https://music.163.com/api/song/lyric?' +
    new URLSearchParams({ id, lv: '-1', kv: '-1', tv: '-1', rv: '-1' }).toString()

  const text = await httpGet(url, 'https://music.163.com/')
  const json = JSON.parse(text) as {
    lrc?: { lyric?: string }
    tlyric?: { lyric?: string }
    romalrc?: { lyric?: string }
  }

  return {
    lyric: json.lrc?.lyric ?? '',
    tlyric: json.tlyric?.lyric ?? '',
    rlyric: json.romalrc?.lyric ?? ''
  }
}

async function lyricFromKuwo(music: OnlineMusicInfo): Promise<LyricResult> {
  const id = String(music.meta?.songmid ?? '')
  if (!id) return { lyric: '' }

  const url =
    'https://m.kuwo.cn/newh5/singles/songinfoandlrc?' +
    new URLSearchParams({ musicId: id }).toString()

  const text = await httpGet(url, 'https://m.kuwo.cn/')
  const json = JSON.parse(text) as {
    data?: { lrclist?: Array<{ time?: string; lineLyric?: string }> }
  }

  const list = json.data?.lrclist ?? []
  if (list.length === 0) return { lyric: '' }

  // Kuwo returns seconds-with-decimals, not LRC timestamps.
  const lyric = list
    .map((entry) => {
      const seconds = Number.parseFloat(entry.time ?? '0')
      if (!Number.isFinite(seconds)) return ''
      const minutes = Math.floor(seconds / 60)
      const rest = seconds - minutes * 60
      const stamp = `${String(minutes).padStart(2, '0')}:${rest.toFixed(3).padStart(6, '0')}`
      return `[${stamp}]${entry.lineLyric ?? ''}`
    })
    .filter(Boolean)
    .join('\n')

  return { lyric }
}

/**
 * Migu.
 *
 * No lookup-by-id call is needed: the search response already carries a public
 * `lrcUrl` for every track, so the adapter stores it in `meta` (see
 * `online/search.ts`) and this just reads it. Verified live: the URL returns
 * `text/plain`, 2575 bytes of ordinary `[mm:ss.xx]` LRC with no cookie or
 * referer requirement, which the shared parser consumes directly.
 *
 * That convenience is also the reason this is the one lyric provider that cannot
 * use `httpGet`: every other platform here interpolates an id into a URL on a
 * host we chose, so the request destination is not attacker-influenced. Here the
 * destination arrives from a remote JSON body and, through `music:enrich`, from
 * the renderer. So the address is validated per hop and pinned to Migu's own
 * domains -- `allowedHosts` is what stops a hostile response from turning a
 * lyric lookup into a request to loopback or a metadata endpoint.
 *
 * `mrcUrl` is Migu's word-level (karaoke) format and is richer than LRC, but its
 * encoding is undocumented here and unverified, so it is carried through and
 * left unused rather than guessed at.
 */
async function lyricFromMigu(music: OnlineMusicInfo): Promise<LyricResult> {
  const url = music.meta?.lrcUrl
  if (typeof url !== 'string' || !url) return { lyric: '' }

  let text: string
  try {
    text = await safeFetchText(url, {
      headers: { 'User-Agent': UA, Referer: 'https://music.migu.cn/' },
      allowedHosts: ['migu.cn'],
      maxBytes: LYRIC_MAX_BYTES,
      timeoutMs: TIMEOUT_MS
    })
  } catch {
    // A rejected or unreachable lyric file is a missing lyric, not an error the
    // player should surface -- consistent with every other provider here.
    return { lyric: '' }
  }

  // An error page or JSON envelope must not be handed to the parser as if it
  // were lyric text; every real Migu file starts with a timestamp.
  if (!text.includes('[')) return { lyric: '' }
  return { lyric: text }
}

const PROVIDERS: Record<string, (music: OnlineMusicInfo) => Promise<LyricResult>> = {
  tx: lyricFromTencent,
  wy: lyricFromNetease,
  kw: lyricFromKuwo,
  mg: lyricFromMigu
}

export function hasLyricProvider(source: SourceId): boolean {
  return source in PROVIDERS
}

export function lyricProviders(): SourceId[] {
  return Object.keys(PROVIDERS)
}

/**
 * Fetch lyrics for an online track.
 *
 * Returns an empty result rather than throwing when the platform has no
 * adapter or the track simply has no lyrics — a missing lyric is a normal
 * outcome, not an error the UI should surface as a failure.
 */
export async function fetchOnlineLyric(music: OnlineMusicInfo): Promise<LyricResult> {
  const provider = PROVIDERS[music.source]
  if (!provider) return { lyric: '' }

  try {
    const result = await provider(music)
    return {
      lyric: result.lyric ?? '',
      ...(result.tlyric ? { tlyric: result.tlyric } : {}),
      ...(result.rlyric ? { rlyric: result.rlyric } : {}),
      ...(result.lxlyric ? { lxlyric: result.lxlyric } : {})
    }
  } catch {
    return { lyric: '' }
  }
}
