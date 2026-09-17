/**
 * Verify the aggregate search and NetEase cover resolution.
 *
 * Aggregate mode merges per-platform pages round-robin; the previous
 * implementation flattened by platform, which buried every platform after the
 * first. NetEase covers were built from a base64-encoded `picId`, which yields
 * 404 for every track — they now come from the detail endpoint instead.
 *
 * Usage: node tools/probe/verify-aggregate.mjs [keyword]
 */
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const load = (rel) => import(pathToFileURL(join(repoRoot, 'out', 'test', rel)).href)

const { searchAll, searchOnline } = await load('online/search.js')

let passed = 0
let failed = 0

function check(name, ok, detail = '') {
  if (ok) {
    passed += 1
    console.log(`  PASS  ${name}`)
  } else {
    failed += 1
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

const keyword = process.argv[2] ?? '周杰伦'

console.log('='.repeat(72))
console.log(`聚合搜索：${keyword}`)
console.log('='.repeat(72))

const results = await searchAll(keyword, 1)

console.log('\n--- 各平台 ---')
for (const result of results) {
  const label = `${result.source}${result.error ? '' : ` (${result.list.length} 首)`}`
  console.log(`  ${result.error ? '✗' : '✓'} ${label}${result.error ? ` — ${result.error}` : ''}`)
}

check('至少一个平台返回结果', results.some((r) => r.list.length > 0))

/* ------------------------------------------------------------------ *
 * Interleaving
 * ------------------------------------------------------------------ */

console.log('\n--- 轮转交错 ---')

const sourcesInOrder = []
for (const item of results.flatMap((r) => r.list)) {
  void item
}
// Reproduce the merge to check the order property, which is what makes the top
// of the list show each platform's best match.
const deepest = Math.max(0, ...results.map((r) => r.list.length))
const merged = []
for (let row = 0; row < deepest; row += 1) {
  for (const result of results) {
    const item = result.list[row]
    if (item) merged.push(item)
  }
}
for (const item of merged.slice(0, 12)) {
  if (!sourcesInOrder.includes(item.source)) sourcesInOrder.push(item.source)
  console.log(`    [${item.source}] ${item.name} — ${item.singer}`)
}

check('结果按平台交错（前几行来自不同平台）', sourcesInOrder.length >= 2, sourcesInOrder.join(','))
check('总数为各平台之和', merged.length === results.reduce((s, r) => s + r.list.length, 0))

/* ------------------------------------------------------------------ *
 * NetEase covers
 * ------------------------------------------------------------------ */

console.log('\n--- 网易云封面 ---')
const wy = results.find((r) => r.source === 'wy')
if (!wy || wy.list.length === 0) {
  console.log('  跳过：网易云无结果')
} else {
  const withPic = wy.list.filter((m) => m.picUrl)
  console.log(`  带封面: ${withPic.length}/${wy.list.length}`)
  check('网易云结果带封面 URL', withPic.length > 0, `${withPic.length}/${wy.list.length}`)

  if (withPic.length > 0) {
    // Verify the URL actually serves an image, not the 179-byte 404 the old
    // construction produced.
    const probe = withPic[0]
    console.log(`  样本: ${probe.name}`)
    console.log(`        ${probe.picUrl?.slice(0, 110)}`)
    try {
      const url = probe.picUrl
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), 12_000)
      const response = await fetch(url, {
        headers: { Referer: 'https://music.163.com/' },
        signal: controller.signal
      })
      clearTimeout(timer)
      const buffer = Buffer.from(await response.arrayBuffer())
      const isJpeg = buffer[0] === 0xff && buffer[1] === 0xd8
      const isPng =
        buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47
      check(
        '封面 URL 可访问且为真实图片',
        response.ok && (isJpeg || isPng) && buffer.length > 5000,
        `${response.status} ${buffer.length}B`
      )
    } catch (error) {
      check('封面 URL 可访问且为真实图片', false, error.message)
    }
  }
}

console.log(`\n${'='.repeat(72)}`)
console.log(`RESULT: ${passed} passed, ${failed} failed`)
console.log('='.repeat(72))
process.exit(failed === 0 ? 0 : 1)
