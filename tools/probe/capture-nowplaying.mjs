/**
 * Launch the app, start playback, open the now-playing overlay, and capture it.
 *
 * A screenshot of the lyric panel is the only way to confirm the embedded-lyric
 * work actually reaches the screen: the backend tests prove the data is parsed,
 * but not that the view renders it, follows the clock, or shows the right
 * source badge.
 *
 * Requires a build made with VITE_E2E=1 (see tools/run-e2e.mjs).
 *
 * Usage: node tools/probe/capture-nowplaying.mjs [outputPath]
 */
import { spawn, spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { createServer } from 'node:net'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const outFile = process.argv[2] ?? join(repoRoot, 'docs', 'research', 'screenshots', 'now-playing.png')
const electronBin = join(
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

const port = await new Promise((res) => {
  const server = createServer()
  server.listen(0, '127.0.0.1', () => {
    const p = server.address().port
    server.close(() => res(p))
  })
})

async function waitForTarget(timeoutMs = 40_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`)
      const page = (await response.json()).find(
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
  return new Promise((resolveConn, reject) => {
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
      resolveConn((method, params = {}) => {
        const id = nextId++
        return new Promise((res, rej) => {
          pending.set(id, { resolve: res, reject: rej })
          socket.send(JSON.stringify({ id, method, params }))
          setTimeout(() => {
            if (pending.delete(id)) rej(new Error(`timeout: ${method}`))
          }, 30_000)
        })
      })
    )
  })
}

const child = spawn(electronBin, ['.'], {
  cwd: repoRoot,
  stdio: 'inherit',
  env: {
    ...process.env,
    JJ_DEBUG_PORT: String(port),
    ELECTRON_RUN_AS_NODE: undefined,
    VITE_E2E: '1'
  }
})

try {
  const target = await waitForTarget()
  const send = await connect(target.webSocketDebuggerUrl)
  await send('Runtime.enable')
  await sleep(4500)

  const evaluate = async (expression) => {
    const result = await send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true
    })
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description)
    return result.result.value
  }

  // Start a track with embedded lyrics and let it play a little.
  const started = await evaluate(
    `(async () => {
       const tracks = await window.jj.library.tracks()
       const track = tracks.find(t => t.hasSyncedLyric) || tracks[0]
       await window.__jj_player.playTrack(track)
       return track.name
     })()`
  )
  console.log(`playing: ${started}`)

  // Wait until the lyric panel actually has lines, so the capture shows content.
  for (let i = 0; i < 40; i += 1) {
    await sleep(500)
    const ready = await evaluate(
      `(() => {
         const m = window.__jj_player
         return m.lyrics && m.lyrics.lines.length > 0 && m.currentTime > 2
       })()`
    )
    if (ready) break
  }

  const state = await evaluate(
    `(() => {
       const m = window.__jj_player
       return JSON.stringify({
         t: Math.round(m.currentTime),
         source: m.lyricSource,
         lines: m.lyrics ? m.lyrics.lines.length : 0,
         active: m.activeLyricIndex
       })
     })()`
  )
  console.log(`state: ${state}`)

  // Open the now-playing overlay. The app exposes it via the title-bar button;
  // clicking it through the DOM is the closest thing to a user action.
  await evaluate(
    `(() => {
       const buttons = [...document.querySelectorAll('button')]
       const target = buttons.find(b => (b.getAttribute('title') || '') === '正在播放')
       if (target) { target.click(); return 'clicked' }
       return 'button not found'
     })()`
  )
  await sleep(2500)

  const overlayOpen = await evaluate(`!!document.querySelector('.np')`)
  console.log(`now-playing overlay open: ${overlayOpen}`)
} catch (error) {
  console.error(`FATAL: ${error.message}`)
} finally {
  // Capture while the app is still running.
  const capture = spawnSync(
    'powershell.exe',
    [
      '-NoProfile',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      join(repoRoot, 'tools', 'probe', 'capture-window.ps1'),
      '-ProcessName',
      'electron',
      '-OutFile',
      outFile
    ],
    { cwd: repoRoot, stdio: 'inherit' }
  )
  void capture
  child.kill()
  await sleep(600)
}
