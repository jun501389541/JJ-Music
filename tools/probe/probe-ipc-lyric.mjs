/**
 * Find which IPC call in the lyric path returns a non-cloneable payload.
 *
 * The renderer reported "An object could not be cloned" while loading lyrics
 * for a *local* track. The local path itself checks out as cloneable in
 * isolation, so this drives each IPC handler in turn through a real Electron
 * renderer and reports the first one that fails.
 *
 * Usage: node tools/probe/probe-ipc-lyric.mjs
 */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { createServer } from 'node:net'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
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
  await sleep(4000)

  const evaluate = async (expression) => {
    const result = await send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true
    })
    if (result.exceptionDetails) {
      return { error: result.exceptionDetails.exception?.description ?? 'threw' }
    }
    return { value: result.result.value }
  }

  console.log('='.repeat(72))
  console.log('probing each IPC call in the lyric path')
  console.log('='.repeat(72))

  // Get a local track to work with.
  const tracks = await evaluate('window.jj.library.tracks().then(t => t.length)')
  console.log(`\nlibrary tracks: ${tracks.value}`)

  const PROBES = [
    ['lyric.resolve (local)', `(async () => {
        const t = (await window.jj.library.tracks()).find(x => x.name && x.singer)
        if (!t) return 'no track'
        const r = await window.jj.lyric.resolve(t, true)
        return 'ok source=' + r.source + ' len=' + r.lyric.length
      })()`],
    ['lyric.searchOnline', `(async () => {
        const t = (await window.jj.library.tracks()).find(x => x.name && x.singer)
        if (!t) return 'no track'
        const r = await window.jj.lyric.searchOnline(t)
        return 'ok source=' + r.source + ' len=' + r.lyric.length
      })()`],
    ['music.lyric (online)', `(async () => {
        const r = await window.jj.music.search('tx', '晴天', 1)
        if (!r.list[0]) return 'no result'
        const l = await window.jj.music.lyric('tx', r.list[0])
        return 'ok len=' + (l.lyric ? l.lyric.length : 0)
      })()`],
    ['music.url (online)', `(async () => {
        const r = await window.jj.music.search('tx', '晴天', 1)
        if (!r.list[0]) return 'no result'
        try {
          const u = await window.jj.music.url('tx', r.list[0], '128k')
          return 'ok url=' + u.url.slice(0, 50)
        } catch (e) { return 'threw: ' + e.message }
      })()`],
    ['match.metadata', `(async () => {
        const t = (await window.jj.library.tracks()).find(x => x.name && x.singer)
        if (!t) return 'no track'
        const r = await window.jj.match.metadata(t, { limit: 3 })
        return 'ok count=' + r.length
      })()`],
    ['match.cover', `(async () => {
        const t = (await window.jj.library.tracks()).find(x => x.name && x.singer)
        const r = await window.jj.match.metadata(t, { limit: 1 })
        if (!r[0]) return 'no candidate'
        const c = await window.jj.match.cover(r[0].music)
        return c ? 'ok dataUrl len=' + c.dataUrl.length : 'null'
      })()`],
    ['match.apply (dryRun)', `(async () => {
        const t = (await window.jj.library.tracks()).find(x => x.path.endsWith('.flac'))
        if (!t) return 'no flac'
        const r = await window.jj.match.apply(t, { album: 'probe' }, { dryRun: true })
        return 'ok ' + r.note
      })()`],
    ['sources.available', `window.jj.sources.available().then(r => 'ok count=' + r.length)`],
    ['settings.get', `window.jj.settings.get().then(r => 'ok theme=' + r.theme)`]
  ]

  for (const [label, expression] of PROBES) {
    const result = await evaluate(expression)
    const text = result.error ? `ERROR: ${result.error}` : String(result.value)
    const bad = /could not be cloned|Error:|threw/i.test(text)
    console.log(`\n${bad ? '✗' : '✓'} ${label}`)
    console.log(`    ${text.slice(0, 220)}`)
  }

  // Finally: drive the real player store, which is what the e2e run does.
  console.log('\n--- driving the real player store ---')
  const play = await evaluate(
    `(async () => {
       const m = window.__jj_player
       if (!m) return 'no test hook'
       const track = (await window.jj.library.tracks())[0]
       await m.playTrack(track)
       return 'started ' + track.name
     })()`
  )
  console.log(`    ${play.error ?? play.value}`)
  await sleep(3000)
  const state = await evaluate(
    `(() => {
       const m = window.__jj_player
       return JSON.stringify({
         playing: m.playing,
         t: m.currentTime,
         lyricSource: m.lyricSource,
         lines: m.lyrics ? m.lyrics.lines.length : 0,
         lyricError: m.lyricError
       })
     })()`
  )
  console.log(`    state: ${state.error ?? state.value}`)
} catch (error) {
  console.error(`\nFATAL: ${error.message}`)
} finally {
  child.kill()
  await sleep(800)
}
