/**
 * Probe public lyric endpoints for the platforms we can already search.
 *
 * The custom-source API only exposes `lyric` for the `local` pseudo-source, so
 * online lyric lookup cannot come from a user's 音源 script for ordinary
 * tracks. The host has to implement it — exactly as LX Music does with its
 * built-in `musicSdk[source].getLyric()`. This script checks which endpoints
 * actually answer before we write adapters for them.
 *
 * Usage: node tools/probe/check-lyric-endpoints.mjs
 */
const TIMEOUT_MS = 12_000

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'

/** Each probe returns a short summary of what the endpoint gave back. */
const PROBES = [
  {
    name: 'QQ音乐 歌词 (lyric fcg)',
    url: 'https://c.y.qq.com/lyric/fcgi-bin/fcg_query_lyric_new.fcg?songmid=0039MnYb0qxYhV&format=json&nobase64=0&g_tk=5381',
    headers: { Referer: 'https://y.qq.com/portal/player.html' },
    parse: (text) => {
      const json = JSON.parse(text.replace(/^[^(]*\(/, '').replace(/\)\s*$/, ''))
      return {
        hasLyric: typeof json.lyric === 'string' && json.lyric.length > 0,
        hasTranslation: typeof json.trans === 'string' && json.trans.length > 0,
        lyricSample: decodeB64(json.lyric)?.slice(0, 60)
      }
    }
  },
  {
    name: '网易云 歌词',
    url: 'https://music.163.com/api/song/lyric?id=186016&lv=1&kv=1&tv=-1',
    headers: { Referer: 'https://music.163.com/' },
    parse: (text) => {
      const json = JSON.parse(text)
      return {
        hasLyric: typeof json.lrc?.lyric === 'string' && json.lrc.lyric.length > 0,
        hasTranslation: typeof json.tlyric?.lyric === 'string' && json.tlyric.lyric.length > 0,
        lyricSample: json.lrc?.lyric?.slice(0, 60)
      }
    }
  },
  {
    name: '酷我 歌词',
    url: 'https://m.kuwo.cn/newh5/singles/songinfoandlrc?musicId=474678847',
    headers: { Referer: 'https://m.kuwo.cn/' },
    parse: (text) => {
      const json = JSON.parse(text)
      const list = json?.data?.lrclist
      const joined = Array.isArray(list)
        ? list.map((x) => `[${x.time}]${x.lineLyric}`).join('\n')
        : ''
      return {
        hasLyric: joined.length > 0,
        hasTranslation: false,
        lyricSample: joined.slice(0, 60)
      }
    }
  },
  {
    name: 'QQ音乐 歌词 (备用 host)',
    url: 'https://c.y.qq.com/lyric/fcgi-bin/fcg_query_lyric_new.fcg?songmid=0039MnYb0qxYhV&format=json&nobase64=1',
    headers: { Referer: 'https://y.qq.com/' },
    parse: (text) => {
      const json = JSON.parse(text.replace(/^[^(]*\(/, '').replace(/\)\s*$/, ''))
      return {
        hasLyric: typeof json.lyric === 'string' && json.lyric.length > 0,
        hasTranslation: typeof json.trans === 'string' && json.trans.length > 0,
        lyricSample: String(json.lyric ?? '').slice(0, 60)
      }
    }
  }
]

/** QQ returns lyrics base64-encoded unless `nobase64=1`. */
function decodeB64(value) {
  if (typeof value !== 'string' || !value) return ''
  try {
    const decoded = Buffer.from(value, 'base64').toString('utf8')
    return decoded.includes('[') ? decoded : ''
  } catch {
    return ''
  }
}

for (const probe of PROBES) {
  const started = Date.now()
  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
    const response = await fetch(probe.url, {
      headers: { 'User-Agent': UA, ...probe.headers },
      signal: controller.signal
    })
    clearTimeout(timer)
    const text = await response.text()

    if (!response.ok) {
      console.log(`${probe.name}`)
      console.log(`  HTTP ${response.status} (${Date.now() - started} ms)`)
      continue
    }

    let info
    try {
      info = probe.parse(text)
    } catch (error) {
      console.log(`${probe.name}`)
      console.log(`  HTTP ${response.status} 但解析失败: ${error.message}`)
      console.log(`  body: ${text.slice(0, 140).replace(/\s+/g, ' ')}`)
      continue
    }

    console.log(`${probe.name}`)
    console.log(`  HTTP ${response.status} (${Date.now() - started} ms)`)
    console.log(`  歌词: ${info.hasLyric ? '有' : '无'}   翻译: ${info.hasTranslation ? '有' : '无'}`)
    if (info.lyricSample) console.log(`  样本: ${info.lyricSample.replace(/\n/g, ' | ')}`)
  } catch (error) {
    console.log(`${probe.name}`)
    console.log(`  ERR ${error.cause?.code ?? error.name}: ${error.message}`)
  }
  console.log('')
}
