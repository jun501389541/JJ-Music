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
import { copyFileSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import zlib from 'node:zlib'

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
 * The scripts a new user would import
 * ------------------------------------------------------------------ */

const devStore = join(process.env.APPDATA ?? '', 'jj-music', 'sources', 'user_api.json')
if (!existsSync(devStore)) {
  console.error(`本机没有已导入的音源可用作样本: ${devStore}`)
  process.exit(1)
}
const entries = (JSON.parse(readFileSync(devStore, 'utf8').replace(/^﻿/, '')).userApis ?? []).slice(0, limit)
console.log(`样本: ${entries.length} 个音源脚本（取自本机已导入列表，按原样重新导入）\n`)

const payloadOf = (entry) => {
  const script = String(entry.script ?? '')
  // `import()` accepts LX's own `gz_`+base64 form, so hand it the same string a
  // user's pasted file would carry rather than decoding and re-encoding.
  return script
}

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
  if (ids.length > 0) {
    const probe = await evaluate(`(async () => {
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
  await sleep(500)
  if (keep) console.log(`\n保留配置目录: ${profile}`)
  else rmSync(profile, { recursive: true, force: true })
  ws.close()
}

console.log(`\n未通过项: ${failures}`)
process.exit(failures === 0 ? 0 : 1)
