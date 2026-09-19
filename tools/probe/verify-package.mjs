/**
 * Verify that a packaged build actually contains the features it should.
 *
 * Packaging is a separate step from building, and it is easy to ship a stale
 * artifact: the source changes, the tests pass, but `release/` still holds a
 * bundle from an hour ago. This inspects the asar and reports which features are
 * present, so "it behaves like nothing changed" can be answered in seconds
 * instead of by re-reading code.
 *
 * Usage: node tools/probe/verify-package.mjs [app.asar]
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const asarPath = process.argv[2] ?? join(repoRoot, 'release', 'win-unpacked', 'resources', 'app.asar')
const exePath = join(repoRoot, 'release', 'win-unpacked', 'JJ Music.exe')

if (!existsSync(asarPath)) {
  console.error(`no asar at ${asarPath} — run \`npm run pack\` first`)
  process.exit(1)
}

console.log('='.repeat(72))
console.log('packaged build verification')
console.log('='.repeat(72))

// Timestamps first: a package older than the newest source file is the single
// most likely explanation for "my changes are not there".
const asarTime = statSync(asarPath).mtime
console.log(`\napp.asar : ${asarTime.toLocaleString()}`)
if (existsSync(exePath)) {
  console.log(`exe      : ${statSync(exePath).mtime.toLocaleString()}`)
}

function newestSource(dir) {
  let newest = 0
  let newestFile = ''
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      const sub = newestSource(full)
      if (sub.time > newest) {
        newest = sub.time
        newestFile = sub.file
      }
    } else {
      const time = statSync(full).mtimeMs
      if (time > newest) {
        newest = time
        newestFile = full
      }
    }
  }
  return { time: newest, file: newestFile }
}

const newest = newestSource(join(repoRoot, 'src'))
console.log(`newest src: ${new Date(newest.time).toLocaleString()}  (${newest.file.replace(repoRoot, '')})`)

const stale = newest.time > asarTime.getTime()
console.log(
  `\n${stale ? '*** STALE PACKAGE ***' : 'package is newer than all sources'}`
)
if (stale) {
  console.log('The packaged build predates the newest source change, so it does')
  console.log('not contain it. Re-run `npm run pack` before testing.')
}

// Extract and look for the feature markers.
const tmp = mkdtempSync(join(tmpdir(), 'jj-asar-'))
try {
  execFileSync(process.execPath, [
    join(repoRoot, 'node_modules', '@electron', 'asar', 'bin', 'asar.js'),
    'extract',
    asarPath,
    tmp
  ])

  const readAll = (dir) => {
    let text = ''
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) text += readAll(full)
      else if (/\.(js|cjs|mjs|html)$/.test(entry.name)) text += readFileSync(full, 'utf8')
    }
    return text
  }

  const main = readAll(join(tmp, 'out', 'main'))
  const preload = readAll(join(tmp, 'out', 'preload'))
  const renderer = readAll(join(tmp, 'out', 'renderer'))
  const all = main + preload + renderer

  console.log(`\nextracted: main ${main.length}B, preload ${preload.length}B, renderer ${renderer.length}B`)

  const FEATURES = [
    ['内嵌歌词读取', 'readEmbeddedLyric', main],
    ['歌词三级解析', 'resolveLocalLyric', main],
    ['在线歌词适配器', 'fetchOnlineLyric', main],
    ['标签匹配评分', 'matchMetadata', main],
    ['标签写入 (FLAC)', 'buildVorbisComment', main],
    ['索引版本迁移', 'isStale', main],
    ['IPC 脱壳修复', 'toIpcPayload', renderer],
    ['歌词来源徽章', '在线匹配', renderer],
    ['标签匹配对话框', '写入预览', renderer],
    ['歌词编辑器', '打时间戳', renderer],
    // Was '词·同步', a string that exists nowhere in the sources or in the
    // shipped 0.1.3 asar: this line has been reporting MISS for a badge whose
    // actual label is 逐行. The tool is a probe and nothing ran it in CI, so the
    // wrong marker outlived the wording it was meant to detect.
    ['歌词可用徽章', '逐行', renderer]
  ]

  console.log('\nfeature markers:')
  let missing = 0
  for (const [label, marker, haystack] of FEATURES) {
    const found = haystack.includes(marker)
    if (!found) missing += 1
    console.log(`  ${found ? 'OK  ' : 'MISS'}  ${label.padEnd(18)} (${marker})`)
  }

  console.log(`\n${missing === 0 ? 'all features present' : `${missing} feature(s) MISSING`}`)
  process.exit(stale || missing > 0 ? 1 : 0)
} finally {
  rmSync(tmp, { recursive: true, force: true })
}
