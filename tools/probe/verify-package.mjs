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
 *        node tools/probe/verify-package.mjs <app.asar> --artifact-version=X.Y.Z
 *
 * Default mode checks local checkout freshness. Artifact mode checks archive
 * content and the expected version, without comparing clocks across machines.
 * It does not authenticate provenance; verify release digests/signatures separately.
 */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
let requestedAsar, artifactVersion, requireNativeLauncher = false
function invalidArguments(message) {
  console.error(message)
  console.error('Usage: verify-package.mjs [app.asar] [--require-native-launcher] OR <app.asar> --artifact-version=X.Y.Z [--require-native-launcher]')
  process.exit(2)
}
for (const arg of process.argv.slice(2)) {
  if (arg.startsWith('--artifact-version=')) {
    if (artifactVersion !== undefined) invalidArguments('Duplicate artifact version')
    artifactVersion = arg.slice('--artifact-version='.length)
    if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(artifactVersion)) {
      invalidArguments('Artifact version must be a stable X.Y.Z version')
    }
  } else if (arg === '--require-native-launcher') {
    if (requireNativeLauncher) invalidArguments('Duplicate native launcher requirement')
    requireNativeLauncher = true
  } else if (arg.startsWith('-') || requestedAsar !== undefined) {
    invalidArguments('Unknown option or multiple archive paths')
  } else requestedAsar = arg
}
if (artifactVersion !== undefined && !requestedAsar) invalidArguments('Artifact mode requires an explicit archive path')
const asarPath = resolve(requestedAsar ?? join(repoRoot, 'release', 'win-unpacked', 'resources', 'app.asar'))
const exePath = resolve(dirname(asarPath), '..', 'JJ Music.exe')

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

let stale = false
if (artifactVersion !== undefined) {
  console.log('\nartifact content mode: expected version ' + artifactVersion)
  console.log('Cross-host timestamps are not compared; checkout freshness is not asserted.')
} else {
  const newest = newestSource(join(repoRoot, 'src'))
  console.log('\nnewest src: ' + new Date(newest.time).toLocaleString() + '  (' + newest.file.replace(repoRoot, '') + ')')
  stale = newest.time > asarTime.getTime()
  console.log('\n' + (stale ? '*** STALE PACKAGE ***' : 'package is newer than all sources'))
  if (stale) {
    console.log('The packaged build predates the newest source change, so it does')
    console.log('not contain it. Re-run npm run pack before testing.')
  }
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

  if (artifactVersion !== undefined) {
    let metadata
    try {
      metadata = JSON.parse(readFileSync(join(tmp, 'package.json'), 'utf8').replace(/^\uFEFF/, ''))
    } catch {
      throw new Error('Invalid package metadata: expected a readable package.json object')
    }
    if (metadata?.version !== artifactVersion) {
      throw new Error('Package version mismatch: expected ' + artifactVersion + ', found ' + String(metadata?.version))
    }
    console.log('package version verified: ' + metadata.version)
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
    ['歌词可用徽章', '逐行', renderer],
    // The overlay is a second window with its own page and its own preload
    // surface; the argument is what tells the shared preload which of the two to
    // expose, so if it is gone the strip has no bridge at all.
    ['桌面歌词悬浮窗', '--jj-desktop-lyric', main]
  ]

  console.log('\nfeature markers:')
  let missing = 0
  for (const [label, marker, haystack] of FEATURES) {
    const found = haystack.includes(marker)
    if (!found) missing += 1
    console.log(`  ${found ? 'OK  ' : 'MISS'}  ${label.padEnd(18)} (${marker})`)
  }

  /*
   * The tree *beside* the archive.
   *
   * The forked 音源 host runs with ELECTRON_RUN_AS_NODE — plain Node, no asar
   * support — so both it and the packages it imports must exist on disk. 0.1.1
   * through 0.1.5 shipped with `iconv-lite` still inside app.asar, and every
   * source died during the host's own import; nothing in the asar inspection
   * above could see that, because the archive itself looked fine.
   */
  const unpacked = join(dirname(asarPath), 'app.asar.unpacked')
  const ON_DISK = [
    join('out', 'main', 'source-host.js'),
    join('node_modules', 'iconv-lite', 'package.json'),
    join('node_modules', 'safer-buffer', 'package.json')
  ]
  console.log(`\non disk (the fork resolves these without asar support):`)
  console.log(`  ${unpacked}`)
  let unpackedMissing = 0
  for (const rel of ON_DISK) {
    const found = existsSync(join(unpacked, rel))
    if (!found) unpackedMissing += 1
    console.log(`  ${found ? 'OK  ' : 'MISS'}  ${rel}`)
  }
  // Older artifacts predate the native launcher; only a bundle that uses it
  // promises these resources. New bundles must never borrow a repo helper.
  if(requireNativeLauncher&&!main.includes('source-launcher.exe')) {
    unpackedMissing++
    console.log('  MISS  required native integration marker')
  }
  if(requireNativeLauncher||main.includes('source-launcher.exe')) {
    try {
      const resource=join(dirname(asarPath),'native')
      const binary=readFileSync(join(resource,'source-launcher.exe'))
      const manifest=JSON.parse(readFileSync(join(resource,'manifest.json'),'utf8').replace(/^\uFEFF/,''))
      const pe=binary.readUInt32LE(0x3c)
      const valid=binary.toString('ascii',0,2)==='MZ'&&binary.toString('ascii',pe,pe+4)==='PE\0\0'&&
        binary.readUInt16LE(pe+4)===0x8664&&binary.readUInt16LE(pe+24)===0x20b&&binary.readUInt16LE(pe+24+68)===2&&
        manifest.schema===1&&manifest.protocol===1&&manifest.arch==='x64'&&
        typeof manifest.sha256==='string'&&createHash('sha256').update(binary).digest('hex')===manifest.sha256.toLowerCase()
      if(!valid)throw new Error('native helper architecture/protocol/digest mismatch')
      console.log('  OK    native/source-launcher.exe (x64 GUI, protocol 1, SHA-256 match)')
    } catch {
      unpackedMissing++
      console.log('  MISS  native launcher resources (missing or architecture/protocol/digest mismatch)')
    }
  }

  console.log(
    `\n${missing === 0 && unpackedMissing === 0 ? 'all features present' : `${missing + unpackedMissing} check(s) MISSING`}`
  )
  process.exitCode = stale || missing > 0 || unpackedMissing > 0 ? 1 : 0
} finally {
  rmSync(tmp, { recursive: true, force: true })
}
