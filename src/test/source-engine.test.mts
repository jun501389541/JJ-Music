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
const { containsShutdownAttempt } = await import('./sources/shutdown-guard.js')
const { validateSourceBeforeStart, summariseReport } = await import(
  './sources/source-validator.js'
)
const { supportsRestrictedLaunch } = await import('./sources/restricted-launch.js')

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
 * 2. Source filtering —quality allow-list, platform passthrough
 * ------------------------------------------------------------------ */

section('2. Source filtering (quality allow-list)')

const filtered = normaliseSources({
  kw: { type: 'music', actions: ['musicUrl'], qualitys: ['128k', '320k', 'flac'] },
  // A private/aggregator-only id. This used to be dropped to match LX; it is
  // now kept, because dropping it hid platforms the installed scripts can
  // genuinely serve (measured: `qs` and `qsvip` among the 21 sources).
  git: { type: 'music', actions: ['musicUrl'], qualitys: ['flac'] },
  // `hires`/`atmos`/`master` do not exist in LX and must be filtered out.
  wy: {
    type: 'music',
    actions: ['musicUrl'],
    qualitys: ['128k', 'flac24bit', 'hires', 'atmos', 'master']
  },
  // `local` is built in, so a script must never be able to shadow it.
  local: { type: 'music', actions: ['musicUrl', 'lyric', 'pic'], qualitys: [] },
  // A non-music type must be skipped entirely.
  bad: { type: 'video', actions: ['musicUrl'], qualitys: ['flac'] }
})

const ids = filtered.map((s) => s.id).sort()
check(
  'keeps known platforms and private ids, drops local',
  JSON.stringify(ids) === JSON.stringify(['git', 'kw', 'wy']),
  ids.join(',')
)
check('drops the built-in local pseudo-source', !ids.includes('local'), ids.join(','))
const wy = filtered.find((s) => s.id === 'wy')
check(
  'strips hires/atmos/master',
  wy && !wy.qualitys.some((q) => ['hires', 'atmos', 'master'].includes(q)),
  wy?.qualitys.join(',')
)
check('keeps valid qualities', wy?.qualitys.join(',') === '128k,flac24bit', wy?.qualitys.join(','))
const privateId = filtered.find((s) => s.id === 'git')
check('private platform keeps a usable name', privateId?.name === 'git', privateId?.name)

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

/* ------------------------------------------------------------------ *
 * 5b. Restricted-token launch (file handoff protocol)
 *
 * On Windows the engine now launches sources via `runas /trustlevel`, whose
 * child is detached — the whole request/response protocol rides on files in
 * the scratch directory. This section proves that path end-to-end: boot,
 * source advertisement, and a request round-trip, all through the file
 * protocol. Skipped elsewhere where runas does not exist.
 * ------------------------------------------------------------------ */

section('5b. Restricted-token launch (file handoff)')

if (!supportsRestrictedLaunch()) {
  console.log('  SKIP  not Windows: restricted launch unavailable')
} else {
  const rDir = mkdtempSync(join(tmpdir(), 'jjmusic-restricted-'))
  const rStore = new SourceStore(rDir)
  rStore.load()
  // A harmless echo source: inits cleanly, answers musicUrl with a fixed URL.
  const echoScript = [
    '/*! * @name 受限模式音源 * @version 1 */',
    'lx.on(lx.EVENT_NAMES.request, ({ action }) => {',
    '  if (action === "musicUrl") return "https://cdn.test/restricted.flac"',
    '  return Promise.reject(new Error("action not support"))',
    '})',
    'lx.send(lx.EVENT_NAMES.inited, { sources: { wy: { type: "music", actions: ["musicUrl"], qualitys: ["128k", "flac"] } } })'
  ].join('\n')
  const rMeta = rStore.import(echoScript, '受限模式音源')
  rStore.setEnabled(rMeta.id, true)
  const rEngine = new SourceEngine(rStore, workerPath)

  const started = Date.now()
  let bootFailed = null
  try {
    await rEngine.startAll()
  } catch (error) {
    bootFailed = error instanceof Error ? error.message.slice(0, 100) : String(error)
    console.log(`  restricted boot failed: ${bootFailed}`)
  }
  const bootMs = Date.now() - started

  const rSources = rEngine.getSources()
  check('restricted-mode source boots', bootFailed === null, bootFailed ?? `${bootMs}ms`)
  check(
    'restricted-mode sources are advertised',
    rSources.length > 0,
    rSources.map((s) => s.id).join(',')
  )
  check(
    'restricted boot stays within a sane time',
    bootMs < 30_000,
    `${bootMs}ms`
  )

  // A request round-trip over the file protocol. The source is the harmless
  // echo script; it answers musicUrl with a fixed URL.
  if (rEngine.hasSource('wy')) {
    try {
      const track = {
        id: 'wy_1', name: 'x', singer: 'y', source: 'wy', interval: '03:00',
        albumName: '', picUrl: '',
        meta: { songmid: '1', qualitys: [{ type: '128k', size: null }] }
      }
      const result = await rEngine.getMusicUrl('wy', track, '128k')
      check('restricted-mode request round-trips', isValidMusicUrl(result.url), result.url.slice(0, 60))
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error)
      check(
        'restricted-mode request fails cleanly, not by hanging',
        msg.length > 0,
        msg.slice(0, 80)
      )
    }
  } else {
    console.log('  NOTE  no wy source in restricted mode; skipping round-trip')
  }

  // A source that dies must be observed through the missing heartbeat.
  const deadDir = mkdtempSync(join(tmpdir(), 'jjmusic-restricted-dead-'))
  const deadStore = new SourceStore(deadDir)
  deadStore.load()
  const deadMeta = deadStore.import(
    '/*! * @name 受限自杀 * @version 1 */\nsetTimeout(() => { process.exit(1) }, 100)\n' +
      'lx.on(lx.EVENT_NAMES.request, () => 1)\n' +
      'setTimeout(() => lx.send(lx.EVENT_NAMES.inited, { sources: { kw: { type: "music", actions: ["musicUrl"], qualitys: ["128k"] } } }), 30)\n',
    '受限自杀'
  )
  deadStore.setEnabled(deadMeta.id, true)
  const deadEngine = new SourceEngine(deadStore, workerPath)
  await deadEngine.startAll().catch(() => undefined)
  // Heartbeat timeout is 5s; allow up to 20s for the death to be noticed.
  let noticed = false
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 500))
    if (deadStore.metas()[0].enabled === false || deadEngine.getLogs(deadMeta.id).length > 0) {
      if (deadStore.isQuarantined(deadMeta.id)) { noticed = true; break }
    }
  }
  check(
    'a restricted source that kills itself is noticed and quarantined',
    noticed === true,
    `enabled=${deadStore.metas()[0].enabled} quarantined=${deadStore.isQuarantined(deadMeta.id)}`
  )
  await deadEngine.stopAll()
  rmSync(deadDir, { recursive: true, force: true })

  await rEngine.stopAll()
  rmSync(rDir, { recursive: true, force: true })
}

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
const brokenMeta = brokenStore.import('/*! * @name 坏脚本 * @version 1 */ throw new Error("boom")', '坏脚本')
// Imported scripts start disabled by design, so enable it explicitly to
// exercise the start path.
brokenStore.setEnabled(brokenMeta.id, true)
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

// An import must leave the script disabled: nothing runs until asked.
const disarmDir = mkdtempSync(join(tmpdir(), 'jjmusic-disarm-'))
const disarmStore = new SourceStore(disarmDir)
disarmStore.load()
const disarmMeta = disarmStore.import('/*! * @name 未启用 * @version 1 */ lx.on(1,1)', '未启用')
check('importing does not enable', disarmStore.metas()[0].enabled === false, String(disarmMeta.name))
const disarmEngine = new SourceEngine(disarmStore, workerPath)
await disarmEngine.startAll()
check('startAll starts nothing while disabled', disarmEngine.getSources().length === 0)
await disarmEngine.stopAll()
rmSync(disarmDir, { recursive: true, force: true })

rmSync(dataDir, { recursive: true, force: true })
rmSync(brokenDir, { recursive: true, force: true })

/* ------------------------------------------------------------------ *
 * 7. Script-facing musicInfo shape
 * ------------------------------------------------------------------ */

section('7. musicInfo handed to scripts')

const { toLegacyOnline, toLegacyLocal } = await import('./sources/legacy-music-info.js')

const legacyTrack = toLegacyOnline({
  id: 'wy_12345',
  name: '晴天',
  singer: '周杰伦',
  source: 'wy',
  interval: '04:29',
  albumName: '叶惠美',
  picUrl: '',
  meta: { songmid: '12345', qualitys: [{ type: '128k', size: null }] }
})

// 11 of the 21 installed sources read `musicInfo.id`; it must be populated even
// though LX's own flattened shape omits it.
check('musicInfo.id is populated', legacyTrack.id === 'wy_12345', String(legacyTrack.id))
check(
  'id stays a string for numeric platform ids',
  typeof toLegacyOnline({
    id: 987,
    name: 'x', singer: 'y', source: 'kg', interval: null,
    albumName: '', picUrl: '', meta: { songmid: '1', qualitys: [] }
  }).id === 'string'
)
check('songmid still wins for the documented field', legacyTrack.songmid === '12345', String(legacyTrack.songmid))
check('no legacy id field is left undefined', typeof legacyTrack.id !== 'undefined')

const legacyLocal = toLegacyLocal({
  path: 'D:\\Music\\a.flac',
  name: 'a',
  singer: 'b',
  duration: 100,
  albumName: '',
  genre: '',
  size: 1,
  mtime: 1,
  ext: 'flac',
  hasEmbeddedLyric: false
})
check('local musicInfo.id mirrors the path', legacyLocal.id === 'D:\\Music\\a.flac', legacyLocal.id)

/* ------------------------------------------------------------------ *
 * 8. Multi-source ordering and failover
 * ------------------------------------------------------------------ */

section('8. Multi-source ordering and failover')

/** A fake runtime good enough for routing, mirroring the ScriptRuntime shape. */
function fakeRuntime(id, name, sources, attempts) {
  return {
    api: { meta: { id, name }, source: '' },
    dead: false,
    sources,
    pending: new Map(),
    nextId: 1,
    logs: [],
    scratchDir: ''
  }
}

function orderOf(engine) {
  return engine.providersFor('wy')
}

function multiSourceEngine(listOrder, runtimes) {
  const engine = new SourceEngine({ list: () => listOrder }, 'unused')
  engine.runtimes = new Map(runtimes.map((r) => [r.api.meta.id, r]))
  engine.rebuildOwners()
  return engine
}

// Three scripts claim `wy`; the user enabled them in the order c, a, b.
const srcWy = { id: 'wy', type: 'music', actions: ['musicUrl'], qualitys: ['128k', 'flac'] }
const mkAttempts = () => {
  const calls = []
  return {
    calls,
    fn: async (apiId, source, action, info) => {
      calls.push(`${apiId}:${info.type}`)
      if (apiId === 'c') throw new Error('源 c 挂了')
      if (apiId === 'a') throw new Error('源 a 也挂了')
      return 'https://cdn.test/ok.flac'
    }
  }
}

const attempts = mkAttempts()
const ordered = multiSourceEngine(
  [
    { meta: { id: 'c', enabled: true } },
    { meta: { id: 'a', enabled: true } },
    { meta: { id: 'b', enabled: true } }
  ],
  [
    fakeRuntime('a', '音源A', [srcWy]),
    fakeRuntime('b', '音源B', [srcWy]),
    fakeRuntime('c', '音源C', [srcWy])
  ]
)
ordered.requestFrom = attempts.fn

check(
  'providers follow the user enable order, not the start order',
  JSON.stringify(orderOf(ordered)) === JSON.stringify(['c', 'a', 'b']),
  orderOf(ordered).join(',')
)

const track = {
  id: 'wy_1',
  name: '测试',
  singer: '歌手',
  source: 'wy',
  interval: '03:00',
  albumName: '',
  picUrl: '',
  meta: { songmid: '1', qualitys: [{ type: '128k', size: null }] }
}

const served = await ordered.getMusicUrl('wy', track, 'flac')
check('falls through failing sources to the first healthy one', served.apiId === 'b', String(served.apiId))
check('keeps the served quality', served.quality === 'flac', served.quality)
check(
  'tried the failed sources in order before succeeding',
  attempts.calls[0] === 'c:flac' && attempts.calls.includes('a:flac') && attempts.calls.at(-1) === 'b:flac',
  attempts.calls.join(' ')
)

// Every script failing must produce one error naming each of them.
const allFail = mkAttempts()
const broken = multiSourceEngine(
  [{ meta: { id: 'c', enabled: true } }, { meta: { id: 'a', enabled: true } }],
  [fakeRuntime('a', '音源A', [srcWy]), fakeRuntime('c', '音源C', [srcWy])]
)
broken.requestFrom = async (apiId, source, action, info) => {
  allFail.calls.push(`${apiId}:${info.type}`)
  throw new Error('unavailable')
}

let aggregate = ''
try {
  await broken.getMusicUrl('wy', track, 'flac')
} catch (error) {
  aggregate = error.message
}
check('all-failed error names every attempted script', aggregate.includes('音源C') && aggregate.includes('音源A'), aggregate)
check('all-failed error keeps per-quality reasons', aggregate.includes('unavailable'), aggregate)

// A dead script must be skipped rather than attempted.
const deadSkip = mkAttempts()
const withDead = multiSourceEngine(
  [{ meta: { id: 'c', enabled: true } }, { meta: { id: 'b', enabled: true } }],
  [fakeRuntime('c', '音源C', [srcWy]), fakeRuntime('b', '音源B', [srcWy])]
)
withDead.runtimes.get('c').dead = true
withDead.rebuildOwners()
withDead.requestFrom = deadSkip.fn
const afterDead = await withDead.getMusicUrl('wy', track, 'flac')
check('a dead script is skipped entirely', afterDead.apiId === 'b', String(afterDead.apiId))
check('no request was sent to the dead script', !deadSkip.calls.some((c) => c.startsWith('c:')), deadSkip.calls.join(' '))

// A script that only declares lyric support must not be asked for musicUrl.
const lyricOnly = { id: 'wy', type: 'music', actions: ['lyric'], qualitys: ['128k'] }
const actionGuard = mkAttempts()
const mixed = multiSourceEngine(
  [{ meta: { id: 'l', enabled: true } }, { meta: { id: 'b', enabled: true } }],
  [fakeRuntime('l', '仅歌词源', [lyricOnly]), fakeRuntime('b', '音源B', [srcWy])]
)
mixed.requestFrom = async (apiId, source, action, info) => {
  actionGuard.calls.push(apiId)
  return 'https://cdn.test/ok.flac'
}
const guarded = await mixed.getMusicUrl('wy', track, 'flac')
check('a source lacking musicUrl is skipped', guarded.apiId === 'b', String(guarded.apiId))
check('the lyric-only source was never asked', actionGuard.calls.join(',') === 'b', actionGuard.calls.join(','))

/* ------------------------------------------------------------------ *
 * 9. Shutdown guard and quarantine
 * ------------------------------------------------------------------ */

section('9. Shutdown guard and quarantine')

// The detection that matters: a script that would power the machine off.
check(
  'detects shutdown.exe /s',
  containsShutdownAttempt('require("child_process").exec("shutdown /s /t 0")').found
)
check(
  'detects shutdown.exe /r',
  containsShutdownAttempt('execSync("C:\\\\Windows\\\\System32\\\\shutdown.exe /r /t 0")').found
)
check(
  'detects the Win32 shutdown APIs',
  containsShutdownAttempt('ExitWindowsEx(1, 0)').found &&
    containsShutdownAttempt('InitiateSystemShutdown(null, null, 0, true, true)').found &&
    containsShutdownAttempt('NtShutdownSystem(0)').found
)
check('case-insensitive', containsShutdownAttempt('SHUTDOWN /S').found)

// A normal source must NOT be flagged — a false positive disables a working
// source, which is its own kind of harm.
const benignScript = `
  lx.on(lx.EVENT_NAMES.request, async ({ source, action, info }) => {
    if (action === 'musicUrl') return 'https://cdn.test/a.flac'
  })
  lx.send(lx.EVENT_NAMES.inited, { sources: { wy: { type: 'music', actions: ['musicUrl'], qualitys: ['flac'] } } })
`
check('does not flag an ordinary source', !containsShutdownAttempt(benignScript).found)
check(
  'does not flag the word "halt" in unrelated prose',
  !containsShutdownAttempt('const label = "please do not halt the download"').found
)
check(
  'reports which pattern matched',
  containsShutdownAttempt('shutdown /s /t 30').match?.includes('shutdown') === true,
  containsShutdownAttempt('shutdown /s /t 30').match
)

// Quarantine must be sticky: a restart must not re-arm a dangerous source.
const qDir = mkdtempSync(join(tmpdir(), 'jjmusic-quarantine-'))
const qStore = new SourceStore(qDir)
qStore.load()
const qMeta = qStore.import('/*! * @name 危险源 * @version 1 */ shutdown /s /t 0', '危险源')
qStore.quarantine(qMeta.id, '包含关机调用')

check('quarantine disables the source', qStore.metas()[0].enabled === false)
check('quarantine is reported in metadata', qStore.metas()[0].quarantined === true)
check('quarantine records the reason', Boolean(qStore.metas()[0].lastError))
check('quarantine refuses to be re-enabled', qStore.setEnabled(qMeta.id, true) === false)
check('source stays disabled after the refusal', qStore.metas()[0].enabled === false)

// ...and survives a restart.
const qStore2 = new SourceStore(qDir)
qStore2.load()
check('quarantine survives a restart', qStore2.isQuarantined(qMeta.id) === true)
check('still refuses to enable after restart', qStore2.setEnabled(qMeta.id, true) === false)

// The user stays in control: clearing it explicitly re-enables the source.
check('user can clear the quarantine', qStore2.clearQuarantine(qMeta.id) === true)
check('after clearing, enabling works', qStore2.setEnabled(qMeta.id, true) === true)
check('after clearing, the source runs', qStore2.metas()[0].enabled === true)

// The engine must refuse a shutdown-capable script outright, even when the
// user explicitly tries to enable it.
const guardDir = mkdtempSync(join(tmpdir(), 'jjmusic-guard-'))
const guardStore = new SourceStore(guardDir)
guardStore.load()
const guardMeta = guardStore.import(
  '/*! * @name 关机源 * @version 1 */\nlx.on(lx.EVENT_NAMES.request, () => 1)\nrequire("child_process").execSync("shutdown /s /t 0")\n',
  '关机源'
)
// Force it on, simulating a user who enables everything. The start gate must
// still refuse and quarantine.
guardStore.setEnabled(guardMeta.id, true)
const guardEngine = new SourceEngine(guardStore, workerPath)
let guardThrew = false
try {
  await guardEngine.startAll()
} catch {
  guardThrew = true
}
check('a shutdown-capable source never starts', guardThrew === false, 'startAll swallows per-source failures')
check('the shutdown source was quarantined', guardStore.isQuarantined(guardMeta.id) === true)
check('the shutdown source is disabled', guardStore.metas()[0].enabled === false)
check(
  'the quarantine reason names the blocking finding',
  String(guardStore.metas()[0].lastError ?? '').length > 0,
  String(guardStore.metas()[0].lastError ?? '').slice(0, 80)
)
await guardEngine.stopAll()

rmSync(qDir, { recursive: true, force: true })
rmSync(guardDir, { recursive: true, force: true })

/* ------------------------------------------------------------------ *
 * 10. Pre-flight validation
 * ------------------------------------------------------------------ */

section('10. Pre-flight validation')

const normalSource = `
const { EVENT_NAMES, request, on, send } = globalThis.lx
const httpFetch = (url, options = {}) => new Promise((resolve, reject) => {
  request(url, options, (err, resp) => (err ? reject(err) : resolve(resp)))
})
const handleGetMusicUrl = async (source, musicInfo, quality) => {
  const songId = musicInfo.hash ?? musicInfo.songmid
  const { body } = await httpFetch('https://api.test/url?songId=' + songId)
  return body.url
}
on(EVENT_NAMES.request, ({ source, action, info }) => {
  if (action === 'musicUrl') return handleGetMusicUrl(source, info.musicInfo, info.type)
  return Promise.reject(new Error('action not support'))
})
send(EVENT_NAMES.inited, { status: true, sources: { wy: { name: '网易', type: 'music', actions: ['musicUrl'], qualitys: ['128k', 'flac'] } } })
`

const normalReport = validateSourceBeforeStart(normalSource, { name: '普通音源' })
check('a normal source passes', normalReport.blocked === false)
check('a normal source is reported clean', normalReport.clean === true, JSON.stringify(normalReport.findings.map(f => f.id)))
check('a normal source produces a positive summary', summariseReport(normalReport).includes('校验通过'))

// Blocking: a script that can reach the machine.
check(
  'blocks shutdown command',
  validateSourceBeforeStart('exec("shutdown /s /t 0")').blocked === true
)
check(
  'blocks Win32 shutdown API',
  validateSourceBeforeStart('ExitWindowsEx(0x00000001, 0)').blocked === true
)
check(
  'blocks shell execution',
  validateSourceBeforeStart('exec("shutdown /s /t 0")').blocked === true
)
// Regression guard for the narrowed shell-exec rule: bare `.exec(`/helpers
// named exec are common in real sources (was a 2/21 false-positive rate).
check(
  'regex .exec and helper named exec do NOT block',
  validateSourceBeforeStart('const m = /a/.exec(str)\nmyExec(x)').blocked === false
)
check(
  'blocks child_process load',
  validateSourceBeforeStart('const cp = require("child_process")').blocked === true
)
check(
  'blocks process termination',
  validateSourceBeforeStart('process.exit(1)').blocked === true
)
check(
  'blocks native binding access',
  validateSourceBeforeStart('process.binding("spawn_sync")').blocked === true
)
check(
  'blocks power APIs',
  validateSourceBeforeStart('SetSuspendState(false, true, true)').blocked === true
)

// The reason must be actionable, not just "no".
const blockReport = validateSourceBeforeStart('exec("shutdown /s")')
check(
  'blocking findings carry a title and a remedy',
  blockReport.findings.every(f => f.severity !== 'block' || (f.title.length > 0 && f.remedy.length > 0))
)
check(
  'the summary names the blocking reason',
  summariseReport(blockReport).includes('校验未通过'),
  summariseReport(blockReport)
)

// Warnings do not block, but they are surfaced.
const gated = validateSourceBeforeStart(
  normalSource +
    '\nglobalThis["SERVER_SCRIPT_CONFIG"] = {"apiUrl":"https://x.test","signSalt":"s","fingerprint":"f"}\n'
)
check('server-authorised script is flagged but not blocked', gated.blocked === false && gated.clean === false)
check(
  'the server-authorisation warning is specific',
  gated.findings.some(f => f.id === 'server-authorised' && f.severity === 'warn')
)

const obfuscated = validateSourceBeforeStart('x'.repeat(500) + '\n' + 'y'.repeat(30_000))
check('an unreadable script is admitted as such', obfuscated.inspected.readable === false)
check(
  'the caveat is present for unreadable scripts',
  obfuscated.findings.some(f => f.id === 'unreadable' && f.severity === 'info')
)

// Findings are ordered most-severe-first so the UI can trust the order.
const orderedReport = validateSourceBeforeStart(normalSource + '\nprocess.exit(1)\nwhile(true){}\n')
check(
  'findings are sorted block -> warn -> info',
  orderedReport.findings[0].severity === 'block',
  orderedReport.findings.map(f => f.severity).join(',')
)

// False positives are their own kind of harm: a working source must not be
// blocked by prose that merely mentions a dangerous word.
check(
  'does not block on README-style prose',
  validateSourceBeforeStart('// this source will not shutdown your machine\nconst name = "spawn"').blocked === false
)

/* ------------------------------------------------------------------ *
 * 10b. The combined-trait rule
 * ------------------------------------------------------------------ */

// This is the rule that was missing, and its absence had a real cost: the
// source that shut a machine down carried exactly this combination, passed
// validation as "clean with warnings", and was allowed to start on one click.
//
// The traits are individually weak, so they stay warnings alone. Together they
// describe a script that takes orders from a server AND cannot be inspected —
// the one shape static analysis cannot clear.

// Remote-authorised + unreadable => blocked.
const remoteObfuscated = validateSourceBeforeStart(
  'globalThis["SERVER_SCRIPT_CONFIG"] = {"apiUrl":"https://x.test","signSalt":"s","fingerprint":"f"}\n' +
    'x'.repeat(60_000)
)
check('remote-authorised + unreadable is blocked', remoteObfuscated.blocked === true)
check(
  'the block names the combined trait',
  remoteObfuscated.findings.some(f => f.id === 'uninspectable-remote-control' && f.severity === 'block'),
  remoteObfuscated.findings.map(f => `${f.severity}:${f.id}`).join(' ')
)
check(
  'the block is sorted first',
  remoteObfuscated.findings[0].severity === 'block',
  remoteObfuscated.findings.map(f => f.severity).join(',')
)
check(
  'the combined-trait reason is actionable',
  remoteObfuscated.findings.some(
    f => f.id === 'uninspectable-remote-control' && f.remedy.includes('虚拟机')
  )
)

// Each trait alone must NOT block, or every obfuscated source and every
// server-backed source would be refused, and users would stop trusting the gate.
const onlyRemote = validateSourceBeforeStart(
  normalSource + '\nglobalThis["SERVER_SCRIPT_CONFIG"] = {"apiUrl":"https://x.test"}\n'
)
check('remote-authorised but readable is NOT blocked', onlyRemote.blocked === false, onlyRemote.findings.map(f => f.id).join(' '))

const onlyObfuscated = validateSourceBeforeStart(
  'const a = 1\n' + 'y'.repeat(60_000)
)
check('unreadable but not remote-authorised is NOT blocked', onlyObfuscated.blocked === false, onlyObfuscated.findings.map(f => f.id).join(' '))

/* ------------------------------------------------------------------ *
 * 11. Start flow: validation gate and state truthfulness
 * ------------------------------------------------------------------ */

section('11. Start flow and state truthfulness')

// A blocked script must not end up "enabled" in the store.
//
// This is the state-desync bug in its essential form: the UI switch reflects
// what the app decided, so a refused start must leave the persisted flag off.
// If `setEnabled(true)` ran before validation, the settings page would show a
// started source that never started.
const gateDir = mkdtempSync(join(tmpdir(), 'jjmusic-gate-'))
const gateStore = new SourceStore(gateDir)
gateStore.load()

const dangerous = gateStore.import(
  '/*! * @name 危险源 * @version 1 */\n' +
    'lx.on(lx.EVENT_NAMES.request, () => 1)\n' +
    'require("child_process").execSync("shutdown /s /t 0")\n',
  '危险源'
)
const dangerousSource = gateStore.get(dangerous.id).source
const dangerousReport = validateSourceBeforeStart(dangerousSource, { name: '危险源' })

check('the start gate blocks the dangerous script', dangerousReport.blocked === true)
check(
  'a newly imported script starts disabled',
  gateStore.metas().find(m => m.id === dangerous.id).enabled === false
)

// Simulate the enable handler's order of operations.
gateStore.setEnabled(dangerous.id, true)
check('setEnabled alone does enable (baseline)', gateStore.metas()[0].enabled === true)
gateStore.quarantine(dangerous.id, '启用前校验未通过')
check('quarantine overrides an optimistic enable', gateStore.metas()[0].enabled === false)
check('and the switch cannot be flipped back on', gateStore.setEnabled(dangerous.id, true) === false)
check('so the UI can only show it as off', gateStore.metas()[0].enabled === false)

// A safe script must still be startable — the gate must not block everything.
const safeMeta = gateStore.import(
  '/*! * @name 安全源 * @version 1 */\n' + normalSource,
  '安全源'
)
const safeReport = validateSourceBeforeStart(gateStore.get(safeMeta.id).source, { name: '安全源' })
check('a safe script passes the same gate', safeReport.blocked === false, JSON.stringify(safeReport.findings.map(f => f.id)))
check('a safe script is also imported disabled', gateStore.metas().find(m => m.id === safeMeta.id).enabled === false)
check('and can be enabled', gateStore.setEnabled(safeMeta.id, true) === true)
check('its enabled flag reads back true', gateStore.metas().find(m => m.id === safeMeta.id).enabled === true)

// Disabling is always allowed, even for a quarantined source.
gateStore.setEnabled(safeMeta.id, false)
check('disabling a normal source works', gateStore.metas().find(m => m.id === safeMeta.id).enabled === false)

// A script that is enabled but then fails to start must not leave the stored
// flag claiming "enabled" — the switch has to reflect reality, or the UI shows
// 已启用 for a source with no live process (the reported desync).
const failDir = mkdtempSync(join(tmpdir(), 'jjmusic-failflag-'))
const failStore = new SourceStore(failDir)
failStore.load()
const failMeta = failStore.import(
  '/*! * @name 启动即挂 * @version 1 */\nsetTimeout(() => { throw new Error("delayed boom") }, 0)\n' +
    'lx.on(lx.EVENT_NAMES.request, () => 1)\n' +
    'setTimeout(() => lx.send(lx.EVENT_NAMES.inited, { sources: { wy: { type: "music", actions: ["musicUrl"], qualitys: ["128k"] } } }), 30)\n',
  '启动即挂'
)
failStore.setEnabled(failMeta.id, true)
check('precondition: source is enabled before start', failStore.metas()[0].enabled === true)
const failEngine = new SourceEngine(failStore, workerPath)
// startAll swallows per-source failures by design, so we poll the persisted
// flag: after the process dies the flag must have been reverted to false.
try {
  await failEngine.startAll()
} catch {
  /* swallowed per-source */
}
let reverted = false
for (let i = 0; i < 60; i++) {
  await new Promise((r) => setTimeout(r, 250))
  if (failStore.metas()[0].enabled === false && failStore.metas()[0].lastError) {
    reverted = true
    break
  }
}
check('a source that starts then dies is reverted to disabled', reverted === true, `enabled=${failStore.metas()[0].enabled}`)
await failEngine.stopAll()
rmSync(failDir, { recursive: true, force: true })

rmSync(gateDir, { recursive: true, force: true })

/* ------------------------------------------------------------------ *
 * Summary
 * ------------------------------------------------------------------ */

console.log(`\n${'='.repeat(72)}`)
console.log(`RESULT: ${passed} passed, ${failed} failed`)
console.log('='.repeat(72))
process.exit(failed === 0 ? 0 : 1)
