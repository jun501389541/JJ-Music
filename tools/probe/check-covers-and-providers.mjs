/**
 * Verify cover-URL construction and probe 酷狗 / 咪咕 search endpoints.
 *
 * Two things to settle before writing adapters:
 *   1. The NetEase cover URL — the current code base64-encodes `picId`, which is
 *      almost certainly wrong (the real rule concatenates the raw id) and would
 *      explain "网易云封面异常".
 *   2. Whether 酷狗 and 咪咕 have reachable search endpoints, and what shape
 *      they return, so new adapters can be written against real data rather than
 *      guesses.
 *
 * Usage: node tools/probe/check-covers-and-providers.mjs
 */
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'

async function head(url, referer) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 10_000)
  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: { 'User-Agent': UA, Referer: referer ?? '' },
      signal: controller.signal,
      redirect: 'follow'
    })
    const buffer = Buffer.from(await response.arrayBuffer())
    const type = response.headers.get('content-type') ?? ''
    const looksImage = type.startsWith('image/') || buffer.subarray(0, 4).includes(Buffer.from([0xff, 0xd8, 0xff]))
    return {
      status: response.status,
      bytes: buffer.length,
      type: type.slice(0, 30),
      looksImage
    }
  } catch (error) {
    return { error: error.name === 'AbortError' ? 'timeout' : error.message }
  }
}

console.log('='.repeat(72))
console.log('封面 URL 与搜索接口验证')
console.log('='.repeat(72))

/* ------------------------------------------------------------------ *
 * 1. NetEase cover URL: base64 vs raw picId
 * ------------------------------------------------------------------ */

console.log('\n--- 1. 网易云封面 URL ---')

// A real picId sampled from a live search response.
const { searchOnline } = await import(
  new URL('../../out/test/online/search.js', import.meta.url).href
)

let sample
try {
  const page = await searchOnline('wy', '晴天', 1)
  sample = page.list.find((m) => m.picUrl) ?? page.list[0]
} catch (error) {
  console.log(`  搜索失败: ${error.message}`)
}

if (sample) {
  console.log(`  样本: ${sample.name} — ${sample.singer}`)
  console.log(`  当前 picUrl: ${sample.picUrl?.slice(0, 110)}`)

  // Extract the picId the current code built.
  const match = /\/(\d+)\.jpg/.exec(sample.picUrl ?? '')
  const picId = match?.[1]

  if (picId) {
    console.log(`  picId: ${picId}`)

    const candidates = [
      ['当前实现（base64 拼接）', sample.picUrl],
      ['原始 picId 直接拼接', `https://p2.music.126.net/${picId}/${picId}.jpg`],
      ['带参数', `https://p2.music.126.net/${picId}/${picId}.jpg?param=300y300`],
      ['p1 域名', `https://p1.music.126.net/${picId}/${picId}.jpg?param=300y300`]
    ]

    for (const [label, url] of candidates) {
      const result = await head(url, 'https://music.163.com/')
      console.log(
        `  ${result.looksImage ? '✓' : '✗'} ${label.padEnd(22)} ` +
          `${result.status ?? ''} ${result.bytes ?? ''}B ${result.type ?? result.error ?? ''}`
      )
    }
  }
}

/* ------------------------------------------------------------------ *
 * 2. 酷狗 / 咪咕 search endpoints
 * ------------------------------------------------------------------ */

console.log('\n--- 2. 酷狗 / 咪咕 搜索接口 ---')

const PROVIDERS = [
  {
    name: '酷狗 移动端搜索',
    url:
      'https://mobilecdn.kugou.com/api/v3/search/song?' +
      new URLSearchParams({ keyword: '周杰伦', page: '1', pagesize: '5' }).toString(),
    referer: 'https://m.kugou.com/'
  },
  {
    name: '酷狗 songsearch',
    url:
      'https://songsearch.kugou.com/song_search_v2?' +
      new URLSearchParams({ keyword: '周杰伦', page: '1', pagesize: '5' }).toString(),
    referer: 'https://www.kugou.com/'
  },
  {
    name: '咪咕 music.migu.cn',
    url:
      'https://m.music.migu.cn/migu/remoting/scr_search_tag?' +
      new URLSearchParams({ keyword: '周杰伦', type: '2', rows: '5', pgc: '1' }).toString(),
    referer: 'https://m.music.migu.cn/'
  },
  {
    name: '咪咕 app搜索接口',
    url:
      'https://jadeite.migu.cn/music_search/v2/search/song?' +
      new URLSearchParams({ keyword: '周杰伦', page: '1', size: '5' }).toString(),
    referer: 'https://music.migu.cn/'
  }
]

for (const provider of PROVIDERS) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 10_000)
  try {
    const response = await fetch(provider.url, {
      headers: { 'User-Agent': UA, Referer: provider.referer },
      signal: controller.signal
    })
    clearTimeout(timer)
    const text = await response.text()
    const isJson = /^\s*[[{]/.test(text)
    console.log(
      `\n  ${response.status === 200 ? '✓' : '·'} ${provider.name}: HTTP ${response.status}, ` +
        `${text.length} 字节, ${isJson ? 'JSON' : '非 JSON'}`
    )
    if (response.status === 200 && isJson) {
      console.log(`      ${text.slice(0, 260).replace(/\s+/g, ' ')}`)
    } else if (response.status === 200) {
      console.log(`      ${text.slice(0, 160).replace(/\s+/g, ' ')}`)
    }
  } catch (error) {
    clearTimeout(timer)
    console.log(`\n  ✗ ${provider.name}: ${error.name === 'AbortError' ? '超时' : error.message}`)
  }
}
