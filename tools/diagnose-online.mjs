/**
 * Diagnose online playback: is the 音源 engine broken, or are the upstream
 * relays dead?
 *
 * These are very different problems with very different fixes, and from the
 * outside they look identical ("playback doesn't work"). This script separates
 * them:
 *
 *   A. A **synthetic** source script that returns a fixed URL. If this resolves,
 *      the engine, sandbox, worker bridge, quality ladder and validators all
 *      work —any remaining failure is upstream.
 *   B. The **user's real** source, driven through every advertised platform with
 *      a real track, reporting each failure verbatim.
 *
 * Usage: node tools/diagnose-online.mjs
 */
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

// `import()` on Windows requires a file:// URL; a bare `D:\...` path is
// rejected as an unsupported scheme.
const load = (relative) =>
  import(pathToFileURL(join(repoRoot, 'out', 'test', relative)).href)

const { SourceStore } = await load('sources/source-store.js')
const { SourceEngine } = await load('sources/source-engine.js')

const WORKER = join(repoRoot, 'out', 'test', 'source-host.cjs')

if (!existsSync(WORKER)) {
  console.error('engine bundle missing. Run: node tools/build-test.mjs')
  process.exit(1)
}

/** A minimal, well-formed source script. Mirrors what LX scripts look like. */
const SYNTHETIC = `/*!
 * @name 引擎鑷音源
 * @description returns a fixed URL to prove the engine works
 * @version 1.0.0
 * @author diagnose
 */
const { EVENT_NAMES, on, send } = globalThis.lx
on(EVENT_NAMES.request, ({ source, action, info }) => {
  if (action !== 'musicUrl') return Promise.reject(new Error('action not support'))
  // Echo the requested quality back so the ladder is observable.
  return Promise.resolve('https://example.com/probe-' + info.type + '.mp3')
})
send(EVENT_NAMES.inited, {
  status: true,
  openDevTools: false,
  sources: {
    kw: { name: 'kw', type: 'music', actions: ['musicUrl'], qualitys: ['128k', '320k', 'flac'] },
    tx: { name: 'tx', type: 'music', actions: ['musicUrl'], qualitys: ['128k', '320k', 'flac'] },
    wy: { name: 'wy', type: 'music', actions: ['musicUrl'], qualitys: ['128k', '320k'] },
    kg: { name: 'kg', type: 'music', actions: ['musicUrl'], qualitys: ['128k', '320k'] },
    mg: { name: 'mg', type: 'music', actions: ['musicUrl'], qualitys: ['128k', '320k'] }
  }
})
`

const TRACK = {
  id: 'kw_474678847',
  name: '花海',
  singer: '周杰伦,
  source: 'kw',
  interval: '03:30',
  albumName: '',
  picUrl: '',
  meta: { songmid: '474678847', qualitys: [{ type: '128k' }, { type: '320k' }] }
}

let problems = 0

function heading(text) {
  console.log(`\n${'='.repeat(72)}\n${text}\n${'='.repeat(72)}`)
}

/* ------------------------------------------------------------------ *
 * A. Engine self-test with a synthetic source
 * ------------------------------------------------------------------ */

heading('A. 引擎鑷（合成音源，不依赖任何上游）')

const tmpA = mkdtempSync(join(tmpdir(), 'jj-diag-engine-'))
const storeA = new SourceStore(tmpA)
storeA.load()
storeA.import(SYNTHETIC, '引擎鑷音源')
const engineA = new SourceEngine(storeA, WORKER)

try {
  await engineA.startAll()
  const sources = engineA.getSources()
  console.log(`  worker 鍚姩锛屽０鏄庡钩鍙? ${sources.map((s) => s.id).join(', ') || '(无'}`)

  if (sources.length === 0) {
    console.log('  ✗引擎鏈敹鍒颁换浣曞钩鍙板０鏄?——这是引擎问题')
    problems += 1
  } else {
    console.log('  ✗引擎鍚姩骞舵敹鍒板钩鍙板０鏄?)
  }

  // The ladder should hand back the highest tier the source advertises.
  for (const quality of ['flac', '320k', '128k']) {
    try {
      const result = await engineA.getMusicUrl('kw', TRACK, quality)
      const expected = `probe-${result.quality}.mp3`
      const ok = result.url.includes(expected)
      console.log(
        `  ${ok ? '✗ : '✗} 请求 ${quality} →实际 ${result.quality}: ${result.url}`
      )
      if (!ok) problems += 1
    } catch (error) {
      console.log(`  ✗请求 ${quality} 失败: ${error.message}`)
      problems += 1
    }
  }

  // A source that throws must not break the engine.
  const storeErr = new SourceStore(mkdtempSync(join(tmpdir(), 'jj-diag-err-')))
  storeErr.load()
  storeErr.import(
    '/*! * @name 鎶涢敊音源 * @version 1 */ const {on,EVENT_NAMES,send}=globalThis.lx;' +
      'on(EVENT_NAMES.request,()=>{throw new Error("boom")});' +
      'send(EVENT_NAMES.inited,{sources:{kw:{type:"music",actions:["musicUrl"],qualitys:["128k"]}}})',
    '鎶涢敊音源'
  )
  const engineErr = new SourceEngine(storeErr, WORKER)
  await engineErr.startAll()
  try {
    await engineErr.getMusicUrl('kw', TRACK, '128k')
    console.log('  ✗鎶涢敊音源绔熺劧返回浜嗙粨鏋?)
    problems += 1
  } catch (error) {
    console.log(`  ✗鎶涢敊音源琚纭姤鍛? ${error.message.slice(0, 80)}`)
  }
  await engineErr.stopAll()
} catch (error) {
  console.log(`  ✗引擎鑷异常: ${error.message}`)
  problems += 1
} finally {
  await engineA.stopAll()
  rmSync(tmpA, { recursive: true, force: true })
}

/* ------------------------------------------------------------------ *
 * B. The user's real source
 * ------------------------------------------------------------------ */

heading('B. 你的真实音源')

const appData = process.env.APPDATA ?? ''
const realFile = join(appData, 'jj-music', 'sources', 'user_api.json')
const lxFile = join(appData, 'lx-music-desktop', 'LxDatas', 'user_api.json')

let sourceFile = null
if (existsSync(realFile)) sourceFile = realFile
else if (existsSync(lxFile)) sourceFile = lxFile

if (!sourceFile) {
  console.log('  鎵句笉鍒伴煶婧愭枃浠讹紝璺宠繃')
} else {
  console.log(`  鏂囦欢: ${sourceFile}`)
  const tmpB = mkdtempSync(join(tmpdir(), 'jj-diag-real-'))
  const storeB = new SourceStore(tmpB)
  storeB.load()
  const imported = storeB.importLxFile(readFileSync(sourceFile, 'utf8'))
  console.log(`  瀵煎叆: ${imported.map((m) => `${m.name} v${m.version}`).join(', ')}`)

  const engineB = new SourceEngine(storeB, WORKER)
  try {
    await engineB.startAll()
    const sources = engineB.getSources()
    console.log(`  婢圭増妲戦獮鍐插酱: ${sources.map((s) => `${s.id}(${s.qualitys.join('/')})`).join(', ')}`)

    if (sources.length === 0) {
      console.log('  ✗真实音源鏈０鏄庝换浣曞钩鍙?)
      problems += 1
    }

    // Try every platform with a plausible track so we see which ones answer.
    const probes = [
      { source: 'kw', meta: { songmid: '474678847' }, name: '花海' },
      { source: 'tx', meta: { songmid: '0039MnYb0qxYhV' }, name: '鏅村ぉ' },
      { source: 'wy', meta: { songmid: '186016' }, name: '鏅村ぉ' },
      { source: 'kg', meta: { hash: 'A1B2C3D4E5F6', songmid: '1' }, name: 'test' },
      { source: 'mg', meta: { copyrightId: '600908000001234567' }, name: 'test' }
    ]

    for (const probe of probes) {
      if (!engineB.hasSource(probe.source)) {
        console.log(`  —${probe.source}: 璇ラ煶婧愭湭鎻愪緵姝ゅ钩鍙癭)
        continue
      }
      const track = {
        id: `${probe.source}_x`,
        name: probe.name,
        singer: '周杰伦,
        source: probe.source,
        meta: { ...probe.meta, qualitys: [{ type: '128k' }] }
      }
      const started = Date.now()
      try {
        const result = await engineB.getMusicUrl(probe.source, track, '128k')
        const ms = Date.now() - started
        console.log(`  ✗${probe.source}: ${result.quality} →${result.url.slice(0, 90)}  (${ms} ms)`)
      } catch (error) {
        const ms = Date.now() - started
        console.log(`  ✗${probe.source}: ${error.message.slice(0, 300)}`)
        console.log(`      (${ms} ms)`)
      }
    }

    // Surface what the script itself logged —that is where an aggregator
    // explains which of its backends failed.
    const logs = engineB.getLogs(imported[0]?.id ?? '')
    if (logs.length > 0) {
      console.log(`\n  鑴氭湰鏃ュ織锛堟渶鍚?${Math.min(12, logs.length)} 鏉★級:`)
      for (const line of logs.slice(-12)) {
        console.log(`    ${line.slice(0, 200)}`)
      }
    }
  } catch (error) {
    console.log(`  ✗真实音源鍚姩失败: ${error.message}`)
    problems += 1
  } finally {
    await engineB.stopAll()
    rmSync(tmpB, { recursive: true, force: true })
  }
}

/* ------------------------------------------------------------------ *
 * Verdict
 * ------------------------------------------------------------------ */

heading('缁撹')
if (problems === 0) {
  console.log('  引擎鑷全部通过 →引擎鏈韩娌℃湁问銆?)
  console.log('  鑻ョ湡瀹為煶婧愪粛无法取到地址锛岄棶棰樺湪上游涓浆服务鍣紝需要佹洿鎹㈤煶婧愩€?)
} else {
  console.log(`  鍙戠幇 ${problems} 涓紩鎿庡眰闈㈢殑问锛岄渶瑕佷慨澶嶃€俙)
}
process.exit(problems === 0 ? 0 : 1)
