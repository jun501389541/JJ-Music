/**
 * Determine whether the dev-only E2E hook is actually reachable at runtime.
 *
 * A naive text search for `__jj_player` is not sufficient: Vite compiles
 * `import.meta.env['VITE_E2E'] === '1'` into a property access on an inlined
 * env object, so the identifier appears in the bundle even when the guard is
 * permanently false. What matters is whether the assignment can execute.
 *
 * This launches the built app and asks the renderer directly.
 *
 * Usage: node tools/probe/probe-hook.mjs
 */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const DEBUG_PORT = 9223
const packaged = process.argv.includes('--packaged')
const electronBin = packaged ? join(repoRoot, 'release', 'win-unpacked', 'JJ Music.exe') : join(
  repoRoot,
  'node_modules',
  'electron',
  'dist',
  process.platform === 'win32' ? 'electron.exe' : 'electron'
)

if (!existsSync(electronBin)) {
  console.error('electron binary not found')
  process.exit(1)
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function waitForTarget(timeoutMs = 40_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`)
      const page = (await res.json()).find(
        (t) => t.type === 'page' && !t.url.startsWith('devtools://')
      )
      if (page?.webSocketDebuggerUrl) return page
    } catch {
      /* retry */
    }
    await sleep(400)
  }
  throw new Error('renderer target never appeared')
}

function connect(url) {
  return new Promise((resolvePromise, reject) => {
    const socket = new WebSocket(url)
    let nextId = 1
    const pending = new Map()
    socket.addEventListener('message', (event) => {
      const message = JSON.parse(event.data)
      const entry = pending.get(message.id)
      if (!entry) return
      pending.delete(message.id)
      if (message.error) entry.reject(new Error(message.error.message))
      else entry.resolve(message.result)
    })
    socket.addEventListener('error', () => reject(new Error('socket error')))
    socket.addEventListener('open', () =>
      resolvePromise((method, params = {}) => {
        const id = nextId++
        return new Promise((res, rej) => {
          pending.set(id, { resolve: res, reject: rej })
          socket.send(JSON.stringify({ id, method, params }))
          setTimeout(() => {
            if (pending.delete(id)) rej(new Error(`timeout: ${method}`))
          }, 20_000)
        })
      })
    )
  })
}

// Report the environment the clean build actually carries.
const target = await (async () => {
  const child = spawn(electronBin, packaged ? [] : ['.'], {
    cwd: repoRoot,
    stdio: 'inherit',
    env: { ...process.env, JJ_DEBUG_PORT: String(DEBUG_PORT), ELECTRON_RUN_AS_NODE: undefined }
  })
  try {
    return { child, page: await waitForTarget() }
  } catch (error) {
    child.kill()
    throw error
  }
})()

const send = await connect(target.page.webSocketDebuggerUrl)
await send('Runtime.enable')
await sleep(3500)

const result = await send('Runtime.evaluate', {
  // `import.meta` is not valid in a classic script evaluation, so only the
  // window probes are included.
  expression: `JSON.stringify({
    hookPlayer: typeof window.__jj_player,
    hookLibrary: typeof window.__jj_library,
    bridge: typeof window.jj,
    shellReady: !!document.querySelector('.shell'),
    heading: document.querySelector('h1')?.textContent
  })`,
  returnByValue: true
})

const parsed = JSON.parse(result.result.value)
console.log('runtime probe of the built app:')
console.log(`  typeof window.__jj_player  = ${parsed.hookPlayer}`)
console.log(`  typeof window.__jj_library = ${parsed.hookLibrary}`)

console.log(`  app UI: ${parsed.shellReady ? 'ready' : 'missing'}, bridge: ${parsed.bridge}, heading: ${parsed.heading}`)
const reachable = parsed.hookPlayer !== 'undefined' || parsed.hookLibrary !== 'undefined'
console.log(`\nE2E hook reachable in this build: ${reachable ? 'YES (test build)' : 'NO (clean build)'}`)

target.child.kill()
await sleep(400)
process.exit(reachable || !parsed.shellReady || parsed.bridge !== 'object' ? 1 : 0)
