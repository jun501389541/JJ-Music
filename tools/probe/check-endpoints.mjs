/**
 * Probe which public music-platform endpoints are reachable from this machine.
 * Used to decide which clean-room search adapters are worth implementing.
 *
 * Usage: node tools/probe/check-endpoints.mjs
 */

const CANDIDATES = [
  {
    name: 'kuwo search',
    url: 'https://www.kuwo.cn/api/www/search/searchMusicBykeyWord?key=%E5%91%A8%E6%9D%B0%E4%BC%A6&pn=1&rn=3',
    headers: { Referer: 'https://www.kuwo.cn/', csrf: 'x' }
  },
  {
    name: 'kuwo mobile search',
    url: 'http://search.kuwo.cn/r.s?all=%E5%91%A8%E6%9D%B0%E4%BC%A6&ft=music&itemset=web_2013&client=kt&pn=0&rn=3&rformat=json&encoding=utf8',
    headers: {}
  },
  {
    name: 'kugou search',
    url: 'https://complexsearch.kugou.com/v2/search/song?keyword=%E5%91%A8%E6%9D%B0%E4%BC%A6&page=1&pagesize=3',
    headers: { Referer: 'https://www.kugou.com/' }
  },
  {
    name: 'kugou mobile search',
    url: 'https://mobilecdn.kugou.com/api/v3/search/song?format=json&keyword=%E5%91%A8%E6%9D%B0%E4%BC%A6&page=1&pagesize=3',
    headers: {}
  },
  {
    name: 'tencent search',
    url: 'https://c.y.qq.com/soso/fcgi-bin/client_search_cp?p=1&n=3&w=%E5%91%A8%E6%9D%B0%E4%BC%A6&format=json',
    headers: { Referer: 'https://y.qq.com/' }
  },
  {
    name: 'netease search',
    url: 'https://music.163.com/api/search/get/web?s=%E5%91%A8%E6%9D%B0%E4%BC%A6&type=1&offset=0&limit=3',
    headers: { Referer: 'https://music.163.com/' }
  },
  {
    name: 'migu search',
    url: 'https://m.music.migu.cn/migu/remoting/scr_search_tag?keyword=%E5%91%A8%E6%9D%B0%E4%BC%A6&type=2&rows=3&pgc=1',
    headers: { Referer: 'https://m.music.migu.cn/' }
  },
  {
    name: 'itunes search (control)',
    url: 'https://itunes.apple.com/search?term=jay&entity=song&limit=3',
    headers: {}
  }
]

const TIMEOUT_MS = 12_000

async function probe({ name, url, headers }) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
  try {
    const response = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0', ...headers },
      signal: controller.signal
    })
    const text = await response.text()
    const looksJson = /^\s*[[{"]/.test(text)
    let parsed = null
    if (looksJson) {
      try {
        parsed = JSON.parse(text.replace(/^[^(]*\(/, '').replace(/\)$/, ''))
      } catch {
        /* not json after all */
      }
    }
    const keys = parsed && typeof parsed === 'object' ? Object.keys(parsed).slice(0, 8) : []
    return {
      name,
      status: response.status,
      bytes: text.length,
      json: Boolean(parsed),
      keys,
      preview: text.slice(0, 140).replace(/\s+/g, ' ')
    }
  } catch (error) {
    return { name, status: 'ERR', error: error.message }
  } finally {
    clearTimeout(timer)
  }
}

const results = await Promise.all(CANDIDATES.map(probe))
for (const r of results) {
  const head = `${r.name.padEnd(26)} ${String(r.status).padEnd(5)}`
  if (r.status === 'ERR') {
    console.log(`${head} ${r.error}`)
  } else {
    console.log(`${head} json=${r.json} bytes=${r.bytes} keys=${JSON.stringify(r.keys)}`)
    console.log(`${' '.repeat(32)}${r.preview}`)
  }
}
