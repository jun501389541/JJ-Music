import assert from 'node:assert/strict'
import { test } from 'node:test'
import { reactive } from 'vue'
import { createSettingsWriter } from './renderer/utils/settings-writer.js'

const tick = () => new Promise(resolve => setImmediate(resolve))
function deferred() { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }

test('reactive settings patches cross IPC as detached, cloneable snapshots', async () => {
  let state = { volume: .8, libraryFolders: [] }, received
  const write = createSettingsWriter(() => state, value => { state = value }, async patch => {
    received = structuredClone(patch)
    return { ...state, ...received }
  })
  const patch = reactive({ libraryFolders: ['D:/Music'] })
  const pending = write(patch)
  patch.libraryFolders.push('D:/Later')
  await pending
  assert.deepEqual(received.libraryFolders, ['D:/Music'])
})

test('a burst coalesces to two writes and stale acknowledgements never roll back newer input', async () => {
  let state = { volume: .8, theme: 'dark' }, disk = { ...state }
  const gate = deferred(), snapshots = []
  const write = createSettingsWriter(() => state, value => { state = value }, async patch => {
    snapshots.push(patch)
    if (snapshots.length === 1) await gate.promise
    disk = { ...disk, ...patch }
    return { ...disk }
  })
  const requests = [write({ volume: .1 })]
  await tick()
  for (let i = 0; i < 100; i++) requests.push(write({ volume: i / 100 }))
  requests.push(write({ theme: 'light' }))
  assert.equal(state.volume, .99)
  gate.resolve()
  await Promise.all(requests)
  assert.equal(snapshots.length, 2)
  assert.deepEqual(state, { volume: .99, theme: 'light' })
  assert.deepEqual(disk, state)
})

test('a rejected write rolls back its optimistic value and later saves recover', async () => {
  let state = { volume: .8 }, fail = true
  const write = createSettingsWriter(() => state, value => { state = value }, async patch => {
    if (fail) throw Error('disk unavailable')
    return { ...state, ...patch }
  })
  await assert.rejects(write({ volume: .2 }), /disk unavailable/)
  assert.equal(state.volume, .8)
  fail = false
  await write({ volume: .5 })
  assert.equal(state.volume, .5)
})
