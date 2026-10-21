/** Official packaged updater acceptance. Launched only by the guarded CI PowerShell fixture. */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { openSync, closeSync } from 'node:fs'
import { readFile, writeFile, readdir, realpath, lstat } from 'node:fs/promises'
import { join, resolve, dirname } from 'node:path'
import { createServer } from 'node:net'

// Refuse before writes or process creation, including direct invocation on a daily host.
if (process.platform !== 'win32' || process.env.GITHUB_ACTIONS !== 'true' ||
    process.env.RUNNER_ENVIRONMENT !== 'github-hosted' || process.env.RUNNER_OS !== 'Windows') {
  throw new Error('CI_ONLY_REFUSAL: requires disposable GitHub-hosted Windows')
}
const root = resolve(process.env.OR8_UPDATER_ROOT ?? '')
assert.equal(dirname(root).toLowerCase(), resolve(process.env.RUNNER_TEMP).toLowerCase())
assert.match(root.split(/[\\/]/).at(-1), /^or8-updater-[0-9a-f-]{36}$/)
assert.equal((await realpath(root)).toLowerCase(), root.toLowerCase())
const owner = JSON.parse(await readFile(join(root, 'owner.json'), 'utf8'))
assert.equal(owner.runId, process.env.GITHUB_RUN_ID)
assert.equal(owner.root, root)
const profile = resolve(process.env.APPDATA, 'jj-music')
assert.equal(owner.profile.toLowerCase(), profile.toLowerCase())
const exe = join(root, 'Installed', 'JJ Music', 'JJ Music.exe')
const targetHash = '709387aef5fbc0fee15de5a2e24f0824d6e5b7f0ed678e13b8d9a672351cbe2c'
const report = { kind: 'official-packaged-updater', status: 'running', started: new Date().toISOString(), root,
  oldVersion: '0.4.2', targetVersion: '0.4.5', stages: [], checks: [] }
const sleep = ms => new Promise(done => setTimeout(done, ms))
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
let ws, child, stage = 'launch', evaluate
async function persist() { await writeFile(join(root, 'updater-report.json'), JSON.stringify(report, null, 2)) }
async function record(name, value) {
  stage = name; report.stages.push({ stage, time: new Date().toISOString(), value }); await persist()
}
function check(name, condition) { assert.ok(condition, name); report.checks.push(name) }
const port = await new Promise((done, reject) => {
  const server = createServer(); server.once('error', reject)
  server.listen(0, '127.0.0.1', () => { const value = server.address().port; server.close(() => done(value)) })
})
async function connect(timeout = 60_000) {
  const deadline = Date.now() + timeout
  let target
  while (Date.now() < deadline) {
    try {
      target = (await (await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(1000) })).json())
        .find(item => item.type === 'page' && item.url.startsWith('file:'))
      if (target?.webSocketDebuggerUrl) break
    } catch {}
    await sleep(300)
  }
  assert.ok(target?.webSocketDebuggerUrl, 'Packaged renderer CDP target available')
  const endpoint = new URL(target.webSocketDebuggerUrl)
  assert.ok(['127.0.0.1', 'localhost'].includes(endpoint.hostname))
  assert.equal(endpoint.port, String(port))
  ws = new WebSocket(endpoint)
  const pending = new Map(); let next = 0
  ws.addEventListener('message', event => {
    const message = JSON.parse(event.data), request = pending.get(message.id)
    if (!request) return
    pending.delete(message.id); clearTimeout(request.timer)
    message.error ? request.reject(new Error(message.error.message)) : request.done(message.result)
  })
  ws.addEventListener('close', () => {
    for (const request of pending.values()) { clearTimeout(request.timer); request.reject(new Error('CDP closed')) }
    pending.clear()
  })
  await new Promise((done, reject) => {
    const timer = setTimeout(() => reject(new Error('CDP open timeout')), 5000)
    ws.addEventListener('open', () => { clearTimeout(timer); done() }, { once: true })
    ws.addEventListener('error', () => { clearTimeout(timer); reject(new Error('CDP open failed')) }, { once: true })
  })
  const command = (method, params, timeout = 20_000) => new Promise((done, reject) => {
    const id = ++next, timer = setTimeout(() => { pending.delete(id); reject(new Error(`${method} timed out`)) }, timeout)
    pending.set(id, { done, reject, timer }); ws.send(JSON.stringify({ id, method, params }))
  })
  evaluate = async (expression, timeout) => {
    const result = await command('Runtime.evaluate', { expression: `(async()=>(${expression}))()`, returnByValue: true, awaitPromise: true }, timeout)
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text)
    return result.result.value
  }
  for (let i = 0; i < 100; i++) {
    if (await evaluate('!!window.jj?.updates && !!document.querySelector("h1")')) return command
    await sleep(200)
  }
  throw new Error('Packaged renderer never became ready')
}
async function screenshot(command, name) {
  const shot = await command('Page.captureScreenshot', { format: 'png' })
  await writeFile(join(root, `${name}.png`), Buffer.from(shot.data, 'base64'))
}
async function waitForStartupCheck(readStatus, { timeout = 180_000, pause = sleep, now = Date.now } = {}) {
  const deadline = now() + timeout
  for (;;) {
    const state = await readStatus()
    if (state.phase === 'unavailable' || state.phase === 'error') {
      throw new Error(`BLOCKED: published baseline startup updater ${state.phase}; no retry, gate or key changes`)
    }
    if (state.phase !== 'checking' && state.phase !== 'downloading') return state
    if (now() >= deadline) throw new Error(`Startup updater ${state.phase} did not settle within ${timeout}ms`)
    await pause(300)
  }
}
async function cacheInventory() {
  const files = []
  async function visit(dir) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      if (entry.isSymbolicLink()) throw new Error('Cache link refused')
      const info = await lstat(path)
      assert.equal(info.isSymbolicLink(), false)
      if (entry.isDirectory()) await visit(path)
      else if (entry.isFile() && /\.(exe|json|yml|log)$/i.test(entry.name)) {
        files.push({ path, size: info.size, sha256: sha(await readFile(path)) })
      }
    }
  }
  await visit(join(root, 'LocalAppData'))
  return files
}
try {
  const log = openSync(join(root, 'application.log'), 'w')
  try {
    child = spawn(exe, ['--disable-background-networking'], {
      cwd: dirname(exe), windowsHide: true, stdio: ['ignore', log, log],
      env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined, NODE_OPTIONS: undefined,
        JJ_ALLOW_DEBUG_PORT: '1', JJ_DEBUG_PORT: String(port) }
    })
    child.on('error', error => { report.launchError = error.message })
  } finally { closeSync(log) }
  const oldPid = child.pid
  await record('old-launched', { pid: oldPid, port })
  let command = await connect()
  check('default synthetic profile selected', resolve((await evaluate('window.jj.data.location()')).dir).toLowerCase() === profile.toLowerCase())
  check('no source scripts loaded', (await evaluate('window.jj.sources.list()')).length === 0)
  const status = await evaluate('window.jj.updates.status()')
  await record('old-updater-status', status)
  await screenshot(command, 'old-installed')
  check('published baseline version is 0.4.2', status.currentVersion === '0.4.2')
  assert.notEqual(status.phase, 'unavailable', 'BLOCKED: published baseline updater unavailable; no gates or keys will be changed')
  check('old reads synthetic volume', (await evaluate('window.jj.settings.get()')).volume === 0.37)
  check('old reads synthetic pending lyric', (await evaluate('window.jj.assets.pending()'))[0]?.lyric === '[00:01]OR8 updater synthetic lyric')
  const playlist = await evaluate('window.jj.playlists.create("OR8 updater synthetic playlist")')
  await record('synthetic-profile-read', { playlist })
  // did-finish-load starts the production check automatically. Let that task
  // settle before an explicit check, which legitimately rejects concurrent work.
  stage = 'startup-check-settle'
  const settled = await waitForStartupCheck(() => evaluate('window.jj.updates.status()'))
  await record('startup-check-settled', settled)
  stage = 'check'
  const available = await evaluate('window.jj.updates.check()', 180_000)
  await record('check', available)
  check('actual official check offers exactly 0.4.5', available.phase === 'available' && available.version === '0.4.5')
  stage = 'download'
  const ready = await evaluate('window.jj.updates.download()', 300_000)
  await record('download', ready)
  check('actual production downloader reaches ready', ready.phase === 'ready' && ready.version === '0.4.5')
  const files = await cacheInventory()
  await record('download-cache', files)
  const installers = files.filter(item => item.sha256 === targetHash && item.path.endsWith('.exe'))
  check('exact official 0.4.5 Setup SHA256 downloaded', installers.length === 1)
  await screenshot(command, 'ready-to-install')
  // The supervisor will touch UI only for this exact verified file and its pinned hash.
  await writeFile(join(root, 'installer-request.json'), JSON.stringify({ path: installers[0].path, sha256: targetHash }))
  await record('install-requested', { installer: installers[0], oldPid })
  stage = 'install'
  // Installer deliberately terminates this renderer; an IPC disconnect is expected.
  await evaluate('window.jj.updates.install()', 15_000).catch(error => { report.installDisconnect = error.message })
  ws.close(); ws = undefined
  const exited = Date.now() + 30_000
  while (Date.now() < exited && child.exitCode === null && child.signalCode === null) await sleep(200)
  check('old process exited after production install request', child.exitCode !== null || child.signalCode !== null)
  await record('old-exited', { pid: oldPid, code: child.exitCode })
  stage = 'restart'
  command = await connect(240_000)
  const after = await evaluate('window.jj.updates.status()')
  await record('restarted-status', after)
  check('installer restarted actual version 0.4.5', after.currentVersion === '0.4.5')
  check('restart retains synthetic profile location', resolve((await evaluate('window.jj.data.location()')).dir).toLowerCase() === profile.toLowerCase())
  const settings = await evaluate('window.jj.settings.get()')
  check('restart preserves theme and volume', settings.theme === 'light' && settings.volume === 0.37)
  check('restart preserves synthetic pending lyric', (await evaluate('window.jj.assets.pending()'))[0]?.lyric === '[00:01]OR8 updater synthetic lyric')
  check('restart preserves created playlist', (await evaluate('window.jj.playlists.list()')).some(item => item.id === playlist.id && item.name === playlist.name))
  check('restart still has no source scripts', (await evaluate('window.jj.sources.list()')).length === 0)
  check('synthetic media sentinel unchanged', await readFile(join(root, 'synthetic.wav'), 'utf8') === 'OR8 SYNTHETIC ONLY')
  await screenshot(command, 'restarted-upgraded')
  await evaluate('window.jj.window.close()').catch(() => {})
  report.status = 'passed'
} catch (error) {
  report.status = 'failed'; report.failedStage = stage; report.error = error.stack ?? String(error)
  if (evaluate && ws?.readyState === WebSocket.OPEN) {
    try { report.failureStatus = await evaluate('window.jj.updates.status()') } catch {}
    try { await evaluate('window.jj.window.close()') } catch {}
  }
  try { report.failureCache = await cacheInventory() } catch {}
  process.exitCode = 1
} finally {
  ws?.close()
  report.finished = new Date().toISOString(); await persist()
  // No broad process killing or fixture deletion; the disposable runner is destroyed.
  // A failed CDP connection may leave the owned app alive. Retain it for CI
  // diagnosis without keeping this completed controller alive until its timeout.
  child?.unref()
  console.log(JSON.stringify({ status: report.status, failedStage: report.failedStage, checks: report.checks.length, error: report.error }))
}
