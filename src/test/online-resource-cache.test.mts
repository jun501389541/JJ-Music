import assert from 'node:assert/strict'
import { test } from 'node:test'
import { ResourceCache, resourceKey } from './online/resource-cache.js'
import { OnlineRequestError } from './online/reliability-policy.js'
const key = resourceKey({ platform: 'wy', capability: 'search', identity: 'q:1', adapterRevision: 'wy-1' })
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r }); return { promise, resolve } }
const tick = () => new Promise(r => setImmediate(r))
const policy = { freshMs: 100, maxAgeMs: 500 }
test('fresh forced refresh failures are stale, confirmed absence is only negatively cached for 30s', async () => {
  let now = 1000, calls = 0
  const cache = new ResourceCache({ now: () => now })
  await cache.get(key, async () => ['old'], policy)
  const fallback = await cache.get(key, async () => { throw new Error() }, { ...policy, force: true })
  assert.equal(fallback.cacheState, 'stale'); assert.deepEqual(fallback.data, ['old'])
  const missing = async () => { calls++; throw new OnlineRequestError({ requestId: 'r-1', intentId: 'i-1', platform: 'wy', capability: 'search', stage: 'catalog', code: 'notFound', scope: 'resource' }) }
  assert.equal((await cache.get('missing', missing, policy)).error.code, 'notFound')
  await cache.get('missing', missing, policy); assert.equal(calls, 1)
  now += 30_001; await cache.get('missing', missing, policy); assert.equal(calls, 2)
})
test('last consumer cancellation aborts detached clear/invalidate/force generations', async () => {
  for (const action of ['clear', 'invalidate', 'force']) {
    const cache = new ResourceCache(), c = new AbortController(); let underlying
    const p = cache.get(key, s => { underlying = s; return new Promise(() => {}) }, { ...policy, signal: c.signal })
    await tick()
    if (action === 'clear') cache.clear()
    else if (action === 'invalidate') cache.invalidate(key)
    else await cache.get(key, async () => ['new'], { ...policy, force: true })
    c.abort(); await assert.rejects(p); assert.equal(underlying.aborted, true, action)
  }
})
test('failed refresh preserves last success, legitimate empty differs from first failure', async () => {
  let now = 1000
  const cache = new ResourceCache({ now: () => now })
  const get = loader => cache.get(key, loader, policy)
  assert.equal((await get(async () => ['old'])).cacheState, 'fresh')
  now += 150
  const failed = await get(async () => { throw new SyntaxError('private') })
  assert.deepEqual(failed.data, ['old']); assert.equal(failed.cacheState, 'stale'); assert.equal(failed.error.code, 'schemaChanged')
  const empty = await cache.get('empty', async () => [], policy)
  assert.deepEqual(empty.data, []); assert.equal(empty.cacheState, 'fresh')
  const miss = await cache.get('miss', async () => { throw new Error('private') }, policy)
  assert.equal(miss.cacheState, 'miss'); assert.equal('data' in miss, false)
  now += 600
  assert.equal((await get(async () => { throw new Error() })).data, undefined)
})
test('independent consumers cancel independently; final cancel aborts and blocks late write', async () => {
  const cache = new ResourceCache(); const d = deferred(); let signal; let calls = 0
  const loader = s => { signal = s; calls++; return d.promise }
  const a = new AbortController(), b = new AbortController()
  const pa = cache.get(key, loader, { ...policy, signal: a.signal })
  const pb = cache.get(key, loader, { ...policy, signal: b.signal })
  await tick(); a.abort()
  await assert.rejects(pa); assert.equal(signal.aborted, false); assert.equal(calls, 1)
  d.resolve(['ok']); assert.deepEqual((await pb).data, ['ok'])
  const d2 = deferred(); let last
  const c = new AbortController()
  const pc = cache.get('last', s => { last = s; return d2.promise }, { ...policy, signal: c.signal })
  await tick(); c.abort(); await assert.rejects(pc); assert.equal(last.aborted, true)
  d2.resolve(['late']); await tick()
  assert.deepEqual((await cache.get('last', async () => ['new'], policy)).data, ['new'])
})
test('forced new generation and clear prevent old writers', async () => {
  const cache = new ResourceCache(); const d = deferred()
  const old = cache.get(key, () => d.promise, policy)
  await tick()
  assert.deepEqual((await cache.get(key, async () => ['new'], { ...policy, force: true })).data, ['new'])
  d.resolve(['old']); await old
  assert.deepEqual((await cache.get(key, async () => ['wrong'], policy)).data, ['new'])
  const pending = deferred(); const p = cache.get('clear', () => pending.promise, policy)
  await tick(); cache.clear(); pending.resolve(['late']); await p
  assert.deepEqual((await cache.get('clear', async () => ['after'], policy)).data, ['after'])
})
test('clock rollback, LRU, oversized values and write failure degrade safely', async () => {
  let now = 1000; let writes = 0
  const cache = new ResourceCache({ now: () => now, maxEntries: 2, maxBytes: 1024, maxEntryBytes: 200, write: async () => { writes++; throw new Error('disk') } })
  await cache.get('a', async () => ['a'], { ...policy, persist: true }); await cache.flush()
  assert.equal(writes, 1)
  now = 900
  assert.deepEqual((await cache.get('a', async () => ['rollback'], policy)).data, ['rollback'])
  await cache.get('b', async () => ['b'], policy); await cache.get('c', async () => ['c'], policy)
  assert.deepEqual((await cache.get('a', async () => ['evicted'], policy)).data, ['evicted'])
  const large = await cache.get('large', async () => 'x'.repeat(300), policy)
  assert.equal(large.error.code, 'cacheIO'); assert.equal(large.data, undefined)
})
test('version identity, corrupt persistence, no query persistence, and mutable caller isolation', async () => {
  assert.notEqual(key, resourceKey({ platform: 'wy', capability: 'search', identity: 'q:1', adapterRevision: 'wy-2' }))
  let stored
  const cache = new ResourceCache({ read: async () => ({ schema: 999, entries: ['corrupt'] }), write: async v => { stored = v } })
  await cache.load()
  const value = await cache.get(key, async () => ['query-private'], policy)
  value.data.push('mutated')
  assert.deepEqual((await cache.get(key, async () => [], policy)).data, ['query-private'])
  await cache.get('entity', async () => ['entity'], { ...policy, persist: true }); await cache.flush()
  assert.equal(JSON.stringify(stored).includes('query-private'), false)
  const restored = new ResourceCache({ read: async () => stored }); await restored.load()
  assert.deepEqual((await restored.get('entity', async () => ['wrong'], policy)).data, ['entity'])
})
