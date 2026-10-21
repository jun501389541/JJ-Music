/**
 * Production Electron UI acceptance for one public Netease or QQ playlist.
 *
 * This starts the already-built app with an owned --user-data-dir and uses the
 * renderer's visible controls for import, refresh preview, discard, and apply.
 * No daily profile, original audio files, or source scripts are opened.
 */
import { createHash, randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { createServer } from 'node:net'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import { setTimeout as delay } from 'node:timers/promises'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const platform = process.argv.find(arg => arg.startsWith('--source='))?.slice(9) ?? 'wy'
if (!['wy', 'tx'].includes(platform)) throw new Error('Only --source=wy or --source=tx is supported')
const outputRoot = join(root, '.cache/or8-delivery/live')
const runId = `${new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-')}-${randomUUID().slice(0, 8)}`
const runRoot = join(outputRoot, `ui-${runId}`)
const profile = join(runRoot, 'user-data')
const bundle = join(runRoot, 'url-guard.mjs')
const reportFile = join(outputRoot, platform === 'wy' ? 'or8-live-ui-acceptance.json' : 'or8-live-ui-tx-acceptance.json')
const report = {
  runId,
  startedAt: new Date().toISOString(),
  status: 'running',
  scope: 'production Electron renderer controls and preload/main IPC; isolated userData',
  source: platform,
  remoteCount: null,
  localSeededViaPreloadIpc: false,
  preview: 'not-run',
  cancel: 'not-run',
  apply: 'not-run',
  finalLocalCount: null,
  idsSha256: null,
  profileRemoved: false,
  errors: []
}

await mkdir(runRoot, { recursive: true })
await mkdir(outputRoot, { recursive: true })
const saveReport = async () => {
  const bytes = JSON.stringify(report, null, 2)
  await Promise.all([writeFile(reportFile, bytes, 'utf8'), writeFile(join(runRoot, 'report.json'), bytes, 'utf8')])
}
const sha256 = (value) => createHash('sha256').update(value).digest('hex')
const ensure = (condition, code) => { if (!condition) throw new Error(code) }
const safeError = (error) => {
  const message = error instanceof Error ? error.message : String(error)
  if (/timeout|timed out/i.test(message)) return 'timeout'
  if (/blocked|internal|credential|not allowed/i.test(message)) return 'guarded'
  if (/HTTP|status|403|404|5\d\d/i.test(message)) return 'http-failure'
  if (/schema|JSON|parse/i.test(message)) return 'schema-failure'
  if (/preview|refresh|playlist/i.test(message)) return 'playlist-flow-failure'
  return 'ui-flow-failure'
}

async function compileGuard() {
  await build({
    entryPoints: [join(root, 'src/main/online/url-guard.ts')],
    outfile: bundle,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node24',
    packages: 'external',
    logLevel: 'silent'
  })
  return import(`${pathToFileURL(bundle).href}?run=${runId}`)
}

async function discoverSample(guard) {
  if (platform === 'tx') {
    const url = new URL('https://c.y.qq.com/soso/fcgi-bin/client_music_search_songlist')
    url.search = new URLSearchParams({remoteplace:'txt.yqq.playlist',format:'json',page_no:'0',num_per_page:'20',query:'10首歌'}).toString()
    const result = await guard.safeFetchBytes(url, {
      timeoutMs:12_000,maxBytes:512*1024,allowedHosts:['c.y.qq.com'],
      init:{headers:{Referer:'https://y.qq.com/','User-Agent':'Mozilla/5.0'}}
    })
    const text = result.body.toString('utf8')
    const data = JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1))
    const rows = data?.data?.songlist?.list ?? data?.data?.list ?? data?.songlist?.list ?? data?.list ?? []
    ensure(Array.isArray(rows), 'schema')
    const candidates = rows.flatMap(row => {
      const id = String(row?.dissid ?? row?.diss_id ?? row?.tid ?? row?.id ?? '')
      const count = Number(row?.song_count ?? row?.songnum ?? row?.total_song_num)
      return /^\d{1,20}$/.test(id) && Number.isSafeInteger(count) && count >= 3 && count <= 30
        ? [{id,expectedCount:count,origin:'official-platform-public-list'}] : []
    })
    ensure(candidates.length > 0, 'playlist-no-small-public-sample')
    return candidates[0]
  }
  const url = new URL('https://music.163.com/api/search/get')
  url.search = new URLSearchParams({ type: '1000', s: '轻音乐', limit: '20', offset: '0' }).toString()
  const checked = guard.assertPublicHttpUrl(url, ['music.163.com'])
  const response = await guard.safeFetchBytes(checked, {
    timeoutMs: 12_000,
    maxBytes: 512 * 1024,
    allowedHosts: ['music.163.com'],
    init: { headers: { Referer: 'https://music.163.com/', 'User-Agent': 'Mozilla/5.0' } }
  })
  const text = response.body.toString('utf8')
  const start = text.indexOf('{'), end = text.lastIndexOf('}')
  ensure(start >= 0 && end >= start, 'schema')
  const data = JSON.parse(text.slice(start, end + 1))
  const rows = data?.result?.playlists ?? data?.result?.playlist ?? []
  ensure(Array.isArray(rows), 'schema')
  const candidates = rows.flatMap((row) => {
    const id = String(row?.id ?? '')
    const count = Number(row?.trackCount ?? row?.trackcount ?? row?.track_num)
    return /^\d{1,20}$/.test(id) && Number.isSafeInteger(count) && count >= 3 && count <= 30
      ? [{ id, expectedCount: count }]
      : []
  })
  if (candidates.length) return { ...candidates[0], origin: 'official-platform-search' }
  return { id: '5379775210', expectedCount: null, origin: 'previously-saved-public-sample' }
}

async function freePort() {
  const server = createServer()
  await new Promise((resolvePromise, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolvePromise)
  })
  const port = server.address().port
  await new Promise((resolvePromise) => server.close(resolvePromise))
  return port
}

async function waitForDebugger(port, child) {
  const deadline = Date.now() + 35_000
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error('electron-exited-before-debugger')
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(1000) })
      if (response.ok) {
        const targets = await response.json()
        const target = targets.find((item) => item.type === 'page' && item.webSocketDebuggerUrl && item.url?.split(/[?#]/)[0] === pathToFileURL(join(root, 'out/renderer/index.html')).href)
        if (target) return target.webSocketDebuggerUrl
      }
    } catch { /* startup has not opened its local debugging port yet */ }
    await delay(250)
  }
  throw new Error('debugger-timeout')
}

function connectCdp(webSocketUrl) {
  const ws = new WebSocket(webSocketUrl)
  const pending = new Map()
  let sequence = 0
  const opened = new Promise((resolvePromise, reject) => {
    ws.addEventListener('open', resolvePromise, { once: true })
    ws.addEventListener('error', () => reject(new Error('cdp-connect-failed')), { once: true })
  })
  ws.addEventListener('message', (event) => {
    let message
    try { message = JSON.parse(event.data) } catch { return }
    if (message.id === undefined) return
    const task = pending.get(message.id)
    if (!task) return
    pending.delete(message.id)
    if (message.error) task.reject(new Error('cdp-command-failed'))
    else task.resolve(message.result)
  })
  ws.addEventListener('close', () => {
    for (const task of pending.values()) task.reject(new Error('cdp-closed'))
    pending.clear()
  })
  return {
    async ready() { await opened },
    send(method, params = {}) {
      const id = ++sequence
      return new Promise((resolvePromise, reject) => {
        if (ws.readyState !== WebSocket.OPEN) return reject(new Error('cdp-closed'))
        const timer = setTimeout(() => { pending.delete(id); reject(new Error('cdp-command-timeout')) }, 15_000)
        pending.set(id, {
          resolve: (value) => { clearTimeout(timer); resolvePromise(value) },
          reject: (error) => { clearTimeout(timer); reject(error) }
        })
        ws.send(JSON.stringify({ id, method, params }))
      })
    },
    close() { try { ws.close() } catch { /* already closed */ } }
  }
}

async function evaluate(cdp, expression) {
  const result = await cdp.send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
    userGesture: true
  })
  if (result.exceptionDetails) throw new Error('ui-evaluation-failed')
  return result.result?.value
}

async function waitUntil(cdp, expression, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const value = await evaluate(cdp, expression)
      if (value) return value
    } catch { /* the renderer may still be mounting */ }
    await delay(250)
  }
  throw new Error('ui-wait-timeout')
}

async function openRefreshPreview(cdp) {
  for (let attempt = 0; attempt < 2; attempt++) {
    await evaluate(cdp, 'Array.from(document.querySelectorAll(".refresh-panel button")).find((button)=>button.textContent.includes("预览远程更改")).click()')
    const state = await waitUntil(cdp, 'document.querySelector(".refresh-result") ? "ready" : document.querySelector(".refresh-error")?.textContent', 50_000)
    if (state === 'ready') return
    // Background metadata commits can invalidate a preview; honor the UI's
    // explicit instruction once, never suppress another error or bypass CAS.
    ensure(attempt === 0 && state.includes('歌单已变更，请重新预览'), 'playlist-refresh-rejected')
    report.previewConflictRetries = (report.previewConflictRetries ?? 0) + 1
  }
}

let child
let cdp
let listId = null
let profileRemoved = false
let stage = 'discover-sample'
try {
  const sample = await discoverSample(await compileGuard())
  report.sampleOrigin = sample.origin
  report.expectedCount = sample.expectedCount

  stage = 'start-electron'
  const electron = join(root, 'node_modules/electron/dist/electron.exe')
  const port = await freePort()
  child = spawn(electron, [
    `--user-data-dir=${profile}`,
    root
  ], {
    cwd: root, stdio: 'ignore', windowsHide: true,
    // Production strips CLI debug switches; use its explicit opt-in pair.
    env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined, NODE_OPTIONS: undefined, JJ_ALLOW_DEBUG_PORT: '1', JJ_DEBUG_PORT: String(port) }
  })
  const debugUrl = await waitForDebugger(port, child)
  cdp = connectCdp(debugUrl)
  await cdp.ready()
  await cdp.send('Page.enable')
  await cdp.send('Runtime.enable')
  stage = 'wait-renderer'
  await waitUntil(cdp, '!!window.jj && !!document.querySelector("body")')
  await waitUntil(cdp, 'Array.from(document.querySelectorAll("a")).some((a)=>a.getAttribute("href")?.endsWith("/playlist-import"))')

  stage = 'open-import-ui'
  await evaluate(cdp, 'Array.from(document.querySelectorAll("a")).find((a)=>a.getAttribute("href")?.endsWith("/playlist-import")).click()')
  await waitUntil(cdp, '!!document.querySelector(".import-form select") && !!document.querySelector(".import-form input")')
  stage = 'import-public-sample'
  await evaluate(cdp, `(()=>{const s=document.querySelector('.import-form select');s.value=${JSON.stringify(platform)};s.dispatchEvent(new Event('change',{bubbles:true}));const i=document.querySelector('.import-form input');i.value=${JSON.stringify(sample.id)};i.dispatchEvent(new Event('input',{bubbles:true}));return true})()`)
  await waitUntil(cdp, '!document.querySelector(".import-form button").disabled')
  await evaluate(cdp, 'document.querySelector(".import-form button").click()')
  const preview = await waitUntil(cdp, 'document.querySelector("section.preview") && !document.querySelector(".import-form button").disabled ? document.querySelector(".preview__title p")?.innerText : null', 50_000)
  const readCount = Number(preview.match(/已读取\s*(\d+)/)?.[1])
  ensure(Number.isInteger(readCount) && readCount >= 3 && readCount <= 150, 'playlist-read-out-of-budget')
  report.remoteCount = readCount

  stage = 'save-imported-playlist'
  await evaluate(cdp, 'document.querySelector(".preview__buttons button.btn--primary").click()')
  await waitUntil(cdp, 'location.href.includes("/playlist/") && !!document.querySelector(".refresh-panel button")', 30_000)
  stage = 'seed-local-difference'
  const playlist = await evaluate(cdp, `window.jj.playlists.list().then((items)=>items.filter((item)=>item.source===${JSON.stringify(platform)}&&item.sourceListId).map((item)=>({id:item.id,count:item.trackCount})))`)
  ensure(Array.isArray(playlist) && playlist.length === 1, 'imported-playlist-not-found')
  listId = playlist[0].id
  const beforeItems = await evaluate(cdp, `window.jj.playlists.items(${JSON.stringify(listId)})`)
  ensure(Array.isArray(beforeItems) && beforeItems.length === readCount, 'import-count-mismatch')

  const removed = await evaluate(cdp, `window.jj.playlists.removeTracks(${JSON.stringify(listId)},[${JSON.stringify(beforeItems[0].id)}])`)
  ensure(removed === 1, 'local-difference-seed-failed')
  report.localSeededViaPreloadIpc = true
  await waitUntil(cdp, `window.jj.playlists.items(${JSON.stringify(listId)}).then((items)=>items.length===${readCount - 1})`)

  stage = 'ui-preview'
  await openRefreshPreview(cdp)
  const previewText = await evaluate(cdp, 'document.querySelector(".refresh-result")?.innerText ?? ""')
  ensure(previewText.includes(`本地 ${readCount - 1} 首 → 远程 ${readCount} 首`), 'refresh-preview-count-mismatch')
  report.preview = 'ready-with-one-added-track'

  stage = 'ui-cancel-preview'
  await evaluate(cdp, 'Array.from(document.querySelectorAll(".refresh-result button")).find((button)=>button.textContent.includes("关闭预览")).click()')
  await waitUntil(cdp, '!document.querySelector(".refresh-result")')
  const countAfterCancel = await evaluate(cdp, `window.jj.playlists.items(${JSON.stringify(listId)}).then((items)=>items.length)`)
  ensure(countAfterCancel === readCount - 1, 'cancel-mutated-local-playlist')
  report.cancel = 'closed-preview-preserved-local-playlist'

  stage = 'ui-preview-again'
  await openRefreshPreview(cdp)
  const secondText = await evaluate(cdp, 'document.querySelector(".refresh-result")?.innerText ?? ""')
  ensure(secondText.includes(`本地 ${readCount - 1} 首 → 远程 ${readCount} 首`), 'second-preview-count-mismatch')
  stage = 'ui-apply'
  await waitUntil(cdp, '!!document.querySelector(".refresh-result button.btn--primary") && !document.querySelector(".refresh-result button.btn--primary").disabled')
  await evaluate(cdp, 'document.querySelector(".refresh-result button.btn--primary").click()')
  await waitUntil(cdp, 'Array.from(document.querySelectorAll("[role=dialog]")).some(d=>d.getAttribute("aria-label")==="应用远程歌单更改")')
  await evaluate(cdp, 'document.querySelector("[role=dialog] button.btn--primary").click()')
  await waitUntil(cdp, '!document.querySelector(".refresh-result")', 50_000)
  const finalItems = await evaluate(cdp, `window.jj.playlists.items(${JSON.stringify(listId)})`)
  ensure(Array.isArray(finalItems) && finalItems.length === readCount, 'apply-count-mismatch')
  report.apply = 'applied-complete-snapshot-through-ui'
  report.finalLocalCount = finalItems.length
  report.idsSha256 = sha256(Buffer.from(finalItems.map((item) => item.id).join('\n')))

  stage = 'cleanup-playlist'
  await evaluate(cdp, `window.jj.playlists.remove(${JSON.stringify(listId)})`)
  const remaining = await evaluate(cdp, 'window.jj.playlists.list()')
  ensure(Array.isArray(remaining) && !remaining.some((item) => item.id === listId), 'playlist-cleanup-failed')
  report.status = 'completed'
} catch (error) {
  report.status = 'completed-with-blockers'
  report.errors.push({ stage, reason: safeError(error) })
  if (cdp) {
    try {
      report.uiFailure = await evaluate(cdp, `(()=>({refreshError:document.querySelector('.refresh-error')?.textContent?.replace(/https?:\\/\\/\\S+/g,'[url]').slice(0,200)??null,controls:Array.from(document.querySelectorAll('.refresh-panel button')).map(b=>({text:b.textContent,disabled:b.disabled})),hasResult:!!document.querySelector('.refresh-result')}))()`)
    } catch { /* closed renderer */ }
  }
  if (stage === 'start-electron' && child) report.launch = { exitCode: child.exitCode, signal: child.signalCode }
} finally {
  await saveReport()
  try { await cdp?.send('Browser.close') } catch { cdp?.close() }
  cdp?.close()
  if (child && child.exitCode === null) {
    await Promise.race([
      new Promise((resolvePromise) => child.once('exit', resolvePromise)),
      delay(5_000)
    ])
    if (child.exitCode === null && process.platform === 'win32') {
      await new Promise((resolvePromise) => {
        const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
        killer.once('exit', resolvePromise)
      })
    } else if (child.exitCode === null) child.kill('SIGTERM')
  }
  try {
    await rm(profile, { recursive: true, force: true })
    profileRemoved = true
  } catch { profileRemoved = false }
  report.profileRemoved = profileRemoved
  report.finishedAt = new Date().toISOString()
  try { await rm(bundle, { force: true }) } catch { /* report the acceptance outcome */ }
  await saveReport()
  console.log(JSON.stringify({ reportFile, status: report.status, source: report.source, sampleOrigin: report.sampleOrigin, remoteCount: report.remoteCount, preview: report.preview, cancel: report.cancel, apply: report.apply, profileRemoved: report.profileRemoved, errors: report.errors }))
}
