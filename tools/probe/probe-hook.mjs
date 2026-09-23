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
import { createServer } from 'node:net'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')

/**
 * Ask the OS for a port rather than assuming 9223 is free.
 *
 * A fixed number here once failed with `bind() … (0x271D)` / `Cannot start http
 * server for devtools` because the previous run's DevTools endpoint had not
 * finished letting go of it. That reads as "the app never started", which is a
 * lie — the app started fine and simply had no port to answer on. `tools/e2e-verify.mjs`
 * already asks this way; the two probes should not disagree about it.
 */
function findFreePort() {
  return new Promise((resolvePort, reject) => {
    const server = createServer()
    server.unref()
    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      server.close(() => resolvePort(port))
    })
  })
}

const DEBUG_PORT = Number(process.env.JJ_DEBUG_PORT ?? (await findFreePort()))
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
async function main() {
  /*
   * Its own profile, for two reasons. The app takes a single-instance lock per
   * data directory, so launching against the default one while any other JJ
   * Music window is open makes this copy exit before it ever creates a
   * renderer — the probe then has nothing to read. And this probe has no
   * business writing to the user's real library, settings or resume point just
   * to look at two window properties.
   */
  const profile = join(repoRoot, '.cache', 'hook-probe-profile')
  const child = spawn(electronBin, packaged ? [] : ['.', `--user-data-dir=${profile}`], {
    cwd: repoRoot,
    stdio: 'inherit',
    /*
     * `JJ_ALLOW_DEBUG_PORT` is only needed for `--packaged`: a shipped build
     * ignores `JJ_DEBUG_PORT` on its own, so that an inherited environment
     * variable cannot open a CDP port in a build a user downloaded. A probe
     * that deliberately targets the packaged exe says so explicitly.
     */
    env: {
      ...process.env,
      JJ_DEBUG_PORT: String(DEBUG_PORT),
      JJ_ALLOW_DEBUG_PORT: packaged ? '1' : undefined,
      ELECTRON_RUN_AS_NODE: undefined
    }
  })
  let page
  try {
    page = await waitForTarget()
  } catch (error) {
    child.kill()
    throw error
  }

  const send = await connect(page.webSocketDebuggerUrl)
  await send('Runtime.enable')
  await sleep(3500)

  /*
   * `__jj_search` lives in SearchView, and that route chunk is lazily loaded — on a
   * freshly launched app the component has never mounted, so the global is absent even
   * in a fully instrumented build. Asking about it before navigating would let an
   * instrumented build pass as "clean", which is the one mistake this check must not
   * make. So mount the view first, then ask.
   */
  await send('Runtime.evaluate', {
    expression: `document.querySelector('#app').__vue_app__.config.globalProperties.$router.push('/search')`,
    returnByValue: true
  })
  await sleep(1500)

  const result = await send('Runtime.evaluate', {
    // `import.meta` is not valid in a classic script evaluation, so only the
    // window probes are included.
    expression: `JSON.stringify({
    hookPlayer: typeof window.__jj_player,
    hookLibrary: typeof window.__jj_library,
    hookSearch: typeof window.__jj_search,
    searchMounted: !!document.querySelector('.search-view'),
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
  console.log(`  typeof window.__jj_search  = ${parsed.hookSearch}  (搜索视图已挂载=${parsed.searchMounted})`)

  console.log(`  app UI: ${parsed.shellReady ? 'ready' : 'missing'}, bridge: ${parsed.bridge}, heading: ${parsed.heading}`)
  // `searchMounted` is part of the verdict: if the view never came up, the absence of
  // `__jj_search` proves nothing about the build and must not be read as "clean".
  const reachable = parsed.hookPlayer !== 'undefined' || parsed.hookLibrary !== 'undefined' || parsed.hookSearch !== 'undefined'
  console.log(`\nE2E hook reachable in this build: ${reachable ? 'YES (test build)' : 'NO (clean build)'}`)

  child.kill()
  await sleep(400)
  return reachable || !parsed.shellReady || !parsed.searchMounted || parsed.bridge !== 'object' ? 1 : 0
}

/**
 * Exit codes: 0 = clean build, 1 = the hook really is reachable, 2 = nothing was
 * judged.
 *
 * Those two failures used to share code 1, so "the app never started" was
 * reported as "the shipping build leaks a test hook" — a security-flavoured
 * conclusion drawn from a launch problem. The common launch problem is another
 * JJ Music window already being open: the single-instance lock makes this
 * copy exit at once, and no renderer target ever appears on the port.
 */
main().then(
  (code) => process.exit(code),
  (error) => {
    console.error(`\n无法判断生产构建里有没有测试钩子：${error.message}`)
    console.error('（这不代表钩子存在。先确认没有别的 JJ Music 窗口开着，再重跑。）')
    process.exit(2)
  }
)
