/**
 * Verify direct interoperability with an installed LX Music data directory.
 *
 * The whole point of matching LX's `user_api.json` format is that a user can
 * migrate without re-importing anything by hand. This test proves that round
 * trip against the real file on this machine.
 *
 * Usage: node out/test/lx-import.test.mjs
 */
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const { SourceStore } = await import('./sources/source-store.js')
const { decodeScript, encodeScript, isEncodedScript } = await import('./sources/codec.js')

let passed = 0
let failed = 0

function check(name, condition, detail = '') {
  if (condition) {
    passed += 1
    console.log(`  PASS  ${name}`)
  } else {
    failed += 1
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

const appData = process.env.APPDATA ?? ''
const lxFile = join(appData, 'lx-music-desktop', 'LxDatas', 'user_api.json')

console.log('='.repeat(72))
console.log('LX Music interoperability test')
console.log('='.repeat(72))
console.log(`source: ${lxFile}\n`)

if (!existsSync(lxFile)) {
  console.log('SKIP: no LX Music installation found on this machine.')
  process.exit(0)
}

/* ------------------------------------------------------------------ *
 * 1. Codec round-trip
 * ------------------------------------------------------------------ */

console.log('--- encoding round-trip ---')
const sample = '/*! * @name 测试 * @version 1.0 */\nconst lx = globalThis.lx\n// 中文注释'
const encoded = encodeScript(sample)
check('encode produces the gz_ prefix', encoded.startsWith('gz_'), encoded.slice(0, 12))
check('isEncodedScript recognises it', isEncodedScript(encoded))
check('decode restores the exact source', decodeScript(encoded) === sample)
check('CJK survives the round-trip', decodeScript(encoded).includes('中文注释'))

/* ------------------------------------------------------------------ *
 * 2. Import the real LX file
 * ------------------------------------------------------------------ */

console.log('\n--- importing the real user_api.json ---')
const dir = mkdtempSync(join(tmpdir(), 'jjmusic-lximport-'))
const store = new SourceStore(dir)
store.load()

const payload = readFileSync(lxFile, 'utf8')
const raw = JSON.parse(payload)
console.log(`  LX file contains ${raw.userApis?.length ?? 0} entr(ies)`)

const imported = store.importLxFile(payload)
console.log(`  imported ${imported.length} source(s):`)
for (const meta of imported) {
  console.log(`    - "${meta.name}" v${meta.version || '?'} by ${meta.author || '?'}`)
}

check('imported every entry', imported.length === (raw.userApis?.length ?? 0), `${imported.length}`)
check('names parsed from the script header', imported.every((m) => m.name && m.name.length > 0))

/* ------------------------------------------------------------------ *
 * 3. The file we write back must remain importable by LX
 * ------------------------------------------------------------------ */

console.log('\n--- written file compatibility ---')
const written = JSON.parse(readFileSync(join(dir, 'sources', 'user_api.json'), 'utf8'))
check('writes the same top-level shape', Array.isArray(written.userApis))
check('each entry decodes', written.userApis.every((api) => decodeScript(api.script).length > 0))

const first = written.userApis[0]
// LX ignores unknown keys, so our `enabled` extension is safe, and the keys LX
// requires must all be present for a successful re-import there.
for (const key of ['id', 'name', 'description', 'version', 'author', 'homepage', 'script']) {
  check(`entry has '${key}'`, key in first, Object.keys(first).join(','))
}
check('script is LX-encoded', first.script.startsWith('gz_'))
check(
  'header block is at byte 0 of the decoded script',
  decodeScript(first.script).trimStart().startsWith('/*'),
  decodeScript(first.script).slice(0, 20)
)

/* ------------------------------------------------------------------ *
 * 4. Reload and re-serve
 * ------------------------------------------------------------------ */

console.log('\n--- persistence across a reload ---')
const reloaded = new SourceStore(dir)
reloaded.load()
check('survives a reload', reloaded.metas().length === imported.length, `${reloaded.metas().length}`)
check('source bodies still decode', reloaded.list().every((api) => api.source.length > 0))

/* ------------------------------------------------------------------ *
 * 5. Duplicate handling
 * ------------------------------------------------------------------ */

console.log('\n--- duplicate handling ---')
const before = reloaded.metas().length
reloaded.importLxFile(payload)
check(
  're-importing the same file replaces rather than duplicates',
  reloaded.metas().length === before,
  `${before} -> ${reloaded.metas().length}`
)

/* ------------------------------------------------------------------ *
 * 6. Malformed input
 * ------------------------------------------------------------------ */

console.log('\n--- malformed input ---')
const brokenDir = mkdtempSync(join(tmpdir(), 'jjmusic-broken-'))
const broken = new SourceStore(brokenDir)
broken.load()
// A hand-written script with no header comment must still import (LX would
// reject it, but being permissive on import and reporting the name is friendlier).
const noHeader = broken.import('const x = 1', '无头部脚本')
check('imports a script with no header', noHeader.name === '无头部脚本', noHeader.name)

let threw = false
try {
  broken.import('   ', 'empty')
} catch {
  threw = true
}
check('rejects empty input', threw)

rmSync(dir, { recursive: true, force: true })
rmSync(brokenDir, { recursive: true, force: true })

console.log(`\n${'='.repeat(72)}`)
console.log(`RESULT: ${passed} passed, ${failed} failed`)
console.log('='.repeat(72))
process.exit(failed === 0 ? 0 : 1)
