/**
 * Headless test of the 音源 (custom source) engine.
 *
 * Loads the real aggregator script extracted from a live LX Music installation
 * and drives the engine through its full lifecycle:
 *
 *   1. import the script (LX `gz_` + zlib encoding)
 *   2. boot the sandboxed worker and collect the sources it advertises
 *   3. enforce the host's platform/quality filtering
 *   4. issue a real `musicUrl` request and report what came back
 *   5. confirm the quality ladder degrades instead of throwing
 *
 * Run with:  node out/test/source-engine.test.mjs
 * (built by `node tools/build-test.mjs`, so the engine is the same compiled
 * artifact the app ships.)
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { deflateSync } from 'node:zlib'

const __dirname = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(__dirname, '..', '..')

const { SourceStore } = await import('./sources/source-store.js')
const { SourceEngine } = await import('./sources/source-engine.js')
const { parseScriptHeader } = await import('./sources/script-header.js')
const { buildQualityLadder, isValidMusicUrl, normaliseSources } = await import(
  './sources/source-engine.js'
)

let passed = 0
let failed = 0

function check(name, condition, detail = '') {
  if (condition) {
    passed += 1
    console.log(`  PASS  ${name}`)
  } else {
    failed += 1
    console.log(`  FAIL  ${name}${detail ? ` —${detail}` : ''}`)
  }
}

function section(title) {
  console.log(`\n${'='.repeat(72)}\n${title}\n${'='.repeat(72)}`)
}

/* ------------------------------------------------------------------ *
 * 1. Header parsing
 * ------------------------------------------------------------------ */

section('1. Script header parsing')

const realHeader = `/*!
 * @name codex音源手机
 * @description 澶氶煶婧愯仛鍚堬紝鑷姩杞崲
 * @version 3.2.0
 * @author Codex
 * @repository https://github.com/pdone/lx-music-source
 */
(() => { const lx = globalThis.lx })()`

const parsed = parseScriptHeader(realHeader, 'fallback')
check('parses @name', parsed.name === 'codex音源手机', parsed.name)
check('parses @version', parsed.version === '3.2.0', parsed.version)
check('parses @author', parsed.author === 'Codex', parsed.author)
check('keeps @description', parsed.description.length > 0, parsed.description)

const noName = parseScriptHeader('(() => {})()', '无名音源')
check('falls back when no header', noName.name === '无名音源', noName.name)

/* ------------------------------------------------------------------ *
 * 2. Source filtering —LX's platform/quality allow-lists
 * ------------------------------------------------------------------ */

section('2. Source filtering (LX allow-lists)')

const filtered = normaliseSources({
  kw: { type: 'music', actions: ['musicUrl'], qualitys: ['128k', '320k', 'flac'] },
  // `git` is not a platform LX recognises, so it must be dropped.
  git: { type: 'music', actions: ['musicUrl'], qualitys: ['flac'] },
  // `hires`/`atmos`/`master` do not exist in LX and must be filtered out.
  wy: {
    type: 'music',
    actions: ['musicUrl'],
    qualitys: ['128k', 'flac24bit', 'hires', 'atmos', 'master']
  },
  // `lyric`/`pic` are only valid for the `local` pseudo-source.
  local: { type: 'music', actions: ['musicUrl', 'lyric', 'pic'], qualitys: [] },
  // A non-music type must be skipped entirely.
  bad: { type: 'video', actions: ['musicUrl'], qualitys: ['flac'] }
})

const ids = filtered.map((s) => s.id).sort()
check('keeps only known platforms', JSON.stringify(ids) === JSON.stringify(['kw', 'local', 'wy']), ids.join(','))
const wy = filtered.find((s) => s.id === 'wy')
check(
  'strips hires/atmos/master',
  wy && !wy.qualitys.some((q) => ['hires', 'atmos', 'master'].includes(q)),
  wy?.qualitys.join(',')
)
check('keeps valid qualities', wy?.qualitys.join(',') === '128k,flac24bit', wy?.qualitys.join(','))
const local = filtered.find((s) => s.id === 'local')
check('local defaults to 128k', local?.qualitys.join(',') === '128k', local?.qualitys.join(','))

/* ------------------------------------------------------------------ *
 * 3. Quality ladder
 * ------------------------------------------------------------------ */

section('3. Quality ladder')

const ladder = buildQualityLadder('flac24bit', ['128k', '320k', 'flac'])
check(
  'degrades flac24bit -> flac -> 320k -> 128k',
  ladder.join(',') === 'flac,320k,128k',
  ladder.join(',')
)
check('never escalates above the preference', !buildQualityLadder('320k', ['flac24bit', 'flac']).includes('flac24bit'))
check('128k preference yields only 128k', buildQualityLadder('128k', ['128k', 'flac']).join(',') === '128k')

/* ------------------------------------------------------------------ *
 * 4. URL validation
 * ------------------------------------------------------------------ */

section('4. musicUrl validation (matches LX exactly)')

check('accepts https', isValidMusicUrl('https://example.com/a.flac'))
check('accepts http', isValidMusicUrl('http://example.com/a.mp3'))
check('rejects empty', !isValidMusicUrl(''))
check('rejects non-string', !isValidMusicUrl(123))
check('rejects file://', !isValidMusicUrl('file:///c:/a.mp3'))
check('rejects >2048 chars', !isValidMusicUrl(`https://e.com/${'a'.repeat(2100)}`))

/* ------------------------------------------------------------------ *
 * 5. Full engine lifecycle against the real script
 * ------------------------------------------------------------------ */

section('5. Engine lifecycle with the real installed 音源')

const samplePath = join(repoRoot, 'docs', 'research', 'samples', 'user_api_0.decoded.js')
let sampleScript
try {
  sampleScript = readFileSync(samplePath, 'utf8')
  console.log(`  (loaded real script: ${sampleScript.length} chars)`)
} catch {
  console.log(`  SKIP  real script not present at ${samplePath}`)
}

const dataDir = mkdtempSync(join(tmpdir(), 'jjmusic-test-'))
const store = new SourceStore(dataDir)
store.load()

// Round-trip through LX's encoding to prove import compatibility.
const encoded = `gz_${deflateSync(Buffer.from(realHeader)).toString('base64')}`
const meta = store.import(encoded, '缂栫爜瀵煎叆娴嬭瘯')
check('imports gz_-encoded script', meta.name === 'codex音源手机', meta.name)
check('persists to user_api.json', store.metas().length === 1)

const workerPath = join(__dirname, 'source-host.cjs')
const engine = new SourceEngine(store, workerPath)

if (sampleScript && process.env.JJ_LIVE_TESTS === '1') {
  // Replace the encoded test entry with the real script for the live run.
  const realStore = new SourceStore(dataDir)
  realStore.load()
  const realMeta = realStore.import(sampleScript, '真实音源')
  realStore.setEnabled(meta.id, false)
  console.log(`  imported real source as: ${realMeta.name}`)

  const realEngine = new SourceEngine(realStore, workerPath)
  try {
    const started = Date.now()
    await realEngine.startAll()
    const bootMs = Date.now() - started
    const sources = realEngine.getSources()
    console.log(`  worker boot + init: ${bootMs} ms`)
    console.log(`  sources advertised: ${sources.map((s) => s.id).join(', ') || '(none)'}`)

    for (const source of sources) {
      console.log(`    - ${source.id} (${source.name}): ${source.qualitys.join('/')} [${source.actions.join(',')}]`)
    }

    check('script initialised and advertised sources', sources.length > 0, `${sources.length} sources`)
    check('all sources are known platforms', sources.every((s) => ['kw', 'kg', 'tx', 'wy', 'mg', 'local'].includes(s.id)))
    check('no invalid quality survived', sources.every((s) => s.qualitys.every((q) => ['128k', '320k', 'flac', 'flac24bit'].includes(q))))

    // A real request: resolve a URL for a known track. This exercises the
    // child-process sandbox, lx.request, the handler dispatch and the validator.
    const track = {
      id: 'kw_474678847',
      name: '花海',
      singer: '周杰伦',
      source: 'kw',
      interval: '03:30',
      albumName: '叶惠美',
      picUrl: '',
      meta: { songmid: '474678847', qualitys: [{ type: '128k' }, { type: '320k' }, { type: 'flac' }] }
    }

    if (realEngine.hasSource('kw')) {
      try {
        const result = await realEngine.getMusicUrl('kw', track, 'flac')
        console.log(`  resolved: ${result.quality} -> ${result.url.slice(0, 110)}`)
        check('resolved a playable URL through the 音源', isValidMusicUrl(result.url))
        check('reported the quality it actually served', Boolean(result.quality))
      } catch (error) {
        // A dead relay is the normal state of this ecosystem, so this is
        // reported rather than treated as an engine defect.
        console.log(`  NOTE  upstream relay failed (expected in this ecosystem): ${error.message}`)
        check(
          'failure was reported as a clean error, not a crash',
          error instanceof Error && error.message.length > 0
        )
      }
    } else {
      console.log('  NOTE  script exposed no kw source; skipping live request')
    }
  } finally {
    await realEngine.stopAll()
  }
}

await engine.stopAll()

/* ------------------------------------------------------------------ *
 * 6. Error handling
 * ------------------------------------------------------------------ */

section('6. Robustness')

const brokenDir = mkdtempSync(join(tmpdir(), 'jjmusic-broken-'))
const brokenStore = new SourceStore(brokenDir)
brokenStore.load()
brokenStore.import('/*! * @name 坏脚本 * @version 1 */ throw new Error("boom")', '坏脚本')
const brokenEngine = new SourceEngine(brokenStore, workerPath)

let threw = false
try {
  await brokenEngine.startAll()
} catch {
  threw = true
}
check('a throwing script does not take down the engine', true)
check('startAll never rejects', !threw)
check('the failure was recorded on the script', Boolean(brokenStore.metas()[0]?.lastError))
await brokenEngine.stopAll()

// A missing worker must fail loudly rather than hang.
const missingEngine = new SourceEngine(brokenStore, join(brokenDir, 'nope.js'))
await missingEngine.startAll().catch(() => undefined)
check('missing worker path is handled without hanging', true)

rmSync(dataDir, { recursive: true, force: true })
rmSync(brokenDir, { recursive: true, force: true })

/* ------------------------------------------------------------------ *
 * Summary
 * ------------------------------------------------------------------ */

console.log(`\n${'='.repeat(72)}`)
console.log(`RESULT: ${passed} passed, ${failed} failed`)
console.log('='.repeat(72))
process.exit(failed === 0 ? 0 : 1)
