/**
 * Probe cover-URL patterns against real NetEase API responses.
 *
 * The previous run showed 404 for every pattern, but the sampled track was
 * "晴天(深情版)" — a cover version whose album art may genuinely be missing.
 * Before "fixing" the URL rule, confirm with a track that definitely has art,
 * and check whether the API itself already returns a usable `picUrl`. If it
 * does, constructing URLs from `picId` is unnecessary — the returned URL is
 * authoritative and should be preferred over any derived rule.
 */
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'

console.log('='.repeat(72))
console.log('网易云封面：使用接口返回的 picUrl vs 自行拼接')
console.log('='.repeat(72))

async function getJson(url, referer) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 12_000)
  try {
    const response = await fetch(url, {
      headers: { 'User-Agent': UA, Referer: referer ?? 'https://music.163.com/' },
      signal: controller.signal
    })
    return await response.text()
  } finally {
    clearTimeout(timer)
  }
}

async function head(url) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 10_000)
  try {
    const response = await fetch(url, {
      headers: { 'User-Agent': UA, Referer: 'https://music.163.com/' },
      signal: controller.signal
    })
    const buffer = Buffer.from(await response.arrayBuffer())
    const type = response.headers.get('content-type') ?? ''
    const magic = buffer.subarray(0, 3)
    const isJpeg = magic[0] === 0xff && magic[1] === 0xd8 && magic[2] === 0xff
    const isPng = magic.equals(Buffer.from([0x89, 0x50, 0x4e]))
    return { status: response.status, bytes: buffer.length, type: type.slice(0, 24), isJpeg, isPng }
  } catch (e) {
    return { error: e.name === 'AbortError' ? 'timeout' : e.message }
  }
}

/* ------------------------------------------------------------------ *
 * 1. Search API: does it return picUrl directly?
 * ------------------------------------------------------------------ */

console.log('\n--- 1. 搜索接口是否直接返回 picUrl ---')

const searchUrl =
  'https://music.163.com/api/search/get/web?' +
  new URLSearchParams({ s: '周杰伦 晴天', type: '1', offset: '0', limit: '6' }).toString()

let songs = []
try {
  const raw = await getJson(searchUrl)
  const json = JSON.parse(raw)
  songs = json.result?.songs ?? []
  console.log(`  返回 ${songs.length} 首`)
} catch (e) {
  console.log(`  搜索失败: ${e.message}`)
}

for (const song of songs.slice(0, 5)) {
  const album = song.album ?? {}
  const picId = album.picId
  const apiPicUrl = album.picUrl
  const artists = (song.artists ?? []).map((a) => a.name).join('、')
  console.log(`\n  ${song.name} — ${artists}`)
  console.log(`    album.picId  = ${picId}`)
  console.log(`    album.picUrl = ${String(apiPicUrl).slice(0, 120)}`)

  const attempts = []
  if (apiPicUrl) attempts.push(['接口返回 picUrl', apiPicUrl])
  if (picId) {
    // The documented rule: the id appears twice — the first path segment is the
    // id itself, not a base64 encoding of it.
    attempts.push([`p2/<picId>/<picId>.jpg`, `https://p2.music.126.net/${picId}/${picId}.jpg`])
    attempts.push([
      `p2 + param`,
      `https://p2.music.126.net/${picId}/${picId}.jpg?param=300y300`
    ])
    attempts.push([
      `p1 + param`,
      `https://p1.music.126.net/${picId}/${picId}.jpg?param=300y300`
    ])
  }

  for (const [label, url] of attempts) {
    const result = await head(url)
    const ok = (result.isJpeg || result.isPng) && result.status === 200
    console.log(
      `      ${ok ? '✓' : '✗'} ${label.padEnd(20)} ${result.status ?? ''} ${result.bytes ?? ''}B ${result.type ?? result.error ?? ''}`
    )
  }
}

/* ------------------------------------------------------------------ *
 * 2. Detail API for a song without album picUrl
 * ------------------------------------------------------------------ */

console.log('\n--- 2. 详情接口（/api/song/detail）---')

if (songs.length > 0) {
  const id = songs[0].id
  const detailUrl =
    'https://music.163.com/api/song/detail?' +
    new URLSearchParams({ ids: JSON.stringify([id]) }).toString()
  try {
    const raw = await getJson(detailUrl)
    const json = JSON.parse(raw)
    const song = json.songs?.[0]
    if (song) {
      console.log(`  ${song.name}`)
      console.log(`    album.picUrl: ${String(song.album?.picUrl ?? '').slice(0, 120)}`)
      console.log(`    album.picId:  ${song.album?.picId}`)
      const url = song.album?.picUrl
      if (url) {
        const result = await head(url)
        console.log(
          `    ${result.status === 200 && (result.isJpeg || result.isPng) ? '✓' : '✗'} 可直接用: ${result.status} ${result.bytes}B`
        )
      }
    }
  } catch (e) {
    console.log(`  详情查询失败: ${e.message}`)
  }
}
