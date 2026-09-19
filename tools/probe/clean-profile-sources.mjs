/**
 * Clean-profile source smoke: the check that was missing.
 *
 * Every existing local check starts from the developer's own data. Even
 * `salt-ui-smoke.mjs` copies `settings.json`, `library/` and `sources/` into its
 * temp profile, so the sources it reports as "enabled" were enabled by hand
 * long ago, on an install that predates the startup validator. A downloaded
 * build on another machine does none of that: it starts empty, the scripts are
 * imported fresh, and every one of them then has to pass validation and be
 * switched on. That is the path this exercises, against the packaged exe rather
 * than `out/`.
 *
 * Usage:
 *   node tools/probe/clean-profile-sources.mjs
 *   node tools/probe/clean-profile-sources.mjs --app=release/win-unpacked
 *   node tools/probe/clean-profile-sources.mjs --limit=3      # first 3 scripts
 *   node tools/probe/clean-profile-sources.mjs --keep        # keep the profile
 */
import { spawn } from 'node:child_process'
import { createServer } from 'node:net'
import { createServer as createHttpServer } from 'node:http'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { SYNTHETIC_SOURCE_NAME, syntheticSource } from './synthetic-source.mjs'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const arg = (name, fallback) => process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback
const appDir = resolve(repoRoot, arg('app', join('release', 'win-unpacked')))
const exe = join(appDir, 'JJ Music.exe')
const limit = Number(arg('limit', '0')) || Infinity
const keep = process.argv.includes('--keep')

if (!existsSync(exe)) {
  console.error(`找不到打包程序: ${exe}\n先运行 npm run pack`)
  process.exit(1)
}

/* ------------------------------------------------------------------ *
 * Which scripts to import
 * ------------------------------------------------------------------ */

const synthetic = process.argv.includes('--synthetic')

/** A different marker per platform, so a failure says which one broke. */
const markers = Object.fromEntries(
  ['kw', 'kg', 'tx', 'wy', 'mg'].map((id) => [id, `${id}-${Date.now().toString(36)}`])
)
/** Paths the forked host actually requested; proof its network stack worked. */
const served = []

let markerServer = null
let base = ''
if (synthetic) {
  markerServer = createHttpServer((request, response) => {
    const path = request.url ?? ''
    served.push(path)
    if (path.startsWith('/marker/')) {
      response.writeHead(200, { 'content-type': 'text/plain' })
      response.end('jj-selfcheck')
      return
    }
    response.writeHead(200, { 'content-type': 'audio/mpeg', 'content-length': '4' })
    response.end('ID3')
  })
  await new Promise((done) => markerServer.listen(0, '127.0.0.1', done))
  base = `http://127.0.0.1:${markerServer.address().port}`
}

let entries
if (synthetic) {
  entries = [{ name: SYNTHETIC_SOURCE_NAME, script: syntheticSource(base, markers) }]
  console.log(`样本: 自检合成音源（不依赖任何私有脚本），标记服务 ${base}\n`)
} else {
  const devStore = join(process.env.APPDATA ?? '', 'jj-music', 'sources', 'user_api.json')
  if (!existsSync(devStore)) {
    console.error(`本机没有已导入的音源可用作样本: ${devStore}`)
    process.exit(1)
  }
  entries = (JSON.parse(readFileSync(devStore, 'utf8').replace(/^﻿/, '')).userApis ?? []).slice(0, limit)
  console.log(`样本: ${entries.length} 个音源脚本（取自本机已导入列表，按原样重新导入）\n`)
}

// `import()` accepts LX's own `gz_`+base64 form and a bare script, so hand it
// the same string a user's pasted file would carry rather than decoding and
// re-encoding it.
const payloadOf = (entry) => String(entry.script ?? '')

/* ------------------------------------------------------------------ *
 * Launch the packaged app with a profile that has never existed
 * ------------------------------------------------------------------ */

const profile = mkdtempSync(join(tmpdir(), 'jj-clean-profile-'))
const port = await new Promise((ok, no) => {
  const s = createServer()
  s.on('error', no)
  s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => ok(p)) })
})

const child = spawn(exe, [`--user-data-dir=${profile}`], {
  cwd: appDir,
  stdio: 'ignore',
  env: { ...process.env, JJ_DEBUG_PORT: String(port), ELECTRON_RUN_AS_NODE: undefined }
})
child.on('error', (error) => { console.error('无法启动打包程序:', error.message); process.exit(1) })

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function waitForTarget(timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/list`)
      const list = await res.json()
      const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl)
      if (page) return page
    } catch { /* the port is not listening yet */ }
    if (child.exitCode !== null) throw new Error(`应用已退出，退出码 ${child.exitCode}`)
    await sleep(400)
  }
  throw new Error('等不到可调试的渲染目标')
}

const target = await waitForTarget()
const ws = new WebSocket(target.webSocketDebuggerUrl)
await new Promise((ok, no) => { ws.addEventListener('open', ok, { once: true }); ws.addEventListener('error', no, { once: true }) })

let nextId = 1
const pending = new Map()
ws.addEventListener('message', (event) => {
  const message = JSON.parse(event.data)
  if (message.id && pending.has(message.id)) {
    const { ok, no } = pending.get(message.id)
    pending.delete(message.id)
    message.error ? no(new Error(message.error.message)) : ok(message.result)
  }
})

const send = (method, params) => new Promise((ok, no) => {
  const id = nextId++
  pending.set(id, { ok, no })
  ws.send(JSON.stringify({ id, method, params }))
})

/** Evaluate in the page, surfacing a thrown page-side error rather than swallowing it. */
const evaluate = async (expression) => {
  const response = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
  if (response.exceptionDetails) {
    throw new Error(response.exceptionDetails.exception?.description ?? response.exceptionDetails.text)
  }
  return response.result.value
}

let failures = 0
const report = (mark, label, detail = '') => {
  console.log(`  ${mark} ${label}${detail ? `  ${detail}` : ''}`)
  if (mark === 'x') failures += 1
}

try {
  /* ---------------- 1. the bridge is really there ---------------- */
  const bridge = await evaluate(`typeof window.jj?.sources?.import === 'function' && typeof window.jj?.sources?.toggle === 'function'`)
  report(bridge ? 'ok' : 'x', 'window.jj 音源接口在打包版可用')

  /* ---------------- 2. import each script from scratch ---------------- */
  const imported = []
  for (const entry of entries) {
    const payload = payloadOf(entry)
    if (!payload) { report('x', `${entry.name}: 样本里没有脚本文本`); continue }
    const encoded = JSON.stringify(payload)
    const result = await evaluate(`(async () => {
      try { const m = await window.jj.sources.import(${encoded}, ${JSON.stringify(entry.name)}); return { ok: true, id: m.id, enabled: m.enabled === true, quarantined: m.quarantined === true } }
      catch (error) { return { ok: false, message: String(error?.message ?? error) } }
    })()`)
    if (result.ok) { imported.push({ name: entry.name, ...result }); report('ok', `导入 ${entry.name}`, `id=${result.id}`) }
    else { report('x', `导入 ${entry.name} 失败`, result.message.slice(0, 140)) }
  }

  /* ---------------- 3. enabling must actually start them ---------------- */
  for (const source of imported) {
    const result = await evaluate(`(async () => {
      try { return await window.jj.sources.toggle(${JSON.stringify(source.id)}, true) }
      catch (error) { return { ok: false, reason: String(error?.message ?? error) } }
    })()`)
    const accepted = result?.ok !== false
    report(accepted ? 'ok' : 'x', `启用 ${source.name}`, accepted
      ? (result?.validation?.status ? `校验=${result.validation.status}` : '')
      : `被拒绝: ${(result?.reason ?? '').slice(0, 160)}`)
    if (!accepted) {
      const verdict = JSON.stringify(result?.validation ?? result, null, 0).slice(0, 400)
      if (verdict !== '{}') console.log(`      校验详情 ${verdict}`)
    }
  }

  /* ---------------- 4. platforms must actually be advertised ---------------- */
  await sleep(20_000)
  const available = await evaluate(`window.jj.sources.available()`)
  const ids = (available ?? []).map((s) => s.id)
  console.log(`\n  声明的平台: ${ids.join(', ') || '(无)'}`)
  report(ids.length > 0 ? 'ok' : 'x', '启动后确实有平台可用', `${ids.length} 个`)

  /* ---------------- 5. online playback must resolve for real ---------------- */
  // Defect this check found, deliberately not fixed here:
  //
  //   `ARCHITECTURE.md` section 1.5 says lx.request returns "a function that is
  //   also a thenable" so both `const cancel = request(...)` and
  //   `await request(...)` work. The host builds that with
  //   `Object.assign(cancel, promise)` (source-host.ts:290), but `then` lives on
  //   the Promise prototype and is not an own property, so Object.assign copies
  //   nothing and the result is callable but not awaitable.
  //
  //   Measured: chaining `.then` on it throws
  //   "request(...).then is not a function"; awaiting it yields the function
  //   itself rather than the response. Real scripts happen to use the
  //   three-argument callback form, which is why this has stayed unnoticed.
  //   The synthetic source below therefore uses the callback form too -- so this
  //   check exercises the API as scripts use it, not as the doc claims it works.
  if (synthetic) {
    // Ask for a tier above the floor on purpose: a ladder that quietly falls
    // back to 128k would still play, and would hide a source that cannot
    // actually serve what it declared.
    const expected = `${base}/probe-320k.mp3`
    const result = await evaluate(`(async () => {
      const track = { id: 'kw_selfcheck', name: '自检', singer: '自检', source: 'kw',
        meta: { songmid: 'selfcheck', qualitys: [{ type: '128k' }, { type: '320k' }] } }
      try { const url = await window.jj.music.url('kw', track, '320k'); return { ok: true, quality: url.quality, url: String(url.url) } }
      catch (error) { return { ok: false, message: String(error?.message ?? error) } }
    })()`)

    report(result.ok && result.url === expected ? 'ok' : 'x', '自检音源解析出播放地址',
      result.ok ? `${result.quality} ${result.url}` : (result.message ?? '').slice(0, 220))
    report(result.quality === '320k' ? 'ok' : 'x', '音质阶梯未擅自降档', String(result.quality ?? '(无)'))
    // The strongest signal here: the forked child really issued a request, so
    // the unpacked host, its sandbox, lx.request and the Buffer path all work.
    report(served.includes('/marker/' + markers.kw) ? 'ok' : 'x', 'fork 子进程确实发出 lx.request',
      served.length ? served.join(' ') : '服务未收到任何请求')
  } else if (ids.length > 0) {
    // Upstream relays fail occasionally; one AbortError is not a broken build,
    // so retry before reporting. Without this the check cries wolf.
    let probe = null
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      probe = await evaluate(`(async () => {
        const first = (await window.jj.sources.available())[0]
        if (!first) return { skipped: '没有平台可用' }
        const page = await window.jj.music.search(first.id, '周杰伦', 1).catch((error) => ({ searchError: String(error?.message ?? error) }))
        if (page?.searchError) return { source: first.id, note: page.searchError }
        const track = (page.list ?? [])[0]
        if (!track) return { source: first.id, note: '搜索没有返回结果（宿主搜索与音源无关）' }
        try {
          const url = await window.jj.music.url(first.id, track, '128k')
          return { source: first.id, quality: url.quality, head: String(url.url).slice(0, 60) }
        } catch (error) { return { source: first.id, error: String(error?.message ?? error).slice(0, 220) } }
      })()`)
      if (probe?.quality) break
      if (attempt === 1) await sleep(3_000)
    }
    if (probe?.quality) report('ok', `在线播放地址解析 ${probe.source}`, `${probe.quality} ${probe.head}`)
    else report('x', `在线播放地址解析 ${probe.source ?? ''}`, probe?.error ?? probe?.note ?? JSON.stringify(probe))
  }

  /* ---------------- 6. per-source logs, when a source is sick ---------------- */
  const dead = await evaluate(`(async () => {
    const metas = await window.jj.sources.list()
    const out = []
    for (const m of metas) {
      const logs = await window.jj.sources.logs(m.id).catch(() => [])
      if (m.enabled !== true || (logs ?? []).some((l) => /失败|错误|error|退出/i.test(l))) out.push({ id: m.id, name: m.name, enabled: m.enabled, quarantined: m.quarantined, tail: (logs ?? []).slice(-3) })
    }
    return out
  })()`)
  if (dead.length > 0) {
    console.log('\n  状态异常的音源:')
    for (const d of dead.slice(0, 8)) console.log(`    - ${d.name} enabled=${d.enabled} quarantined=${d.quarantined} ${(d.tail ?? []).join(' | ').slice(0, 160)}`)
  }
} finally {
  child.kill()
  markerServer?.close()
  await sleep(500)
  if (keep) console.log(`\n保留配置目录: ${profile}`)
  else rmSync(profile, { recursive: true, force: true })
  ws.close()
}

console.log(`\n未通过项: ${failures}`)
process.exit(failures === 0 ? 0 : 1)
