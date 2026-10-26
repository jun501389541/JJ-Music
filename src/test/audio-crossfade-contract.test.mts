import assert from 'node:assert/strict'
import { test } from 'node:test'
import { supportsCrossfade } from './shared/audio-engine.js'
import { crossfadeGains, normalizeCrossfadeDurationMs } from './shared/crossfade.js'

function engine(options = {}) {
  return {
    capabilities: {
      id: 'test',
      label: 'Test engine',
      equalizer: false,
      visualizer: false,
      gapless: false,
      timeStretch: false,
      exclusive: false,
      ...(options.crossfade === undefined ? {} : { crossfade: options.crossfade })
    },
    ...(options.prepareTrack ? { prepareTrack: options.prepareTrack } : {}),
    ...(options.crossfadeTo ? { crossfadeTo: options.crossfadeTo } : {}),
    ...(options.discardPreparedTrack ? { discardPreparedTrack: options.discardPreparedTrack } : {})
  }
}

test('engines without crossfade methods remain on the legacy path', () => {
  assert.equal(supportsCrossfade(engine()), false)
  assert.equal(supportsCrossfade(engine({ crossfade: true })), false)
})

test('crossfade capability without all methods is unsupported', () => {
  const prepareTrack = async () => ({ token: 1 })
  const crossfadeTo = () => ({})
  const discardPreparedTrack = () => {}

  assert.equal(supportsCrossfade(engine({ crossfade: true, prepareTrack })), false)
  assert.equal(supportsCrossfade(engine({ crossfade: true, prepareTrack, crossfadeTo })), false)
  assert.equal(
    supportsCrossfade(engine({ crossfade: true, prepareTrack, crossfadeTo, discardPreparedTrack })),
    true
  )
  assert.equal(
    supportsCrossfade(engine({ prepareTrack, crossfadeTo, discardPreparedTrack })),
    false
  )
})

test('duration normalization clamps and quantizes to whole seconds', () => {
  const cases = [
    [-1, 0],
    [0, 0],
    [499, 0],
    [500, 1_000],
    [1_499, 1_000],
    [1_500, 2_000],
    [11_999, 12_000],
    [12_001, 12_000],
    [null, 0],
    ['4000', 0],
    [Number.NaN, 0],
    [Number.POSITIVE_INFINITY, 0]
  ]

  for (const [input, expected] of cases) {
    assert.equal(normalizeCrossfadeDurationMs(input), expected, `input ${String(input)}`)
  }
})

test('equal-power gains start on outgoing only', () => {
  assert.deepEqual(crossfadeGains(0), { outgoing: 1, incoming: 0 })
})

test('equal-power gains end on incoming only', () => {
  const gains = crossfadeGains(1)
  assert.ok(Math.abs(gains.outgoing) < 1e-12)
  assert.equal(gains.incoming, 1)
})

test('equal-power midpoint keeps both gains finite and balanced', () => {
  const gains = crossfadeGains(0.5)
  assert.ok(Math.abs(gains.outgoing - Math.SQRT1_2) < 1e-12)
  assert.ok(Math.abs(gains.incoming - Math.SQRT1_2) < 1e-12)
})

test('gain progress clamps and non-finite values stay finite', () => {
  assert.deepEqual(crossfadeGains(-0.25), { outgoing: 1, incoming: 0 })
  assert.ok(Math.abs(crossfadeGains(1.25).outgoing) < 1e-12)
  assert.equal(crossfadeGains(1.25).incoming, 1)

  for (const progress of [Number.NaN, Number.NEGATIVE_INFINITY, Number.POSITIVE_INFINITY]) {
    const gains = crossfadeGains(progress)
    assert.ok(Number.isFinite(gains.outgoing))
    assert.ok(Number.isFinite(gains.incoming))
  }
})
