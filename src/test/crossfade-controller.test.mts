import assert from 'node:assert/strict'
import { test } from 'node:test'
import { CrossfadeController } from './renderer/audio/crossfade-controller.js'

class FakeGainParameter {
  value = 0
  values = []
  curves = []

  cancelScheduledValues(time) {
    this.values.push({ kind: 'cancel', time })
  }

  setValueAtTime(value, time) {
    this.value = value
    this.values.push({ kind: 'value', value, time })
  }

  setValueCurveAtTime(values, startTime, duration) {
    this.curves.push({ values: Array.from(values), startTime, duration })
  }

  get lastSetValue() {
    return this.values.filter((entry) => entry.kind === 'value').at(-1)?.value
  }
}

function fixture(startSeconds = 0) {
  const clock = { milliseconds: startSeconds * 1_000 }
  const timers = []
  const outgoing = new FakeGainParameter()
  const incoming = new FakeGainParameter()
  const schedule = (callback, delayMs) => {
    const timer = {
      callback,
      delayMs,
      dueAt: clock.milliseconds + delayMs,
      cancelled: false,
      fired: false
    }
    timers.push(timer)
    return () => { timer.cancelled = true }
  }
  const controller = new CrossfadeController({
    outgoing,
    incoming,
    now: () => clock.milliseconds / 1_000,
    schedule
  })

  return {
    controller,
    outgoing,
    incoming,
    timers,
    advance(milliseconds) {
      clock.milliseconds += milliseconds
      for (const timer of timers) {
        if (!timer.cancelled && !timer.fired && timer.dueAt <= clock.milliseconds) {
          timer.fired = true
          timer.callback()
        }
      }
    }
  }
}

function closeTo(actual, expected) {
  assert.ok(Math.abs(actual - expected) < 1e-5, `${actual} should be close to ${expected}`)
}

test('controller schedules both decks from the injected audio clock', () => {
  const { controller, outgoing, incoming, timers } = fixture(12.5)
  controller.start(4_000)

  assert.equal(outgoing.curves[0].startTime, 12.5)
  assert.equal(incoming.curves[0].startTime, 12.5)
  assert.equal(outgoing.curves[0].duration, 4)
  assert.equal(incoming.curves[0].duration, 4)
  assert.equal(outgoing.curves[0].values[0], 1)
  assert.equal(outgoing.curves[0].values.at(-1), 0)
  assert.equal(incoming.curves[0].values[0], 0)
  assert.equal(incoming.curves[0].values.at(-1), 1)
  assert.equal(timers[0].delayMs, 4_000)
})

test('pause and resume preserve remaining envelope time', () => {
  const { controller, outgoing, incoming, timers, advance } = fixture(5)
  let completions = 0
  controller.start(4_000, () => { completions += 1 })
  advance(1_000)
  controller.pause()

  closeTo(outgoing.lastSetValue, Math.cos(Math.PI / 8))
  closeTo(incoming.lastSetValue, Math.sin(Math.PI / 8))
  assert.equal(timers[0].cancelled, true)

  controller.resume()
  assert.equal(outgoing.curves.at(-1).startTime, 6)
  assert.equal(incoming.curves.at(-1).startTime, 6)
  assert.equal(outgoing.curves.at(-1).duration, 3)
  assert.equal(incoming.curves.at(-1).duration, 3)
  assert.equal(timers.at(-1).delayMs, 3_000)

  advance(2_999)
  assert.equal(completions, 0)
  advance(1)
  assert.equal(completions, 1)
})

test('retiming shortens the remaining envelope without changing its current gain point', () => {
  const { controller, outgoing, incoming, timers, advance } = fixture()
  controller.start(4_000)
  advance(1_000)

  controller.retimeRemaining(1_000)

  const outgoingCurve = outgoing.curves.at(-1)
  const incomingCurve = incoming.curves.at(-1)
  assert.equal(outgoingCurve.duration, 1)
  assert.equal(incomingCurve.duration, 1)
  closeTo(outgoingCurve.values[0], Math.cos(Math.PI / 8))
  closeTo(incomingCurve.values[0], Math.sin(Math.PI / 8))
  assert.equal(timers[0].cancelled, true)
  advance(999)
  assert.equal(outgoing.lastSetValue, undefined)
  advance(1)
  assert.equal(outgoing.lastSetValue, 0)
  assert.equal(incoming.lastSetValue, 1)
})

test('retiming a paused envelope changes its resume duration without advancing it', () => {
  const { controller, outgoing, incoming, timers, advance } = fixture()
  controller.start(4_000)
  advance(1_000)
  controller.pause()

  controller.retimeRemaining(500)
  assert.equal(timers[0].cancelled, true)

  controller.resume()
  assert.equal(outgoing.curves.at(-1).duration, 0.5)
  assert.equal(incoming.curves.at(-1).duration, 0.5)
  assert.equal(timers.at(-1).delayMs, 500)
})

test('finish promotes incoming and releases once', () => {
  const { controller, outgoing, incoming } = fixture()
  let completions = 0
  controller.start(4_000, () => { completions += 1 })

  controller.finish()
  controller.finish()

  assert.equal(outgoing.lastSetValue, 0)
  assert.equal(incoming.lastSetValue, 1)
  assert.equal(completions, 1)
})

test('cancel restores outgoing gain', () => {
  const { controller, outgoing, incoming, advance } = fixture()
  let completions = 0
  controller.start(4_000, () => { completions += 1 })
  advance(1_000)
  controller.cancel()

  assert.equal(outgoing.lastSetValue, 1)
  assert.equal(incoming.lastSetValue, 0)
  assert.equal(completions, 0)
})

test('cancelled callbacks cannot finish a newer transition', () => {
  const { controller, timers, advance } = fixture()
  let completions = 0
  controller.start(1_000, () => { completions += 1 })
  const staleTimer = timers[0]
  controller.cancel()
  controller.start(2_000, () => { completions += 1 })

  staleTimer.callback()
  assert.equal(completions, 0)
  advance(1_999)
  assert.equal(completions, 0)
  advance(1)
  assert.equal(completions, 1)
})
