import assert from 'node:assert/strict'
import { test } from 'node:test'
import { GainTransition } from './renderer/audio/gain-transition.js'
import { WebAudioEngine } from './renderer/audio/web-audio-engine.js'

function clock() {
  let time = 0, next = 0
  const jobs = new Map()
  return {
    now: () => time / 1000,
    schedule: (callback, milliseconds) => { const id = ++next; jobs.set(id, { callback, at: time + milliseconds }); return () => jobs.delete(id) },
    advance: milliseconds => { time += milliseconds; for (const [id, job] of [...jobs]) if (job.at <= time) { jobs.delete(id); job.callback() } },
    jobs
  }
}
function parameter() {
  return { value: 1, commands: [], cancelScheduledValues(time) { this.commands.push(['cancel', time]) }, setValueAtTime(value, time) { this.value = value; this.commands.push(['set', value, time]) }, linearRampToValueAtTime(value, time) { this.commands.push(['ramp', value, time]) }, setTargetAtTime(value, time) { this.value = value; this.commands.push(['volume', value, time]) } }
}
test('new gain transition holds the current level and cancels the previous completion', async () => {
  const c = clock(), p = parameter(), transition = new GainTransition(p, c.now, c.schedule)
  const first = transition.to(0, 300)
  const staleCompletion = [...c.jobs.values()][0].callback
  c.advance(150)
  const second = transition.to(1, 150)
  assert.equal(await first, false)
  assert.ok(p.commands.some(command => command[0] === 'set' && Math.abs(command[1] - 0.5) < 0.001))
  staleCompletion()
  c.advance(150)
  assert.equal(await second, true)
  assert.equal(transition.level, 1)
})
test('reset cancels delayed effects while finish applies the current intent immediately', async () => {
  const c = clock(), transition = new GainTransition(parameter(), c.now, c.schedule)
  const fading = transition.to(0, 300)
  transition.reset(1)
  assert.equal(await fading, false)
  c.advance(400)
  assert.equal(transition.level, 1)
  const next = transition.to(0, 150)
  transition.finish()
  assert.equal(await next, true)
  assert.equal(transition.level, 0)
  assert.equal(c.jobs.size, 0)
})

class Audio extends EventTarget {
  static last
  constructor() { super(); Audio.last = this }
  paused = true; ended = false; src = ''; currentTime = 0; duration = 180; error = null
  getAttribute() { return this.src || null }
  removeAttribute() { this.src = '' }
  load() {}
  async play() { this.paused = false; this.dispatchEvent(new Event('playing')) }
  pause() { this.paused = true; this.dispatchEvent(new Event('pause')) }
}
class Context {
  static last
  constructor() { Context.last = this }
  currentTime = 0; state = 'running'; destination = {}; gains = []
  createMediaElementSource() { return { connect() {}, disconnect() {} } }
  createBiquadFilter() { return { connect() {}, disconnect() {}, frequency: parameter(), Q: parameter(), gain: parameter() } }
  createGain() { const gain = { connect() {}, disconnect() {}, gain: parameter() }; this.gains.push(gain); return gain }
  createAnalyser() { return { connect() {}, disconnect() {}, frequencyBinCount: 8 } }
  async close() {}
}
function engine() {
  globalThis.Audio = Audio
  globalThis.window = { AudioContext: Context, setInterval: () => 1, clearInterval: () => {} }
  return new WebAudioEngine()
}
test('user volume and mute remain independent of the fade gain', async context => {
  context.mock.timers.enable({ apis: ['setTimeout'] })
  const audio = engine()
  try {
    await audio.load({ url: 'test://a' })
    audio.setVolume(0.4)
    await audio.play(300)
    assert.equal(Context.last.gains.length, 2)
    const [volume, fade] = Context.last.gains
    audio.setVolume(0.7)
    audio.setMuted(true)
    assert.equal(volume.gain.value, 0)
    assert.equal(audio.getVolume(), 0.7)
    Context.last.currentTime = 0.3; context.mock.timers.tick(300)
    assert.equal(fade.gain.value, 1)
    assert.equal(volume.gain.value, 0)
    audio.setMuted(false)
    assert.equal(volume.gain.value, 0.7)
  } finally { audio.destroy() }
})
test('immediate resume cancels a pending pause and stop cancels all fade callbacks', async context => {
  context.mock.timers.enable({ apis: ['setTimeout'] })
  const audio = engine()
  try {
    await audio.load({ url: 'test://a' }); await audio.play()
    const pausing = audio.pause(150)
    await audio.play(150)
    await pausing
    Context.last.currentTime = 0.2; context.mock.timers.tick(200)
    assert.equal(Audio.last.paused, false)
    const pending = audio.pause(150)
    audio.stop()
    await pending
    await audio.load({ url: 'test://b' }); await audio.play()
    Context.last.currentTime = 0.5; context.mock.timers.tick(500)
    assert.equal(Audio.last.paused, false)
    assert.equal(Audio.last.src, 'test://b')
  } finally { audio.destroy() }
})
test('disabling fades finishes the requested pause immediately', async context => {
  context.mock.timers.enable({ apis: ['setTimeout'] })
  const audio = engine()
  try {
    await audio.load({ url: 'test://a' }); await audio.play()
    const pausing = audio.pause(150)
    audio.setTransitionsEnabled(false)
    await pausing
    assert.equal(Audio.last.paused, true)
    await audio.play(300)
    assert.equal(Context.last.gains[1].gain.value, 1)
  } finally { audio.destroy() }
})
