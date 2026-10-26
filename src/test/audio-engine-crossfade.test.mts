import assert from 'node:assert/strict'
import { test } from 'node:test'
import { WebAudioEngine } from './renderer/audio/web-audio-engine.js'

function parameter(value = 0) {
  return {
    value,
    commands: [],
    cancelScheduledValues(time) { this.commands.push(['cancel', time]) },
    cancelAndHoldAtTime(time) { this.commands.push(['hold', time]) },
    setValueAtTime(next, time) { this.value = next; this.commands.push(['set', next, time]) },
    setValueCurveAtTime(values, time, duration) { this.commands.push(['curve', [...values], time, duration]) },
    setTargetAtTime(next, time, constant) { this.value = next; this.commands.push(['target', next, time, constant]) }
  }
}

class FakeAudio extends EventTarget {
  static instances = []
  constructor() {
    super()
    FakeAudio.instances.push(this)
  }
  paused = true
  ended = false
  src = ''
  currentTime = 0
  duration = 180
  readyState = 0
  error = null
  playbackRate = 1
  preservesPitch = true
  preload = ''
  crossOrigin = ''
  loadCalls = 0
  getAttribute(name) { return name === 'src' ? this.src || null : null }
  removeAttribute(name) { if (name === 'src') this.src = '' }
  load() { this.loadCalls += 1; if (!this.src) { this.paused = true; this.readyState = 0 } }
  async play() {
    if (!this.src) throw new DOMException('missing source', 'NotSupportedError')
    this.paused = false
    this.ended = false
    this.readyState = 4
    this.dispatchEvent(new Event('playing'))
  }
  pause() {
    this.paused = true
    this.dispatchEvent(new Event('pause'))
  }
  signalReady() {
    this.readyState = 4
    this.dispatchEvent(new Event('loadedmetadata'))
    this.dispatchEvent(new Event('canplay'))
  }
  signalError(code = 3) {
    this.error = { code }
    this.dispatchEvent(new Event('error'))
  }
  signalEnded() {
    this.ended = true
    this.dispatchEvent(new Event('ended'))
  }
}

class FakeContext {
  static instances = []
  constructor() {
    FakeContext.instances.push(this)
  }
  currentTime = 0
  state = 'running'
  destination = {}
  sources = []
  filters = []
  gains = []
  analysers = []
  createMediaElementSource(element) {
    const source = { element, connections: [], disconnected: false, connect(node) { this.connections.push(node) }, disconnect() { this.disconnected = true } }
    this.sources.push(source)
    return source
  }
  createBiquadFilter() {
    const filter = { connections: [], disconnected: false, type: '', frequency: parameter(), Q: parameter(), gain: parameter(), connect(node) { this.connections.push(node) }, disconnect() { this.disconnected = true } }
    this.filters.push(filter)
    return filter
  }
  createGain() {
    const gain = { connections: [], disconnected: false, gain: parameter(), connect(node) { this.connections.push(node) }, disconnect() { this.disconnected = true } }
    this.gains.push(gain)
    return gain
  }
  createAnalyser() {
    const analyser = { disconnected: false, frequencyBinCount: 8, connect() {}, disconnect() { this.disconnected = true }, getByteFrequencyData() {} }
    this.analysers.push(analyser)
    return analyser
  }
  async resume() { this.state = 'running' }
  async close() { this.state = 'closed' }
}

function makeEngine() {
  FakeAudio.instances = []
  FakeContext.instances = []
  globalThis.Audio = FakeAudio
  globalThis.MediaError = {
    MEDIA_ERR_ABORTED: 1,
    MEDIA_ERR_NETWORK: 2,
    MEDIA_ERR_DECODE: 3,
    MEDIA_ERR_SRC_NOT_SUPPORTED: 4
  }
  globalThis.window = {
    AudioContext: FakeContext,
    setInterval: () => 1,
    clearInterval: () => {}
  }
  return new WebAudioEngine()
}

async function loadActive(engine, url = 'test://active') {
  const active = FakeAudio.instances[0]
  await engine.load({ url })
  await engine.play()
  return active
}

async function prepare(engine, url = 'test://incoming', options = {}) {
  const preparing = engine.prepareTrack({ url, ...options })
  const incoming = FakeAudio.instances[1]
  incoming.signalReady()
  return { token: await preparing, incoming }
}

test('sleep gain initializes before load and is a separate shared output stage',async()=>{
 const engine=makeEngine()
 try{
  engine.setSleepGain(0.25);engine.setVolume(0.6);await loadActive(engine)
  const c=FakeContext.instances[0],sleep=c.gains[4];assert.equal(c.gains.length,5);assert.equal(sleep.gain.value,0.25)
  assert.equal(c.gains[3].connections[0],sleep);assert.equal(c.gains[2].gain.value,0.6)
  engine.setMuted(true);assert.equal(c.gains[2].gain.value,0);assert.equal(sleep.gain.value,0.25)
  engine.setSleepGain(NaN);assert.equal(sleep.gain.value,0.25);engine.setSleepGain(2);assert.equal(sleep.gain.value,1)
  engine.destroy();assert.equal(sleep.disconnected,true)
 }finally{engine.destroy()}
})
test('sleep gain survives crossfade rollback and short pause transitions independently',async()=>{
 const engine=makeEngine()
 try{
  await loadActive(engine);engine.setSleepGain(0.4);const c=FakeContext.instances[0],{token,incoming}=await prepare(engine)
  const op=engine.crossfadeTo(token,3000);await op.started;const rejected=assert.rejects(op.completed);incoming.signalError(3);await rejected
  assert.equal(c.gains[4].gain.value,0.4);assert.equal(engine.getVolume(),0.8)
  engine.setTransitionsEnabled(false);await engine.pause();assert.equal(c.gains[4].gain.value,0.4)
 }finally{engine.destroy()}
})

test('prepared deck shares the active AudioContext', async () => {
  const engine = makeEngine()
  try {
    const active = await loadActive(engine)
    let playingEvents = 0
    engine.on('playing', () => { playingEvents += 1 })
    const context = FakeContext.instances[0]
    assert.equal(context.sources.length, 2)
    assert.equal(engine.capabilities.crossfade, true)

    const preparing = engine.prepareTrack({ url: 'test://incoming', startAt: 12 })
    const incoming = FakeAudio.instances[1]
    incoming.signalReady()
    const token = await preparing

    assert.equal(context.sources.length, 2)
    assert.equal(context.sources[0].element, active)
    assert.equal(context.sources[1].element, incoming)
    assert.equal(incoming.currentTime, 12)
    assert.equal(active.paused, false)
    assert.equal(engine.getCurrentTime(), active.currentTime)
    assert.equal(playingEvents, 0)
    engine.discardPreparedTrack(token)
  } finally {
    engine.destroy()
  }
})

test('preparation failure leaves the active deck audible', async () => {
  const engine = makeEngine()
  try {
    const active = await loadActive(engine)
    assert.equal(engine.capabilities.crossfade, true)
    const preparing = engine.prepareTrack({ url: 'test://bad' })
    FakeAudio.instances[1].signalError(3)

    await assert.rejects(preparing, /解码失败/)
    assert.equal(engine.isPlaying(), true)
    assert.equal(active.paused, false)
    assert.equal(FakeContext.instances[0].gains[0].gain.value, 1)
  } finally {
    engine.destroy()
  }
})

test('only the promoted deck emits active progress and ended events', async () => {
  const engine = makeEngine()
  try {
    const outgoing = await loadActive(engine)
    let playingEvents = 0
    let endedEvents = 0
    const progressEvents = []
    engine.on('playing', () => { playingEvents += 1 })
    engine.on('ended', () => { endedEvents += 1 })
    engine.on('progress', (time) => progressEvents.push(time))
    assert.equal(engine.capabilities.crossfade, true)
    const { token, incoming } = await prepare(engine)
    assert.equal(typeof engine.crossfadeTo, 'function')

    const operation = engine.crossfadeTo(token, 1_000)
    await operation.started
    incoming.currentTime = 8
    outgoing.currentTime = 100
    assert.equal(engine.getCurrentTime(), 8)
    engine.seek(10)
    assert.equal(incoming.currentTime, 10)
    assert.equal(outgoing.src, '', 'seeking after handoff finishes and releases the old deck')
    assert.equal(playingEvents, 1)

    outgoing.signalEnded()
    assert.equal(endedEvents, 0)
    operation.finish()
    await operation.completed
    assert.equal(outgoing.src, '')
    incoming.signalEnded()
    assert.equal(endedEvents, 1)
    assert.deepEqual(progressEvents.at(-1), 10)
  } finally {
    engine.destroy()
  }
})

test('an asynchronous zero-duration handoff commits started before completion cleanup', async () => {
  const engine = makeEngine()
  try {
    const outgoing = await loadActive(engine)
    const { token, incoming } = await prepare(engine)
    let releasePlay = () => {}
    incoming.play = () => {
      incoming.paused = false
      incoming.ended = false
      incoming.readyState = 4
      return new Promise((resolve) => { releasePlay = () => resolve() })
    }
    const operation = engine.crossfadeTo(token, 0)
    const events = []
    void operation.started.then(() => events.push('started'))
    void operation.completed.then(() => events.push('completed'))

    incoming.dispatchEvent(new Event('playing'))
    releasePlay()
    await operation.started
    await operation.completed
    assert.deepEqual(events, ['started', 'completed'])
    assert.equal(outgoing.src, '')
    assert.equal(incoming.src, 'test://incoming')
    assert.equal(engine.isPlaying(), true)
  } finally {
    engine.destroy()
  }
})

test('a zero-duration incoming play failure before playing preserves the outgoing deck', async () => {
  const engine = makeEngine()
  try {
    const outgoing = await loadActive(engine)
    outgoing.currentTime = 41
    const { token, incoming } = await prepare(engine)
    incoming.play = async () => { throw new DOMException('incoming denied', 'NotAllowedError') }
    const operation = engine.crossfadeTo(token, 0)
    await assert.rejects(operation.started, /incoming denied/)
    await operation.completed
    assert.equal(outgoing.src, 'test://active')
    assert.equal(outgoing.paused, false)
    assert.equal(engine.getCurrentTime(), 41)
    assert.equal(engine.isPlaying(), true)
    assert.equal(incoming.src, '')
  } finally {
    engine.destroy()
  }
})

test('incoming failure after audible handoff restores the outgoing deck and rejects completion', async () => {
  const engine = makeEngine()
  try {
    const outgoing = await loadActive(engine)
    outgoing.currentTime = 41
    let playingEvents = 0
    engine.on('playing', () => { playingEvents += 1 })
    const { token, incoming } = await prepare(engine)
    const operation = engine.crossfadeTo(token, 1_000)
    await operation.started

    incoming.signalError(3)
    await assert.rejects(operation.completed, /解码失败/)
    assert.equal(engine.getCurrentTime(), 41)
    assert.equal(engine.isPlaying(), true)
    assert.equal(outgoing.paused, false)
    assert.equal(incoming.src, '')
    assert.equal(playingEvents, 2, 'restoring the previous active deck notifies playback observers')
  } finally {
    engine.destroy()
  }
})

test('seek before the incoming deck becomes audible cancels it and stays on the outgoing deck', async () => {
  const engine = makeEngine()
  try {
    const outgoing = await loadActive(engine)
    const { token, incoming } = await prepare(engine)
    let finishPlay
    incoming.play = () => new Promise((resolve) => {
      finishPlay = () => {
        incoming.paused = false
        incoming.readyState = 4
        incoming.dispatchEvent(new Event('playing'))
        resolve()
      }
    })
    const operation = engine.crossfadeTo(token, 1_000)
    engine.seek(27)
    await assert.rejects(operation.started, /取消|AbortError/i)
    finishPlay()
    await Promise.resolve()

    assert.equal(engine.getCurrentTime(), 27)
    assert.equal(outgoing.currentTime, 27)
    assert.equal(outgoing.paused, false)
    assert.equal(incoming.src, '')
  } finally {
    engine.destroy()
  }
})

test('pausing and resuming a crossfade pauses and resumes both decks', async () => {
  const engine = makeEngine()
  try {
    await loadActive(engine)
    const { token, incoming } = await prepare(engine)
    const outgoing = FakeAudio.instances[0]
    const operation = engine.crossfadeTo(token, 1_000)
    await operation.started

    operation.pause()
    assert.equal(outgoing.paused, true)
    assert.equal(incoming.paused, true)
    operation.resume()
    await Promise.resolve()
    assert.equal(outgoing.paused, false)
    assert.equal(incoming.paused, false)
    operation.finish()
    await operation.completed
  } finally {
    engine.destroy()
  }
})

test('volume mute equalizer and rate apply to both decks', async () => {
  const engine = makeEngine()
  try {
    engine.setVolume(0.45)
    engine.setMuted(true)
    engine.setEqualizer([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
    engine.setRate(1.75)
    engine.setPreservesPitch(false)
    await engine.load({ url: 'test://active' })
    assert.equal(engine.capabilities.crossfade, true)
    await prepare(engine)

    const context = FakeContext.instances[0]
    assert.equal(FakeAudio.instances.length, 2)
    assert.deepEqual(FakeAudio.instances.map((audio) => audio.playbackRate), [1.75, 1.75])
    assert.deepEqual(FakeAudio.instances.map((audio) => audio.preservesPitch), [false, false])
    assert.equal(context.gains.length, 5)
    assert.equal(context.gains[2].gain.value, 0)
    engine.setMuted(false)
    assert.equal(context.gains[2].gain.value, 0.45)
    assert.deepEqual(context.filters.map((filter) => filter.gain.value), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
    assert.ok(context.sources.every((source) => source.connections.length === 1))
  } finally {
    engine.destroy()
  }
})

test('changing rate during a crossfade retimes it before either media deck can end', async () => {
  const engine = makeEngine()
  try {
    const outgoing = await loadActive(engine)
    outgoing.currentTime = 176
    const { token, incoming } = await prepare(engine)
    const operation = engine.crossfadeTo(token, 4_000)
    await operation.started
    const context = FakeContext.instances[0]
    const outgoingGain = context.gains[0].gain
    const incomingGain = context.gains[1].gain
    const curveDuration = parameterValue => parameterValue.commands.filter(command => command[0] === 'curve').at(-1)?.[3]

    assert.equal(curveDuration(outgoingGain), 4)
    context.currentTime = 1
    outgoing.currentTime = 177
    incoming.currentTime = 1
    engine.setRate(2)

    assert.equal(outgoing.playbackRate, 2)
    assert.equal(incoming.playbackRate, 2)
    assert.equal(curveDuration(outgoingGain), 1.5)
    assert.equal(curveDuration(incomingGain), 1.5)
    operation.finish()
    await operation.completed
  } finally {
    engine.destroy()
  }
})

test('load and stop discard any prepared deck', async () => {
  const engine = makeEngine()
  try {
    await loadActive(engine)
    assert.equal(engine.capabilities.crossfade, true)
    const { token, incoming } = await prepare(engine)
    assert.equal(typeof engine.discardPreparedTrack, 'function')
    assert.ok(token)
    await engine.load({ url: 'test://replacement' })
    assert.equal(incoming.src, '')

    const { incoming: secondPrepared } = await prepare(engine, 'test://next')
    engine.stop()
    assert.equal(secondPrepared.src, '')
    assert.equal(FakeAudio.instances[0].src, '')
  } finally {
    engine.destroy()
  }
})

test('aborting preparation releases only the inactive deck', async () => {
  const engine = makeEngine()
  try {
    const active = await loadActive(engine)
    assert.equal(engine.capabilities.crossfade, true)
    const controller = new AbortController()
    const preparing = engine.prepareTrack({ url: 'test://slow' }, controller.signal)
    const incoming = FakeAudio.instances[1]
    controller.abort()

    await assert.rejects(preparing, /取消|AbortError/i)
    assert.equal(active.paused, false)
    assert.equal(active.src, 'test://active')
    assert.equal(incoming.src, '')
  } finally {
    engine.destroy()
  }
})

test('destroy releases both media elements and ignores stale deck events', async () => {
  const engine = makeEngine()
  const active = await loadActive(engine)
  assert.equal(FakeAudio.instances.length, 2)
  assert.equal(engine.capabilities.crossfade, true)
  const { incoming } = await prepare(engine)
  const context = FakeContext.instances[0]
  let endedEvents = 0
  engine.on('ended', () => { endedEvents += 1 })

  assert.equal(FakeAudio.instances.length, 2)
  engine.destroy()
  active.signalEnded()
  incoming.signalEnded()

  assert.equal(active.src, '')
  assert.equal(incoming.src, '')
  assert.equal(active.paused, true)
  assert.equal(incoming.paused, true)
  assert.equal(context.sources.every((source) => source.disconnected), true)
  assert.equal(endedEvents, 0)
})

test('outgoing ended before a pending incoming deck starts cancels it and advances once', async () => {
  const engine = makeEngine()
  try {
    const outgoing = await loadActive(engine)
    outgoing.currentTime = 176
    let endedEvents = 0
    let playingEvents = 0
    engine.on('ended', () => { endedEvents += 1 })
    engine.on('playing', () => { playingEvents += 1 })

    const { token, incoming } = await prepare(engine)
    let resolvePendingPlay = () => {}
    incoming.play = () => new Promise((resolve) => { resolvePendingPlay = () => resolve() })
    const operation = engine.crossfadeTo(token, 1_000)
    assert.equal(typeof resolvePendingPlay, 'function')

    outgoing.signalEnded()
    const startedOutcome = await Promise.race([
      operation.started.then(() => 'started', () => 'rejected'),
      new Promise((resolve) => setTimeout(() => resolve('pending'), 25))
    ])
    assert.equal(startedOutcome, 'rejected')
    await operation.completed

    assert.equal(endedEvents, 1)
    assert.equal(playingEvents, 0, 'restoring an ended outgoing deck must not emit playing')
    assert.equal(incoming.src, '')
    assert.equal(engine.getCurrentTime(), outgoing.currentTime)

    incoming.paused = false
    incoming.ended = false
    resolvePendingPlay()
    incoming.dispatchEvent(new Event('playing'))
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(playingEvents, 0, 'a late incoming playing event must not revive a cancelled fade')
    assert.equal(endedEvents, 1)
  } finally {
    engine.destroy()
  }
})

test('outgoing ended during crossfade completes the handoff without advancing twice', async () => {
  const engine = makeEngine()
  try {
    await loadActive(engine)
    let endedEvents = 0
    engine.on('ended', () => { endedEvents += 1 })
    assert.equal(engine.capabilities.crossfade, true)
    const { token, incoming } = await prepare(engine)
    const operation = engine.crossfadeTo(token, 1_000)
    await operation.started

    FakeAudio.instances[0].signalEnded()
    await operation.completed
    assert.equal(endedEvents, 0)
    assert.equal(FakeAudio.instances[0].src, '')
    assert.equal(engine.getCurrentTime(), incoming.currentTime)
    operation.finish()
    incoming.signalEnded()
    assert.equal(endedEvents, 1)
  } finally {
    engine.destroy()
  }
})
