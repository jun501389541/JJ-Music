/** Main-process half of crossfade-lifecycle.mjs. All media is generated locally. */
const { app, BrowserWindow, session } = require('electron')
const assert = require('node:assert/strict')
const http = require('node:http')
const { join } = require('node:path')
const { readFileSync, writeFileSync } = require('node:fs')

if (!process.env.JJ_CROSSFADE_PROFILE || !process.env.JJ_CROSSFADE_OUTPUT) {
  throw new Error('Use tools/probe/crossfade-lifecycle.mjs to create an isolated profile')
}

app.setPath('userData', process.env.JJ_CROSSFADE_PROFILE)
app.commandLine.appendSwitch('disable-background-networking')
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required')

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
async function wait(predicate, label, timeoutMs = 12_000) {
  const deadline = Date.now() + timeoutMs
  let value
  while (Date.now() < deadline) {
    value = await predicate()
    if (value) return value
    await sleep(50)
  }
  throw new Error(`Timed out: ${label}`)
}

function wavTone(frequency, seconds = 12) {
  const sampleRate = 48_000
  const frames = sampleRate * seconds
  const data = Buffer.alloc(frames * 2)
  for (let frame = 0; frame < frames; frame += 1) {
    const sample = Math.round(Math.sin(2 * Math.PI * frequency * frame / sampleRate) * 7_000)
    data.writeInt16LE(sample, frame * 2)
  }
  const header = Buffer.alloc(44)
  header.write('RIFF', 0)
  header.writeUInt32LE(36 + data.length, 4)
  header.write('WAVE', 8)
  header.write('fmt ', 12)
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(1, 20)
  header.writeUInt16LE(1, 22)
  header.writeUInt32LE(sampleRate, 24)
  header.writeUInt32LE(sampleRate * 2, 28)
  header.writeUInt16LE(2, 32)
  header.writeUInt16LE(16, 34)
  header.write('data', 36)
  header.writeUInt32LE(data.length, 40)
  return Buffer.concat([header, data])
}

const media = new Map([
  ['a', wavTone(440)], ['b', wavTone(880)], ['short', wavTone(660, 0.5)],
  ['rate-a', wavTone(440)], ['rate-b', wavTone(880)],
  ['off-a', wavTone(330)], ['off-b', wavTone(660)],
  ['fail-a', wavTone(392)], ['fail-b', wavTone(784)],
  ['bad-a', wavTone(349)],
  ['skip-a', wavTone(294)], ['skip-b', wavTone(587)], ['skip-c', wavTone(1_174)],
  ['seek-a', wavTone(262)], ['seek-b', wavTone(523)],
  ['stream', wavTone(220)], ['unused', wavTone(1_320)]
])
const invalidWav = Buffer.from('not an audio stream')
const activeMedia = new Set()
const mediaRequestStarts = []
const reports = []
let blockedExternalRequests = 0
let browserWindow
let server
let serverPort

const outputPath = process.env.JJ_CROSSFADE_OUTPUT
const runId = process.env.JJ_CROSSFADE_RUN_ID
function report(status, error) {
  writeFileSync(outputPath, JSON.stringify({
    runId,
    status,
    electron: process.versions.electron,
    blockedExternalRequests,
    activeMediaRequests: activeMedia.size,
    reports,
    ...(error ? { error } : {})
  }, null, 2) + '\n')
}

function setupProbe() {
  const state = { audio: [], contexts: [], analyser: null, player: null, audioOffset: 0, curves: [], curveOffset: 0 }
  const NativeAudio = window.Audio
  window.Audio = new Proxy(NativeAudio, {
    construct(target, args, newTarget) {
      const element = Reflect.construct(target, args, newTarget)
      state.audio.push(element)
      return element
    }
  })
  const NativeAudioContext = window.AudioContext
  window.AudioContext = new Proxy(NativeAudioContext, {
    construct(target, args, newTarget) {
      const context = Reflect.construct(target, args, newTarget)
      state.contexts.push(context)
      const createGain = context.createGain.bind(context)
      context.createGain = (...values) => {
        const node = createGain(...values)
        const parameter = node.gain
        const setValueCurve = parameter.setValueCurveAtTime.bind(parameter)
        parameter.setValueCurveAtTime = (levels, startTime, duration) => {
          state.curves.push({ startTime, duration, initial: levels[0], final: levels[levels.length - 1] })
          return setValueCurve(levels, startTime, duration)
        }
        return node
      }
      const createAnalyser = context.createAnalyser.bind(context)
      context.createAnalyser = (...values) => {
        const analyser = createAnalyser(...values)
        state.analyser = analyser
        return analyser
      }
      return context
    }
  })
  window.jj = {
    sources: {
      onChanged: () => () => undefined,
      available: async () => [],
      list: async () => []
    },
    music: {
      url: async (source, track, quality) => ({
        url: `${location.origin}/media/${encodeURIComponent(track.id)}.wav`,
        quality,
        source,
        resolvedAt: Date.now(),
        expiresAt: Date.now() + 300_000
      }),
      enrich: async () => ({ lyric: '' }),
      cancel: () => undefined
    },
    lyric: { resolve: async () => ({ lyric: '' }) },
    playlists: {
      addTracks: async (_id, items) => items.length,
      list: async () => [],
      items: async () => []
    },
    settings: { update: async () => undefined }
  }
  function makeTrack(id) {
    return { id, name: `Synthetic ${id}`, singer: 'Probe', source: 'wy' }
  }
  function energyAt(frequency) {
    const analyser = state.analyser
    if (!analyser) return 0
    const values = new Uint8Array(analyser.frequencyBinCount)
    analyser.getByteFrequencyData(values)
    const bin = Math.round(frequency * analyser.fftSize / state.contexts[state.contexts.length - 1].sampleRate)
    return Math.max(...values.slice(Math.max(0, bin - 2), Math.min(values.length, bin + 3)))
  }
  function snapshot() {
    const samples=new Float32Array(state.analyser?.fftSize??32)
    state.analyser?.getFloatTimeDomainData(samples)
    const outputRms=Math.sqrt(samples.reduce((sum,v)=>sum+v*v,0)/samples.length)
    return {
      outputRms,
      volume:state.player?.volume??null,
      sleepFading:state.player?.sleepFading??false,
      contextStates:state.contexts.map(context=>context.state),
      currentIndex: state.player?.currentIndex ?? -1,
      currentId: state.player?.currentTrack?.id ?? null,
      playing: state.player?.playing ?? false,
      waiting: state.player?.waiting ?? false,
      currentTime: state.player?.currentTime ?? 0,
      duration: state.player?.duration ?? 0,
      error: state.player?.error ?? null,
      queueIds: state.player?.queue.map(track => track.id) ?? [],
      historyIds: state.player?.queueHistory.map(entry => entry.queue.map(track => track.id)) ?? [],
      sleepWaiting: state.player?.sleepWaiting ?? false,
      sleepAt:state.player?.sleepAt??null,
      loop: state.player?.abLoop ?? null,
      pendingId: state.player?.manualSwitchTarget?.id ?? null,
      curveSchedules: state.curves.slice(state.curveOffset),
      audio: state.audio.slice(state.audioOffset).map(element => ({
        src: element.getAttribute('src') ?? '',
        currentSrc: element.currentSrc,
        paused: element.paused,
        currentTime: element.currentTime,
        duration: element.duration,
        readyState: element.readyState,
        errorCode: element.error?.code ?? null
      })),
      energy440: energyAt(440),
      energy880: energyAt(880)
    }
  }
  window.__crossfadeProbe = {
    async begin(ids, durationMs) {
      if (state.player) {
        state.player.stop()
        state.player.$dispose()
      }
      state.player = window.JJCrossfadeLifecycle.createPlayer()
      state.player.setTransitionsEnabled(false)
      state.player.setCrossfadeDuration(durationMs)
      state.audioOffset = state.audio.length
      state.curveOffset = state.curves.length
      await state.player.playQueue(ids.map(makeTrack), 0, 'Synthetic crossfade probe')
      return snapshot()
    },
    async stageQueue(ids, durationMs = 2000) {
      state.player.setManualCrossfadeDuration(durationMs)
      await state.player.playUserQueue(ids.map(makeTrack), 0, 'New synthetic queue')
      return snapshot()
    },
    holdResolution(id) {
      const original = window.jj.music.url
      window.jj.music.url = (...args) => args[1].id === id ? new Promise(resolve => {
        window.__releaseResolution = () => { window.jj.music.url = original; original(...args).then(resolve) }
      }) : original(...args)
    },
    player: () => state.player,
    snapshot,
    injectDecodeError(id) {
      const element = state.audio.slice(state.audioOffset).find(item => item.currentSrc.includes(`/media/${id}.wav`))
      if (!element) throw new Error(`No active element for ${id}`)
      state.injectedErrorElement = element
      Object.defineProperty(element, 'error', { configurable: true, get: () => ({ code: 3, message: 'synthetic decoder failure' }) })
      element.dispatchEvent(new Event('error'))
      return element.currentTime
    },
    clearDecodeError() {
      if (state.injectedErrorElement) delete state.injectedErrorElement.error
      state.injectedErrorElement = null
    },
    stop() {
      state.player?.stop()
      return snapshot()
    },
    dispose() {
      state.player?.$dispose()
      state.player = null
    }
  }
}

const watchdog = setTimeout(() => {
  report('failed', 'Native crossfade watchdog exceeded 75 seconds')
  app.exit(2)
}, 75_000)
report('running')

app.whenReady().then(async () => {
  server = http.createServer((request, response) => {
    const requestUrl = new URL(request.url, `http://127.0.0.1:${serverPort}`)
    response.setHeader('Access-Control-Allow-Origin', '*')
    response.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS')
    response.setHeader('Accept-Ranges', 'bytes')
    if (request.method === 'OPTIONS') {
      response.writeHead(204)
      response.end()
      return
    }
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      response.writeHead(405)
      response.end()
      return
    }
    if (requestUrl.pathname === '/') {
      const html = '<!doctype html><meta charset="utf-8"><title>Crossfade lifecycle probe</title><script src="/crossfade-lifecycle.js"></script>'
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': Buffer.byteLength(html) })
      response.end(request.method === 'HEAD' ? undefined : html)
      return
    }
    if (requestUrl.pathname === '/crossfade-lifecycle.js') {
      const bytes = readFileSync(join(process.cwd(), 'out', 'test', 'crossfade-lifecycle.js'))
      response.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8', 'Content-Length': bytes.length })
      response.end(request.method === 'HEAD' ? undefined : bytes)
      return
    }
    const match = requestUrl.pathname.match(/^\/media\/([a-z0-9-]+)\.wav$/i)
    if (!match) {
      response.writeHead(404)
      response.end()
      return
    }
    const id = match[1]
    const body = id === 'corrupt' ? invalidWav : media.get(id)
    if (!body) {
      response.writeHead(404)
      response.end()
      return
    }
    const range = request.headers.range?.match(/^bytes=(\d+)-(\d*)$/)
    const start = range ? Number(range[1]) : 0
    const end = range && range[2] ? Math.min(Number(range[2]), body.length - 1) : body.length - 1
    const selected = body.subarray(start, end + 1)
    const requestId = `${id}:${Date.now()}:${Math.random()}`
    activeMedia.add(requestId)
    mediaRequestStarts.push(id)
    const close = () => activeMedia.delete(requestId)
    response.once('close', close)
    response.setHeader('Content-Type', 'audio/wav')
    response.setHeader('Content-Length', selected.length)
    if (range) response.setHeader('Content-Range', `bytes ${start}-${end}/${body.length}`)
    response.writeHead(range ? 206 : 200)
    if (request.method === 'HEAD') {
      response.end()
      return
    }
    if (id !== 'stream') {
      response.end(selected)
      return
    }
    // Deliberately keep one synthetic media request live until stop() cancels it.
    let offset = 0
    const chunkSize = 64 * 1024
    const sendChunk = () => {
      if (response.destroyed) return
      const next = selected.subarray(offset, Math.min(selected.length, offset + chunkSize))
      offset += next.length
      response.write(next)
      if (offset >= selected.length) {
        clearInterval(timer)
        response.end()
      }
    }
    const timer = setInterval(sendChunk, 250)
    sendChunk()
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  serverPort = server.address().port
  session.defaultSession.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (details, callback) => {
    const url = new URL(details.url)
    if (url.hostname === '127.0.0.1' && url.port === String(serverPort)) callback({})
    else {
      blockedExternalRequests += 1
      callback({ cancel: true })
    }
  })
  browserWindow = new BrowserWindow({
    show: false,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false }
  })
  browserWindow.webContents.setAudioMuted(true)
  await browserWindow.loadURL(`http://127.0.0.1:${serverPort}/`)
  browserWindow.webContents.on('console-message', details => { if (details.level === 'error') console.error('renderer:', details.message) })
  const js = async source => {
    try { return await browserWindow.webContents.executeJavaScript(source) }
    catch (error) { throw new Error(`Renderer script ${source.slice(0, 180)}: ${error?.message ?? JSON.stringify(error)}`) }
  }
  await js(`(${setupProbe.toString()})()`)

  async function begin(ids, durationMs) {
    await js(`window.__crossfadeProbe.begin(${JSON.stringify(ids)},${durationMs})`)
    await wait(async () => {
      const state = await js('window.__crossfadeProbe.snapshot()')
      return state.playing && state.audio.some(item => item.currentSrc.includes(`/media/${ids[0]}.wav`) && item.duration > 0) ? state : null
    }, `active synthetic track ${ids[0]}`)
  }
  async function snapshot() { return js('window.__crossfadeProbe.snapshot()') }
  async function waitForIndex(index, label) {
    return wait(async () => {
      const state = await snapshot()
      return state.currentIndex === index ? state : null
    }, label)
  }
  async function finishCase(name, details) {
    reports.push({ case: name, ...details })
    report('running')
  }
  async function reset() {
    await js('window.__crossfadeProbe.stop();window.__crossfadeProbe.dispose();void 0')
    await wait(() => activeMedia.size === 0, 'player stop released previous media requests')
  }

  // 1. The production player crosses two actual loopback WAV tones, then releases its outgoing deck.
  await begin(['a', 'b'], 3_000)
  await js('window.__crossfadeProbe.player().seek(9)')
  await waitForIndex(1, 'audible handoff to second tone')
  await sleep(350)
  const overlapBefore = await snapshot()
  await sleep(300)
  const overlapAfter = await snapshot()
  const outgoing = overlapAfter.audio.find(item => item.currentSrc.includes('/media/a.wav'))
  const incoming = overlapAfter.audio.find(item => item.currentSrc.includes('/media/b.wav'))
  assert.ok(outgoing && incoming, 'both actual media elements must have their track loaded during overlap')
  assert.equal(outgoing.paused, false)
  assert.equal(incoming.paused, false)
  const outgoingBefore = overlapBefore.audio.find(item => item.currentSrc.includes('/media/a.wav'))
  const incomingBefore = overlapBefore.audio.find(item => item.currentSrc.includes('/media/b.wav'))
  assert.ok(outgoing.currentTime > outgoingBefore.currentTime + 0.1, 'outgoing media clock must advance')
  assert.ok(incoming.currentTime > incomingBefore.currentTime + 0.1, 'incoming media clock must advance')
  assert.ok(overlapAfter.energy440 > 0 && overlapAfter.energy880 > 0, 'shared Web Audio analyser must contain both generated tones')
  const outgoingDeckIndex = overlapAfter.audio.findIndex(item => item.currentSrc.includes('/media/a.wav'))
  assert.ok(outgoingDeckIndex >= 0)
  await wait(async () => {
    const state = await snapshot()
    const released = state.audio[outgoingDeckIndex]
    return released?.paused && !released.src
  }, 'outgoing deck release')
  await finishCase('overlap-start-completion', {
    simultaneousDeckPlayback: true,
    outgoingClockAdvanced: true,
    incomingClockAdvanced: true,
    analyserEnergy: { hz440: overlapAfter.energy440, hz880: overlapAfter.energy880 },
    outgoingReleased: true
  })
  await reset()

  // 2. A zero setting is exercised through Player Store; no standby media request is prepared.
  await begin(['off-a', 'off-b'], 0)
  await js('window.__crossfadeProbe.player().seek(9)')
  await sleep(700)
  const disabled = await snapshot()
  assert.equal(disabled.currentIndex, 0)
  assert.equal(disabled.audio.filter(item => item.src).length, 1)
  assert.ok(disabled.audio.some(item => item.currentSrc.includes('/media/off-a.wav')))
  assert.ok(!disabled.audio.some(item => item.src.includes('/media/off-b.wav')))
  await finishCase('disabled-setting', { currentIndex: disabled.currentIndex, loadedDecks: disabled.audio.filter(item => item.src).length, noStandbyPrepared: true })
  await reset()

  // 3. A malformed incoming file must fail preparation without disturbing the outgoing deck.
  await begin(['bad-a', 'corrupt'], 3_000)
  await js('window.__crossfadeProbe.player().seek(9)')
  await wait(() => mediaRequestStarts.includes('corrupt') && ![...activeMedia].some(id => id.startsWith('corrupt:')), 'malformed standby decode request settled')
  await sleep(250)
  const preparationFailure = await snapshot()
  assert.equal(preparationFailure.currentIndex, 0)
  assert.equal(preparationFailure.playing, true)
  assert.ok(preparationFailure.audio.some(item => item.currentSrc.includes('/media/bad-a.wav') && !item.paused))
  assert.ok(!preparationFailure.audio.some(item => item.src.includes('/media/corrupt.wav')))
  await finishCase('malformed-next-deck-preserves-outgoing', { currentIndex: 0, outgoingStillPlaying: true, malformedDeckReleased: true })
  await reset()

  // 4. During overlap, inject Chromium's decode error on the real incoming element and verify rollback.
  await begin(['fail-a', 'fail-b'], 3_000)
  await js('window.__crossfadeProbe.player().seek(9)')
  await waitForIndex(1, 'handoff before injected decode error')
  await sleep(350)
  const outgoingBeforeFailure = (await snapshot()).audio.find(item => item.currentSrc.includes('/media/fail-a.wav'))?.currentTime ?? 0
  await js("window.__crossfadeProbe.injectDecodeError('fail-b')")
  await wait(() => snapshot().then(state => {
    const outgoing = state.audio.find(item => item.currentSrc.includes('/media/fail-a.wav'))
    return state.currentIndex === 0 && state.playing && outgoing && outgoing.currentTime > outgoingBeforeFailure ? state : null
  }), 'restore outgoing playback and advance after incoming decode error')
  const restored = await snapshot()
  const restoredOutgoing = restored.audio.find(item => item.currentSrc.includes('/media/fail-a.wav'))
  assert.ok(restoredOutgoing && !restoredOutgoing.paused)
  assert.ok(restoredOutgoing.currentTime > outgoingBeforeFailure, 'outgoing playback position must continue live')
  assert.ok(!restored.audio.some(item => item.src.includes('/media/fail-b.wav')))
  await finishCase('injected-decode-failure-rolls-back', {
    injectedMediaErrorCode: 3,
    restoredCurrentIndex: restored.currentIndex,
    outgoingContinued: true,
    incomingReleased: true
  })
  await reset()

  // 5. A manual 下一首 during overlap takes the next queue identity immediately.
  await begin(['skip-a', 'skip-b', 'skip-c'], 3_000)
  await js('window.__crossfadeProbe.player().seek(9)')
  await waitForIndex(1, 'manual skip overlap handoff')
  await js('window.__crossfadeProbe.player().next()')
  const skipped = await wait(() => snapshot().then(state => state.currentIndex === 2 && state.currentId === 'skip-c' ? state : null), 'manual skip to third queue row')
  assert.ok(skipped.audio.some(item => item.currentSrc.includes('/media/skip-c.wav') && !item.paused))
  assert.ok(!skipped.audio.some(item => item.src.includes('/media/skip-a.wav') || item.src.includes('/media/skip-b.wav')))
  await finishCase('manual-skip-during-overlap', { currentIndex: skipped.currentIndex, currentId: skipped.currentId, staleDecksReleased: true })
  await reset()

  // 6. A seek after handoff commits to the incoming track and releases the outgoing deck.
  await begin(['seek-a', 'seek-b'], 3_000)
  await js('window.__crossfadeProbe.player().seek(9)')
  await waitForIndex(1, 'seek-after-handoff setup')
  await js('window.__crossfadeProbe.player().seek(4)')
  const seek = await snapshot()
  assert.equal(seek.currentIndex, 1)
  assert.equal(seek.currentId, 'seek-b')
  assert.ok(Math.abs(seek.currentTime - 4) < 0.2, `incoming seek position was ${seek.currentTime}`)
  assert.ok(!seek.audio.some(item => item.src.includes('/media/seek-a.wav')))
  await finishCase('seek-after-handoff', { currentIndex: seek.currentIndex, currentId: seek.currentId, position: seek.currentTime, outgoingReleased: true })
  await reset()

  // 7. The duration remains wall-clock based at 2x and a mid-fade rate increase cannot outlive either media deck.
  await begin(['rate-a', 'rate-b'], 3_000)
  await js('window.__crossfadeProbe.player().setRate(2);window.__crossfadeProbe.player().seek(6)')
  await waitForIndex(1, '2x playback rate handoff')
  await sleep(350)
  const beforeRateChange = await snapshot()
  const initialFadeDurations = beforeRateChange.curveSchedules.slice(-2).map(item => item.duration)
  assert.equal(initialFadeDurations.length, 2)
  assert.ok(initialFadeDurations.every(value => value > 2.5 && value <= 3), `2x wall-clock fade durations: ${initialFadeDurations}`)
  await js('window.__crossfadeProbe.player().setRate(4)')
  const afterRateChange = await snapshot()
  const retimedDurations = afterRateChange.curveSchedules.slice(-2).map(item => item.duration)
  assert.equal(retimedDurations.length, 2)
  assert.ok(retimedDurations.every(value => value > 0 && value < 1.5), `4x remaining fade durations: ${retimedDurations}`)
  await wait(async () => !(await snapshot()).audio.some(item => item.src.includes('/media/rate-a.wav')), 'retimed outgoing deck release')
  const rateResult = await snapshot()
  assert.ok(rateResult.audio.some(item => item.src.includes('/media/rate-b.wav') && !item.paused))
  await finishCase('playback-rate-wall-time-and-retiming', {
    startRate: 2,
    changedRate: 4,
    initialFadeSeconds: initialFadeDurations[0],
    retimedRemainingSeconds: retimedDurations[0],
    outgoingReleased: true,
    incomingContinues: true
  })
  await reset()

  // Manual requests start immediately rather than waiting for the track tail.
  await begin(['a', 'b', 'skip-c'], 0)
  await js('window.__crossfadeProbe.player().setManualCrossfadeDuration(2000);window.__crossfadeProbe.player().next()')
  await waitForIndex(1, 'manual immediate overlap')
  const manualBefore = await snapshot()
  await sleep(250)
  const manualAfter = await snapshot()
  assert.ok(manualAfter.audio.every(item => !item.paused))
  assert.ok(manualAfter.audio.every((item, index) => item.currentTime > manualBefore.audio[index].currentTime))
  await js('window.__crossfadeProbe.player().playQueueEntry(2)')
  await waitForIndex(2, 'latest manual selection during overlap')
  assert.ok(!(await snapshot()).audio.some(item => item.src.includes('/media/a.wav')))
  await wait(async () => !(await snapshot()).audio.some(item => item.src.includes('/media/b.wav')), 'manual exact outgoing release')
  await finishCase('manual-overlap-and-latest-intent', { bothClocksAdvanced: true, originalReleased: true, outgoingReleased: true })
  await reset()

  await begin(['fail-a', 'fail-b'], 0)
  await js('window.__crossfadeProbe.player().setManualCrossfadeDuration(3000);window.__crossfadeProbe.player().next()')
  await waitForIndex(1, 'manual rollback handoff')
  await sleep(200)
  const manualOutgoingTime = await js('window.__crossfadeProbe.injectDecodeError("fail-b")')
  const manualRollback = await waitForIndex(0, 'manual decode rollback')
  assert.equal(manualRollback.error, null)
  assert.ok(manualRollback.playing)
  await finishCase('manual-failure-rollback', { outgoingContinues: true, playerError: null, incomingTimeAtFailure: manualOutgoingTime })
  await reset()

  await begin(['a', 'short'], 0)
  await js('window.__crossfadeProbe.player().setManualCrossfadeDuration(3000);window.__crossfadeProbe.player().next()')
  const immediate = await waitForIndex(1, 'manual protected short handoff')
  assert.equal(immediate.currentId, 'short')
  assert.ok(!immediate.audio.some(item => item.src.includes('/media/a.wav')))
  await finishCase('manual-short-prepared-handoff', { currentId: immediate.currentId, outgoingReleased: true })
  await reset()

  // A-B uses actual media seeks. Record sampled deviation without claiming sample accuracy.
  await begin(['a', 'b'], 0)
  await js('(()=>{const p=window.__crossfadeProbe.player();p.seek(1);p.setLoopA();p.seek(3);p.setLoopB()})()')
  const loopFirst = await wait(async () => { const s=await snapshot();return s.currentTime >= 1 && s.currentTime < 1.7 ? s : null }, 'first A-B wrap')
  await sleep(1700)
  const loopSecond = await wait(async () => { const s=await snapshot();return s.currentTime >= 1 && s.currentTime < 1.7 ? s : null }, 'second A-B wrap')
  assert.equal(loopSecond.currentId, 'a')
  assert.equal(loopSecond.queueIds.length, 2)
  await finishCase('AB-native-two-wraps', { firstSampleDeviationSeconds: loopFirst.audio.find(a=>!a.paused).currentTime-1, secondSampleDeviationSeconds: loopSecond.audio.find(a=>!a.paused).currentTime-1, nextTrackNotStarted: true })
  await reset()

  await begin(['a', 'b'], 0)
  await js('(()=>{const p=window.__crossfadeProbe.player();p.seek(9);p.setLoopA();p.seek(10.5);p.setLoopB();p.setSleepMode("track-end");p.setSleepMinutes(0.0001)})()')
  const waiting = await wait(async () => { const s=await snapshot();return s.sleepWaiting ? s : null }, 'sleep waits for whole current track')
  assert.equal(waiting.loop.enabled, false)
  await js('window.__crossfadeProbe.player().seek(11.5)')
  const sleepStop = await wait(async () => { const s=await snapshot();return !s.playing && s.audio.every(a=>!a.src) ? s : null }, 'sleep ends whole track without next')
  assert.equal(sleepStop.currentId, 'a')
  await finishCase('sleep-exits-AB-and-stops-at-natural-end', { loopExited: true, nextNotStarted: true, allDecksReleased: true })
  await reset()

  await begin(['a', 'b'],0)
  await js('(()=>{const p=window.__crossfadeProbe.player();p.setVolume(0.7);p.setSleepFadeDuration(5000);p.setSleepMode("immediate");p.setSleepMinutes(6.5/60)})()')
  await sleep(1200)
  const fadeEarly=await snapshot()
  await sleep(1500)
  const fadeMiddle=await snapshot()
  await js('window.__crossfadeProbe.stageQueue(["b"],2000)')
  await wait(async()=>{const s=await snapshot();return s.audio.filter(a=>!a.paused&&a.currentSrc).length===2?s:null},'sleep fade overlaps actual decks')
  await sleep(1300)
  const fadeLate=await snapshot()
  assert.ok(fadeEarly.outputRms>0.01&&fadeMiddle.outputRms<fadeEarly.outputRms*0.9&&fadeLate.outputRms<fadeMiddle.outputRms*0.8,'sleep output energy decreases throughout the countdown and actual crossfade')
  assert.ok(fadeLate.energy440>0&&fadeLate.energy880>0,'both tones remain present during attenuated overlap')
  await js('window.__crossfadeProbe.player().setSleepMinutes(0)')
  await sleep(250)
  const fadeRecovered=await snapshot()
  assert.ok(fadeRecovered.outputRms>fadeLate.outputRms*1.3,'cancel restores shared gain without changing user volume')
  assert.equal(fadeRecovered.volume,0.7)
  await js('window.__crossfadeProbe.player().setSleepMinutes(0.02)')
  await wait(async()=>{const s=await snapshot();return !s.playing&&s.audio.every(a=>!a.src)?s:null},'sleep fade stops at rearmed deadline')
  await sleep(100)
  const fadeStopped=await snapshot()
  assert.ok(fadeStopped.outputRms<0.001,'stopped output is silent')
  await finishCase('sleep-countdown-energy-overlap-cancel-and-stop',{rms:[fadeEarly.outputRms,fadeMiddle.outputRms,fadeLate.outputRms],recoveredRms:fadeRecovered.outputRms,userVolume:fadeRecovered.volume,stoppedRms:fadeStopped.outputRms})
  await reset()

  await begin(['a','b'],0)
  await sleep(200)
  await js('(()=>{const p=window.__crossfadeProbe.player();p.setSleepFadeDuration(5000);p.setSleepMode("track-end");p.setSleepMinutes(0.0001)})()')
  await wait(async()=>{const s=await snapshot();return s.sleepWaiting?s:null},'fade waits for whole track')
  await js('window.__crossfadeProbe.player().seek(9)')
  await sleep(250)
  const tailNormal=await snapshot()
  await js('window.__crossfadeProbe.player().setRate(2)')
  await sleep(200)
  const tailFast=await snapshot()
  assert.ok(tailNormal.outputRms>0.01&&tailFast.outputRms<tailNormal.outputRms*0.8,'rate changes recompute wall-clock tail attenuation')
  await js('window.__crossfadeProbe.player().seek(5)')
  await sleep(200)
  const tailSeek=await snapshot()
  assert.ok(tailSeek.outputRms>tailFast.outputRms*1.5,'backward seek recomputes remaining tail')
  await js('window.__crossfadeProbe.player().seek(11.6)')
  const tailStop=await wait(async()=>{const s=await snapshot();return !s.playing&&s.audio.every(a=>!a.src)?s:null},'faded whole track stops without successor')
  assert.equal(tailStop.currentId,'a')
  await finishCase('sleep-whole-track-tail-rate-and-seek',{rmsNormal:tailNormal.outputRms,rmsAt2x:tailFast.outputRms,rmsAfterBackwardSeek:tailSeek.outputRms,allDecksReleased:true})
  await reset()

  await begin(['a'],0)
  await js('(()=>{const p=window.__crossfadeProbe.player();p.setSleepFadeDuration(5000);p.setSleepMinutes(0.02)})()')
  await sleep(100)
  assert.equal((await snapshot()).sleepFading,true)
  await js('window.__crossfadeProbe.dispose();void 0')
  const disposedFade=await wait(async()=>{const s=await snapshot();return s.audio.every(a=>!a.src)&&s.contextStates.at(-1)==='closed'?s:null},'dispose releases attenuated media and context')
  assert.equal(disposedFade.playing,false)
  await wait(()=>activeMedia.size===0,'dispose releases attenuated media request')
  await finishCase('sleep-fading-dispose-releases-graph',{allDecksReleased:true,contextClosed:true,activeMediaRequests:activeMedia.size})
  await reset()

  await begin(['a', 'b'], 0)
  await js('(()=>{const p=window.__crossfadeProbe.player();p.seek(1);p.setLoopA();p.seek(3);p.setLoopB()})()')
  await wait(async () => {
    const state = await snapshot()
    return state.playing && !state.waiting && state.currentTime >= 1 && state.currentTime < 1.7
  }, 'outgoing loop seek settled before protected queue request')
  await js('window.__crossfadeProbe.holdResolution("skip-c");window.__crossfadeProbe.stageQueue(["skip-c"])')
  const preparingBefore = await snapshot()
  await sleep(200)
  const preparingAfter = await snapshot()
  assert.equal(preparingAfter.currentId, 'a')
  assert.deepEqual(preparingAfter.queueIds, ['a', 'b'])
  assert.equal(preparingAfter.historyIds.length, 0)
  assert.ok(preparingAfter.currentTime > preparingBefore.currentTime)
  assert.equal(preparingAfter.loop.enabled, true)
  await js('window.__crossfadeProbe.player().clearLoop()')
  const clearedWhilePreparing = await snapshot()
  assert.equal(clearedWhilePreparing.loop, null)
  assert.equal(clearedWhilePreparing.pendingId, 'skip-c')
  await js('window.__releaseResolution()')
  await wait(async () => (await snapshot()).currentId === 'skip-c', 'cross queue native handoff')
  const crossCommitted = await snapshot()
  assert.deepEqual(crossCommitted.queueIds, ['skip-c'])
  assert.deepEqual(crossCommitted.historyIds[0], ['a', 'b'])
  assert.equal(crossCommitted.audio.filter(a=>!a.paused&&a.src).length, 2)
  await js('window.__crossfadeProbe.injectDecodeError("skip-c")')
  const queueRollback = await wait(async () => { const s=await snapshot();return s.currentId==='a'?s:null }, 'cross queue rollback')
  assert.deepEqual(queueRollback.queueIds, ['a', 'b'])
  assert.equal(queueRollback.historyIds.length, 0)
  assert.ok(queueRollback.playing)
  assert.equal(queueRollback.loop, null, 'rollback must not restore an explicitly cleared loop')
  await finishCase('cross-queue-native-prepare-commit-rollback', { outgoingClockContinued: true, stagedHistoryUntouched: true, dualDeckHandoff: true, queueAndHistoryRestored: true, explicitlyClearedLoopStayedCleared: true })
  await reset()

  // The restored outgoing track must again own the shuffle history cursor.
  await begin(['a', 'b', 'skip-c'], 0)
  await js('window.__crossfadeProbe.player().setPlayMode("random");window.__crossfadeProbe.player().setManualCrossfadeDuration(3000);window.__crossfadeProbe.player().playQueueEntry(2)')
  await waitForIndex(2, 'random manual handoff')
  await js('window.__crossfadeProbe.injectDecodeError("skip-c")')
  await waitForIndex(0, 'random rollback restores outgoing')
  await js('window.__crossfadeProbe.clearDecodeError();window.__crossfadeProbe.player().previous()')
  const previousChoice = await snapshot()
  assert.ok(previousChoice.pendingId === 'skip-c' || previousChoice.currentId === 'skip-c', 'previous must retain the audible failed target instead of restarting the restored track')
  await waitForIndex(2, 'random previous plays the expected history entry')
  await finishCase('random-rollback-history-cursor', { outgoingRestored: true, audibleFailedTargetRetained: true, previousPlayedExpectedTrack: true })
  await reset()

  await begin(['a','b'],0)
  await js('window.__crossfadeProbe.player().setSleepMinutes(1);window.__crossfadeProbe.stageQueue(["b","a","skip-c"],3000)')
  await wait(async()=>{const s=await snapshot();return s.currentId==='b'&&s.audio.filter(a=>!a.paused&&a.src).length===2?s:null},'bulk edit begins during actual crossqueue overlap')
  const beforeBulk=await snapshot(),beforeBulkClock=beforeBulk.audio.find(a=>a.currentSrc.includes('/media/b.wav')&&!a.paused).currentTime
  await js('(()=>{const p=window.__crossfadeProbe.player();p.applyQueueEdit(p.queueEditContext(["online:wy:a","online:wy:b"]),"to-end")})()')
  await sleep(100)
  const afterBulk=await snapshot()
  assert.deepEqual(afterBulk.queueIds,['skip-c','b','a'])
  assert.equal(afterBulk.currentId,'b')
  assert.equal(afterBulk.currentIndex,1)
  assert.equal(afterBulk.audio.filter(a=>!a.paused&&a.src).length,1)
  assert.ok(afterBulk.audio.find(a=>a.currentSrc.includes('/media/b.wav')&&!a.paused).currentTime>=beforeBulkClock)
  assert.equal(afterBulk.sleepAt,beforeBulk.sleepAt)
  assert.deepEqual(afterBulk.historyIds,beforeBulk.historyIds)
  await js('(()=>{const p=window.__crossfadeProbe.player();p.applyQueueEdit(p.queueEditContext(["online:wy:a","online:wy:b"]),"remove")})()')
  const removedBulk=await snapshot()
  assert.deepEqual(removedBulk.queueIds,['skip-c'])
  assert.equal(removedBulk.currentIndex,-1)
  assert.equal(removedBulk.sleepAt,null)
  assert.ok(removedBulk.audio.every(a=>a.paused&&!a.src))
  await finishCase('queue-bulk-edit-during-native-handoff',{finalOrder:afterBulk.queueIds,currentPreserved:true,currentIndex:afterBulk.currentIndex,clockContinued:true,sleepPreservedOnMove:true,historyPreserved:true,currentRemovalReleasedBothDecks:true})
  await reset()

  await begin(['a','b','a','skip-c'],0)
  await js('window.__crossfadeProbe.player().playTrackAt(2)')
  await wait(async()=>{const s=await snapshot();return s.currentIndex===2&&s.playing&&s.audio.some(a=>!a.paused&&a.currentTime>0.1)?s:null},'later duplicate row actually playing')
  await js('(()=>{const p=window.__crossfadeProbe.player();p.currentTrack.name="Kept later row";window.__keptDuplicate=p.currentTrack;p.seek(2);p.setLoopA();p.seek(5);p.setLoopB();p.setSleepMinutes(1);p.toggle()})()')
  const beforeDedup=await snapshot(),dedupClock=beforeDedup.audio.find(a=>a.src).currentTime
  await js('(()=>{const p=window.__crossfadeProbe.player();p.applyQueueDeduplication(p.queueDeduplicationContext())})()')
  const afterDedup=await snapshot()
  assert.deepEqual(afterDedup.queueIds,['b','a','skip-c']);assert.equal(afterDedup.currentIndex,1);assert.equal(afterDedup.playing,false)
  assert.equal(await js('window.__crossfadeProbe.player().currentTrack===window.__keptDuplicate'),true)
  assert.equal(afterDedup.audio.find(a=>a.src).currentTime,dedupClock);assert.deepEqual(afterDedup.loop,beforeDedup.loop);assert.equal(afterDedup.sleepAt,beforeDedup.sleepAt)
  await js('window.__crossfadeProbe.player().toggle()');await sleep(150)
  assert.equal((await snapshot()).playing,true)
  await finishCase('queue-dedup-later-current-paused-native',{finalOrder:afterDedup.queueIds,exactCurrentRowRetained:true,clockRetained:true,pausedPreserved:true,loopAndSleepPreserved:true,resumed:true})
  await reset()

  await begin(['a','b'],0)
  await js('window.__crossfadeProbe.stageQueue(["b","a","b","skip-c"],3000)')
  await wait(async()=>{const s=await snapshot();return s.currentId==='b'&&s.audio.filter(a=>!a.paused&&a.src).length===2?s:null},'dedup native dual deck handoff')
  const overlapDedup=await snapshot(),incomingClock=overlapDedup.audio.find(a=>a.currentSrc.includes('/media/b.wav')&&!a.paused).currentTime
  await js('(()=>{const p=window.__crossfadeProbe.player();p.applyQueueDeduplication(p.queueDeduplicationContext())})()');await sleep(100)
  const finalizedDedup=await snapshot()
  assert.deepEqual(finalizedDedup.queueIds,['b','a','skip-c']);assert.equal(finalizedDedup.currentId,'b');assert.equal(finalizedDedup.audio.filter(a=>!a.paused&&a.src).length,1)
  assert.ok(finalizedDedup.audio.find(a=>a.currentSrc.includes('/media/b.wav')&&!a.paused).currentTime>=incomingClock);assert.deepEqual(finalizedDedup.historyIds,overlapDedup.historyIds)
  await js('window.__crossfadeProbe.holdResolution("skip-c");window.__crossfadeProbe.stageQueue(["skip-c"])')
  // Make another duplicate queue through the current public data model, keeping the same audible row.
  await js('(()=>{const p=window.__crossfadeProbe.player();p.queue=[...p.queue,p.queue[1]];p.applyQueueDeduplication(p.queueDeduplicationContext());window.__releaseResolution()})()');await sleep(150)
  assert.deepEqual((await snapshot()).queueIds,['b','a','skip-c']);assert.equal((await snapshot()).currentId,'b')
  await finishCase('queue-dedup-native-overlap-and-delayed-resolution',{incomingClockContinued:true,outgoingReleased:true,historyPreserved:true,lateResolutionInert:true})
  await reset()

  // Stop must cancel a deliberately slow local media request and clear both element sources.
  await begin(['stream', 'unused'], 0)
  const liveRequestCount = activeMedia.size
  assert.ok(liveRequestCount > 0, 'the slow synthetic media request must still be active before stop')
  await js('window.__crossfadeProbe.stop()')
  await wait(() => activeMedia.size === 0, 'stop cancelled active media request')
  const stopped = await snapshot()
  assert.ok(stopped.audio.every(item => item.paused && !item.src))
  await finishCase('stop-releases-active-media', { activeRequestsBeforeStop: liveRequestCount, activeRequestsAfterStop: activeMedia.size, allDeckSourcesCleared: true })
  await js('window.__crossfadeProbe.dispose()')

  assert.equal(blockedExternalRequests, 0, 'the probe must not access external URLs')
  assert.equal(activeMedia.size, 0, 'the probe must not leave generated media requests active')
  report('passed')
  console.log(`PASS: ${reports.length} native Electron crossfade cases; zero external requests`)
  browserWindow.destroy()
  await new Promise(resolve => server.close(resolve))
  clearTimeout(watchdog)
  app.exit(0)
}).catch(async error => {
  console.error(error)
  report('failed', error.stack ?? String(error))
  browserWindow?.destroy()
  if (server?.listening) await new Promise(resolve => server.close(resolve))
  clearTimeout(watchdog)
  app.exit(1)
})
