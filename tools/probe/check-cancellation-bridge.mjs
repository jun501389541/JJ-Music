/** Smoke-check the cloneable cancellation id across Electron contextBridge. */
import { spawn, spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..', '..')
const profile = mkdtempSync(join(tmpdir(), 'jj-cancel-bridge-'))
const port = await new Promise((resolvePort, reject) => {
  const server = createServer()
  server.on('error', reject)
  server.listen(0, '127.0.0.1', () => {
    const selected = server.address().port
    server.close(() => resolvePort(selected))
  })
})
const electron = join(root, 'node_modules', 'electron', 'dist', 'electron.exe')
const child = spawn(electron, ['.', `--user-data-dir=${profile}`], {
  cwd: root,
  stdio: 'ignore',
  windowsHide: true,
  env: { ...process.env, JJ_DEBUG_PORT: String(port), ELECTRON_RUN_AS_NODE: undefined }
})

let socket
try {
  let target
  for (let i = 0; i < 80 && !target; i++) {
    try {
      const pages = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
      target = pages.find(page => page.type === 'page' && page.webSocketDebuggerUrl)
    } catch { /* waiting for Electron */ }
    if (!target) await new Promise(resolveDelay => setTimeout(resolveDelay, 250))
  }
  if (!target) throw new Error('renderer did not start')
  socket = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((resolveOpen, reject) => {
    socket.addEventListener('open', resolveOpen, { once: true })
    socket.addEventListener('error', reject, { once: true })
  })
  await new Promise(resolveDelay => setTimeout(resolveDelay, 2500))
  const answer = new Promise((resolveAnswer, reject) => {
    const timeout = setTimeout(() => reject(new Error('CDP evaluation timed out')), 10000)
    socket.addEventListener('message', event => {
      const message = JSON.parse(event.data)
      if (message.id !== 1) return
      clearTimeout(timeout)
      if (message.result?.exceptionDetails) reject(new Error(message.result.exceptionDetails.text))
      else resolveAnswer(message.result?.result?.value)
    })
  })
  socket.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: {
    expression: `(async () => {
      const id = 'search-' + Date.now() + '-1';
      if (typeof window.jj.music.cancel !== 'function') return 'cancel method missing';
      window.jj.music.cancel(id);
      try { await window.jj.music.search('tx', '', 1, id); return 'unexpected success' }
      catch (error) { return error.message }
    })()`, awaitPromise: true, returnByValue: true
  } }))
  const result = await answer
  if (typeof result !== 'string' || !result.includes('IPC 参数无效')) throw new Error(`cancellation bridge failed: ${result}`)
  console.log(result)
} finally {
  socket?.close()
  if (process.platform === 'win32' && child.pid) {
    spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
  } else child.kill()
  await new Promise(resolveExit => {
    if (child.exitCode !== null) return resolveExit()
    child.once('exit', resolveExit)
    setTimeout(resolveExit, 3000)
  })
  if (dirname(resolve(profile)) === resolve(tmpdir()) && basename(profile).startsWith('jj-cancel-bridge-')) {
    rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
  }
}
