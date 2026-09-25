import assert from 'node:assert/strict'

const { searchOnline, searchAll } = await import('./online/search.js')
const { fetchOnlineLyric } = await import('./online/lyrics.js')
const originalFetch = globalThis.fetch

try {
  for (const run of [
    (signal) => searchOnline('tx', 'test', 1, signal),
    (signal) => searchAll('test', 1, signal),
    (signal) => fetchOnlineLyric({ source: 'tx', meta: { songmid: '1' } }, signal)
  ]) {
    let requests = 0
    let aborted = 0
    globalThis.fetch = (_url, init) => new Promise((_resolve, reject) => {
      requests++
      init.signal.addEventListener('abort', () => {
        aborted++
        reject(new DOMException('Aborted', 'AbortError'))
      }, { once: true })
    })
    const controller = new AbortController()
    const pending = run(controller.signal).catch(() => undefined)
    await new Promise(resolve => setTimeout(resolve, 10))
    assert.ok(requests > 0, 'search must start a network request')
    controller.abort()
    await Promise.race([pending, new Promise((_, reject) => setTimeout(() => reject(new Error('search did not stop')), 500))])
    assert.equal(aborted, requests, 'all in-flight platform requests must be aborted')
  }
  console.log('search cancellation passes')
} finally {
  globalThis.fetch = originalFetch
}
