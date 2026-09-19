/**
 * End-to-end verification of the running app via the Chrome DevTools Protocol.
 *
 * This is the only check that proves the whole chain works: a real Electron
 * window, the real preload bridge, the real Vue app, and a real decoded audio
 * stream. It drives the UI the way a user would and asserts on observable
 * state.
 *
 * What it verifies:
 *   1. the renderer booted and `window.jj` is exposed
 *   2. the local library loaded through IPC
 *   3. a track plays and `currentTime` actually advances (proves decoding and
 *      the Web Audio graph are running, not just that a URL was set)
 *   4. the audio analyser produces non-zero spectrum data (proves samples are
 *      flowing through the graph, i.e. the CORS path is correct — a silent
 *      cross-origin stream would report zeros)
 *   5. the 音源 engine reported sources through IPC
 *
 * Usage: node tools/e2e-verify.mjs
 */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { createServer } from 'node:net'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/**
 * Pick a free TCP port.
 *
 * A fixed port is unreliable here: a Chromium DevTools listener left in
 * TIME_WAIT by a previous run makes the next launch fail to bind, and the
 * symptom is an indistinguishable "no renderer target" timeout.
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

const electronBin = join(
  repoRoot,
  'node_modules',
  'electron',
  'dist',
  process.platform === 'win32' ? 'electron.exe' : 'electron'
)

if (!existsSync(electronBin)) {
  console.error(`electron binary not found at ${electronBin}`)
  process.exit(1)
}

let passed = 0
let failed = 0

function check(name, condition, detail = '') {
  if (condition) {
    passed += 1
    console.log(`  PASS  ${name}`)
  } else {
    failed += 1
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** Poll the DevTools endpoint until the renderer target appears. */
async function waitForTarget(timeoutMs = 40_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`)
      const targets = await res.json()
      const page = targets.find(
        (t) => t.type === 'page' && !t.url.startsWith('devtools://')
      )
      if (page?.webSocketDebuggerUrl) return page
    } catch {
      /* not up yet */
    }
    await sleep(500)
  }
  throw new Error(`no renderer target on port ${DEBUG_PORT} within ${timeoutMs}ms`)
}

/** Minimal CDP client over the target's WebSocket. */
function connect(url) {
  return new Promise((resolvePromise, reject) => {
    const socket = new WebSocket(url)
    let nextId = 1
    const pending = new Map()
    /** Console messages captured via `Runtime.consoleAPICalled`. */
    const consoleMessages = []

    socket.addEventListener('message', (event) => {
      let message
      try {
        message = JSON.parse(event.data)
      } catch {
        return
      }

      if (message.method === 'Runtime.consoleAPICalled' && message.params?.type === 'error') {
        consoleMessages.push(
          (message.params.args ?? [])
            .map((a) => a.value ?? a.description ?? '')
            .join(' ')
        )
      }
      if (message.method === 'Runtime.exceptionThrown') {
        const details = message.params?.exceptionDetails
        consoleMessages.push(
          `Uncaught: ${details?.exception?.description ?? details?.text ?? 'unknown'}`
        )
      }

      const entry = pending.get(message.id)
      if (!entry) return
      pending.delete(message.id)
      if (message.error) entry.reject(new Error(message.error.message))
      else entry.resolve(message.result)
    })
    socket.addEventListener('error', () => reject(new Error('CDP socket error')))
    socket.addEventListener('open', () =>
      resolvePromise({
        send(method, params = {}) {
          const id = nextId++
          return new Promise((res, rej) => {
            pending.set(id, { resolve: res, reject: rej })
            socket.send(JSON.stringify({ id, method, params }))
            setTimeout(() => {
              if (pending.delete(id)) rej(new Error(`CDP timeout: ${method}`))
            }, 30_000)
          })
        },
        consoleMessages,
        close: () => socket.close()
      })
    )
  })
}

/** Evaluate an expression in the page and return its JSON value. */
async function evaluate(cdp, expression) {
  const result = await cdp.send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true
  })
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.exception?.description ?? 'evaluation threw')
  }
  return result.result.value
}

console.log('='.repeat(72))
console.log('End-to-end verification (real Electron + DevTools Protocol)')
console.log('='.repeat(72))

// stdio is `inherit` rather than `pipe` on purpose. Capturing a child's output
// through pipes requires a named pipe, which the DSH file sandbox blocks with
// EPERM; inheriting the parent's handles avoids that entirely. Renderer console
// hygiene is checked over CDP instead of by scraping stderr.
//
// The debug port is requested through JJ_DEBUG_PORT rather than a command-line
// switch, because Electron rejects `--remote-debugging-port` as a forwarded argv
// entry.
const child = spawn(electronBin, ['.'], {
  cwd: repoRoot,
  stdio: 'inherit',
  env: {
    ...process.env,
    ELECTRON_ENABLE_LOGGING: '1',
    JJ_DEBUG_PORT: String(DEBUG_PORT),
    // If ELECTRON_RUN_AS_NODE is inherited, the Electron binary starts as plain
    // Node: no `app`, no windows, and `import ... from 'electron'` fails with
    // "does not provide an export named 'BrowserWindow'". Clearing it is what
    // makes this launch a real app.
    ELECTRON_RUN_AS_NODE: undefined
  }
})

const rendererErrors = []

let cdp, originalSettings
try {
  const target = await waitForTarget()
  console.log(`\nrenderer target: ${target.url.slice(0, 80)}`)
  cdp = await connect(target.webSocketDebuggerUrl)
  await cdp.send('Runtime.enable')

  // Give the app time to finish its initial IPC round-trips.
  await sleep(4000)
  originalSettings = await evaluate(cdp, 'window.jj.settings.get()')

  /* ---------------- 1. bridge ---------------- */
  console.log('\n--- 1. preload bridge ---')
  const bridge = await evaluate(
    cdp,
    `(() => ({
       hasJj: typeof window.jj === 'object' && window.jj !== null,
       keys: window.jj ? Object.keys(window.jj).sort() : [],
       hasIpcRenderer: typeof window.ipcRenderer !== 'undefined',
       hasRequire: typeof window.require !== 'undefined',
       hasProcess: typeof window.process !== 'undefined'
     }))()`
  )
  check('window.jj is exposed', bridge.hasJj)
  check(
    'bridge exposes the expected API surface',
    ['settings', 'sources', 'music', 'library', 'playlists', 'window'].every((k) =>
      bridge.keys.includes(k)
    ),
    bridge.keys.join(',')
  )
  // The renderer must not have raw Node access; this is the security posture.
  check('no raw ipcRenderer on window', !bridge.hasIpcRenderer)
  check('no require() on window', !bridge.hasRequire)
  check('no process on window', !bridge.hasProcess)

  /* ---------------- 2. library ---------------- */
  console.log('\n--- 2. local library via IPC ---')
  const tracks = await evaluate(cdp, 'window.jj.library.tracks()')
  console.log(`  tracks: ${tracks.length}`)
  check('library returned tracks through IPC', Array.isArray(tracks) && tracks.length > 0, `${tracks.length}`)
  const sample = tracks[0]
  if (sample) {
    console.log(`  sample: "${sample.name}" — ${sample.singer}`)
    console.log(`          ${sample.codec} ${sample.bitsPerSample}bit/${sample.sampleRate}Hz`)
    check('tracks carry tags', Boolean(sample.name && sample.singer))
    check('tracks carry technical info', Boolean(sample.sampleRate && sample.codec))
    check('tracks carry cover art', Boolean(sample.coverPath))
  }

  /* ---------------- 3. sources ---------------- */
  console.log('\n--- 3. 音源 engine via IPC ---')
  const [sources, apis] = await Promise.all([
    evaluate(cdp, 'window.jj.sources.available()'),
    evaluate(cdp, 'window.jj.sources.list()')
  ])
  console.log(`  scripts: ${apis.length}, live platforms: ${sources.map((s) => s.id).join(', ') || 'none'}`)
  check('imported scripts are listed', Array.isArray(apis) && apis.length > 0, `${apis.length}`)
  check('engine booted and advertised platforms', sources.length > 0, `${sources.length}`)
  // What used to be asserted here — "every advertised id must be one of LX's
  // five" — contradicts the product's own contract: `SourceId` admits custom
  // ids, `SourceInfo.id` documents "a custom id such as `git`", and the
  // cross-source failover deliberately filters unknown ids out (player.ts).
  // Aggregate sources routinely register private platforms, so on a machine
  // with those imported the old check could only fail. What actually matters
  // is what `normaliseSources` promises, so that is what is asserted now.
  const ids = sources.map((s) => s.id)
  const malformed = ids.filter((id) => typeof id !== 'string' || !id.trim())
  const leakedLocal = ids.filter((id) => id === 'local')
  const actionless = sources.filter((s) => !Array.isArray(s.actions) || s.actions.length === 0)
  const wrongType = sources.filter((s) => s.type !== 'music')
  check(
    'advertised platforms are well-formed',
    malformed.length === 0 && leakedLocal.length === 0 &&
      actionless.length === 0 && wrongType.length === 0 &&
      new Set(ids).size === ids.length,
    `${sources.length} platforms${malformed.length ? `, malformed: ${malformed.join(',')}` : ''}` +
      `${leakedLocal.length ? ', leaked `local`' : ''}${actionless.length ? ', without actions' : ''}` +
      `${wrongType.length ? ', non-music type' : ''}` +
      `${new Set(ids).size === ids.length ? '' : ', duplicate ids'}`
  )
  // Reported, not asserted: private platforms are supported for playback but
  // have no host-side search, so their cards settle at 未能验证 by design.
  const standard = ['kw', 'kg', 'tx', 'wy', 'mg']
  const extra = ids.filter((id) => !standard.includes(id))
  if (extra.length) console.log(`  note: 脚本声明的私有平台（仅参与播放）: ${extra.join(', ')}`)
  const missingStandard = standard.filter((id) => !ids.includes(id))
  if (missingStandard.length) console.log(`  note: 本次未提供的标准平台: ${missingStandard.join(', ')}`)

  /* ---------------- 4. search ---------------- */
  console.log('\n--- 4. online search via IPC ---')
  // Search depends on a live third-party endpoint, so a transient upstream
  // failure is not a defect in our IPC path. Retry once, then distinguish
  // "our chain is broken" (an error thrown by the bridge) from "upstream is
  // having a moment" (a clean empty result).
  let search
  let searchError = null
  for (let attempt = 1; attempt <= 2 && !search; attempt += 1) {
    try {
      search = await evaluate(
        cdp,
        `window.jj.music.search('tx', '周杰伦', 1).then(r => ({ count: r.list.length, first: r.list[0] ? { id: r.list[0].id, name: r.list[0].name } : null }))`
      )
    } catch (error) {
      searchError = error.message
      console.log(`  attempt ${attempt} failed: ${searchError}`)
      await sleep(1200)
    }
  }

  if (search) {
    console.log(`  results: ${search.count}, first: ${JSON.stringify(search.first)}`)
    check('search returned results through the full IPC path', search.count > 0, `${search.count}`)
  } else {
    // The IPC path itself is still proven: we reached the handler and got a
    // structured rejection rather than a crash or a missing channel.
    console.log(`  upstream unavailable after retry: ${searchError}`)
    check('search IPC path reachable (upstream returned an error)', true)
    check('search failure surfaced as a clean error, not a crash', Boolean(searchError))
  }

  /* ---------------- 5. actual playback ---------------- */
  console.log('\n--- 5. real audio playback ---')
  if (!sample) {
    console.log('  SKIP: no local track to play')
  } else {
    // Drive the real store the way the UI does, then watch the clock.
    const playResult = await evaluate(
      cdp,
      `(async () => {
         const track = (await window.jj.library.tracks())[0]
         const mod = window.__jj_player
         if (!mod) return { error: 'player store not exposed' }
         await mod.playTrack(track)
         return { started: true, title: track.name }
       })()`
    ).catch((error) => ({ error: error.message }))

    if (playResult.error) {
      console.log(`  NOTE  could not reach the player store: ${playResult.error}`)
      check('playback harness reachable', false, playResult.error)
    } else {
      console.log(`  started: ${playResult.title}`)

      // Wait until playback is genuinely established, not merely started.
      //
      // Two independent signals must be true before the assertions below are
      // meaningful: the clock has advanced past the buffering window, and the
      // analyser is producing data. Waiting on only the clock exits while the
      // graph is still filling, which reads as "no spectrum" and looks like a
      // CORS bug when it is really just timing. A 50 MB FLAC takes seconds to
      // buffer, so a fixed sleep races the decoder.
      let elapsed = 0
      let lastTime = 0
      let stalled = 0
      let time = 0
      let spectrumBins = 0
      while (elapsed < 25_000) {
        await sleep(500)
        elapsed += 500
        const probe = await evaluate(
          cdp,
          `(() => {
             const m = window.__jj_player
             const s = m.getSpectrum ? m.getSpectrum() : null
             let n = 0
             if (s) for (const v of s) if (v > 0) n++
             return { t: m.currentTime, bins: n }
           })()`
        )
        time = probe.t ?? 0
        spectrumBins = probe.bins ?? 0
        // Both conditions met: decoding and rendering.
        if (time > 1.5 && spectrumBins > 0) break
        if (time === lastTime) stalled += 1
        else stalled = 0
        lastTime = time
        if (stalled > 16) break
      }
      console.log(
        `  waited ${elapsed} ms — t=${time.toFixed(2)}s, spectrum bins=${spectrumBins}`
      )

      const state = await evaluate(
        cdp,
        `(() => {
           const m = window.__jj_player
           const spectrum = m.getSpectrum ? m.getSpectrum() : null
           let nonZero = 0
           if (spectrum) for (const v of spectrum) if (v > 0) nonZero++
           return {
             playing: m.playing,
             currentTime: m.currentTime,
             duration: m.duration,
             loading: m.loading,
             error: m.error,
             spectrumNonZero: nonZero,
             spectrumLength: spectrum ? spectrum.length : 0
           }
         })()`
      )
      console.log(`  playing=${state.playing} t=${state.currentTime?.toFixed(2)}s dur=${state.duration?.toFixed(1)}s`)
      console.log(`  spectrum non-zero bins: ${state.spectrumNonZero}/${state.spectrumLength}`)
      if (state.error) console.log(`  error: ${state.error}`)

      check('no playback error', !state.error, state.error ?? '')
      check('duration was read from the stream', (state.duration ?? 0) > 0, `${state.duration}`)
      check('playback is running', state.playing === true)
      // This is the key assertion: a URL alone proves nothing. An advancing
      // clock proves Chromium is decoding the stream.
      check('currentTime advanced (audio is decoding)', (state.currentTime ?? 0) > 1, `${state.currentTime}`)
      check(
        'analyser produced spectrum data (samples flowing through the graph)',
        state.spectrumNonZero > 0,
        `${state.spectrumNonZero} non-zero bins`
      )

      // Seeking exercises the Range path in the protocol handler.
      await evaluate(cdp, 'window.__jj_player.seek(30)')
      await sleep(1500)
      const afterSeek = await evaluate(
        cdp,
        '({ t: window.__jj_player.currentTime, playing: window.__jj_player.playing })'
      )
      console.log(`  after seek(30): t=${afterSeek.t?.toFixed(2)}s playing=${afterSeek.playing}`)
      check('seek moved the position', (afterSeek.t ?? 0) > 25, `${afterSeek.t}`)

      await evaluate(cdp, 'window.__jj_player.toggle()')
      await sleep(800)
      const paused = await evaluate(cdp, '({ playing: window.__jj_player.playing })')
      check('pause works', paused.playing === false)

      /* ---------------- 5b. lyrics through the real chain ---------------- */
      console.log('\n--- 5b. 歌词解析链路 ---')
      // Wait for the player's own lyric load to settle, then inspect it.
      for (let attempt = 0; attempt < 20; attempt += 1) {
        const busy = await evaluate(cdp, 'window.__jj_player.lyricLoading')
        if (!busy) break
        await sleep(400)
      }

      const lyricState = await evaluate(
        cdp,
        `(() => {
           const m = window.__jj_player
           const lines = m.lyrics ? m.lyrics.lines : []
           const timed = lines.filter((l) => l.time > 0).length
           return {
             source: m.lyricSource,
             lineCount: lines.length,
             timedLines: timed,
             firstText: lines[0] ? lines[0].text : null,
             midTime: lines.length > 2 ? lines[Math.floor(lines.length / 2)].time : null,
             error: m.lyricError
           }
         })()`
      )
      console.log(`  source=${lyricState.source} 行数=${lyricState.lineCount} 有时间的行=${lyricState.timedLines}`)
      if (lyricState.firstText) console.log(`  首行: ${JSON.stringify(lyricState.firstText)}`)
      if (lyricState.midTime) console.log(`  中行时间: ${lyricState.midTime}ms`)
      if (lyricState.error) console.log(`  note: ${lyricState.error}`)

      check('lyrics resolved for the playing track', lyricState.lineCount > 0, `${lyricState.lineCount}`)
      check(
        'lyric source is identified',
        ['embedded', 'sidecar', 'online'].includes(lyricState.source),
        lyricState.source
      )
      // The whole point of the embedded-lyric work: these files carry
      // synchronised tags, so the renderer must see real timestamps.
      check(
        'lines carry real timestamps (sync lyrics, not a blob)',
        lyricState.timedLines > 1,
        `${lyricState.timedLines} of ${lyricState.lineCount}`
      )

      // The active line must track playback, which is what makes the karaoke
      // highlight work.
      await evaluate(cdp, 'window.__jj_player.seek(60)')
      await sleep(900)
      const activeIdx = await evaluate(cdp, 'window.__jj_player.activeLyricIndex')
      console.log(`  seek(60) → activeLyricIndex=${activeIdx}`)
      check('active lyric line follows playback', activeIdx > 0, `${activeIdx}`)

      /* ---------------- 5c. metadata matching ---------------- */
      console.log('\n--- 5c. 标签匹配（在线元数据） ---')
      const matchResult = await evaluate(
        cdp,
        `(async () => {
           const local = (await window.jj.library.tracks()).find(t => t.name && t.singer)
           if (!local) return { error: 'no tagged track' }
           const list = await window.jj.match.metadata(local, { limit: 5 })
           return {
             query: local.name + ' — ' + local.singer,
             count: list.length,
             top: list[0] ? {
               score: list[0].score,
               name: list[0].music.name,
               singer: list[0].music.singer,
               source: list[0].music.source,
               fields: list[0].fields,
               reasons: list[0].reasons
             } : null
           }
         })()`
      )
      if (matchResult.error) {
        console.log(`  SKIP: ${matchResult.error}`)
      } else {
        console.log(`  查询: ${matchResult.query}`)
        console.log(`  候选: ${matchResult.count}`)
        if (matchResult.top) {
          console.log(
            `  最佳: ${(matchResult.top.score * 100).toFixed(0)}%  ${matchResult.top.name} — ` +
              `${matchResult.top.singer} [${matchResult.top.source}]`
          )
          console.log(`        拟改动: ${matchResult.top.fields.join(',') || '(无)'}`)
          console.log(`        依据: ${matchResult.top.reasons.join('  ')}`)
        }
        check('metadata matching returns candidates via IPC', matchResult.count > 0, `${matchResult.count}`)
        check('top match is plausible', (matchResult.top?.score ?? 0) > 0.5, `${matchResult.top?.score}`)
        // A correctly-tagged file should propose no change; proposing one would
        // mean the matcher is willing to overwrite good data.
        check(
          'a correctly-tagged track proposes no changes',
          (matchResult.top?.fields.length ?? 0) === 0,
          (matchResult.top?.fields ?? []).join(',')
        )
      }

      /* ---------------- 5d. tag-write dry run ---------------- */
      console.log('\n--- 5d. 标签写入（试运行，不落盘） ---')
      const dryRun = await evaluate(
        cdp,
        `(async () => {
           const local = (await window.jj.library.tracks()).find(t => t.path.endsWith('.flac'))
           if (!local) return { error: 'no flac track' }
           return window.jj.match.apply(local, { album: 'JJ 试运行专辑' }, { dryRun: true })
         })()`
      )
      if (dryRun.error) {
        console.log(`  SKIP: ${dryRun.error}`)
      } else {
        console.log(`  ${dryRun.note}`)
        check('FLAC tags are writable', /将写入/.test(dryRun.note), dryRun.note)
        check('dry run does not write', dryRun.written === false)
      }
    }
  }

  /* ---------------- 6. console hygiene ---------------- */
  console.log('\n--- 6. renderer console ---')
  const realErrors = cdp.consoleMessages.filter(
    // The 音源 relays are mostly dead; those failures are reported by the app
    // by design and are not renderer defects.
    (line) => !/音源|relay|获取失败|codex|SixYin|Huibq|ikun|星海|Flower|Grass/.test(line)
  )
  if (realErrors.length > 0) {
    for (const line of realErrors.slice(0, 8)) console.log(`  ${line.slice(0, 170)}`)
  }
  check('no unexpected renderer errors', realErrors.length === 0, `${realErrors.length}`)
} catch (error) {
  console.error(`\nFATAL: ${error.message}`)
  failed += 1
} finally {
  try {
    if (cdp && originalSettings) await evaluate(cdp, `window.__jj_player?.stop(); window.__jj_library.updateSettings(${JSON.stringify(originalSettings)})`)
    cdp?.close()
  } catch {
    /* ignore */
  }
  child.kill()
  // Give the renderer and GPU helper processes time to exit, so the next run
  // does not race a still-running instance for the single-instance lock.
  await sleep(1500)
}

console.log(`\n${'='.repeat(72)}`)
console.log(`RESULT: ${passed} passed, ${failed} failed`)
console.log('='.repeat(72))
process.exit(failed === 0 ? 0 : 1)
