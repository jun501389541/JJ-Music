import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFileSync } from 'node:fs'

test('discover shuffle stages random mode with user queue without mutating the outgoing mode', async () => {
  const source = readFileSync(new URL('../../src/renderer/src/views/DiscoverView.vue', import.meta.url), 'utf8')
  const body = source.match(/async function shuffleAll\(\): Promise<void> \{([\s\S]*?)\n\}/)?.[1]
  assert.ok(body)
  let mode = 'repeat'
  const calls = []
  const player = {
    setPlayMode(value) { mode = value },
    async playUserQueue(...args) { calls.push(args) }
  }
  const tracks = [{ id: 'a' }, { id: 'b' }, { id: 'c' }]
  const run = new (Object.getPrototypeOf(async function () {}).constructor)('library', 'player', body)
  await run({ tracks }, player)
  assert.equal(mode, 'repeat', 'old mode remains until player commits incoming audio')
  assert.equal(calls.length, 1)
  assert.deepEqual(calls[0][3], { playMode: 'random' })
  assert.equal(calls[0][0].length, 3)
  assert.notEqual(calls[0][0], tracks)
})
