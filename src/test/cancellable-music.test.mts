import assert from 'node:assert/strict'

const { cancellableMusic } = await import('./renderer/utils/cancellable-music.js')
const cancelled = []
globalThis.window = { jj: { music: { cancel: id => cancelled.push(id) } } }

const controller = new AbortController()
let finish
const pending = cancellableMusic(controller.signal, id => new Promise(resolve => {
  assert.match(id, /^search-\d{13}-\d+$/)
  finish = resolve
}))
controller.abort()
assert.equal(cancelled.length, 1)
assert.match(cancelled[0], /^search-\d{13}-\d+$/)
finish('done')
assert.equal(await pending, 'done')

const alreadyAborted = new AbortController()
alreadyAborted.abort()
await assert.rejects(() => cancellableMusic(alreadyAborted.signal, async () => 'unexpected'), { name: 'AbortError' })
assert.equal(cancelled.length, 1)
console.log('renderer cancellation passes')
