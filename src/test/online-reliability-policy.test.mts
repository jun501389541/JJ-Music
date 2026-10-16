import assert from 'node:assert/strict'
import { test } from 'node:test'
import { normalizeOnlineError, runOnlineRequest, OnlineRequestError } from './online/reliability-policy.js'

const context = { platform: 'wy', capability: 'search', stage: 'catalog', requestId: 'r-1', intentId: 'i-1', adapterRevision: 'wy-1' }
test('classification is evidence based and messages never echo raw input', () => {
  for (const status of [403, 404, 429]) {
    const e = normalizeOnlineError(Object.assign(new Error('token=secret song C:/private'), { httpStatus: status }), context)
    assert.equal(e.code, 'unknown')
    assert.equal(JSON.stringify(e).includes('secret'), false)
  }
  assert.equal(normalizeOnlineError(new SyntaxError('private JSON'), context).code, 'schemaChanged')
  assert.equal(normalizeOnlineError(Object.assign(new Error(), { code: 'ECONNRESET' }), context).code, 'network')
  assert.equal(normalizeOnlineError(new DOMException('private', 'AbortError'), context).code, 'cancelled')
})
test('one owner retries network once, other owners and schema never retry', async () => {
  let calls = 0
  const value = await runOnlineRequest(async () => {
    if (++calls === 1) throw Object.assign(new Error(), { code: 'ECONNRESET' })
    return 42
  }, context, { wait: async () => {}, random: () => 0 })
  assert.equal(value, 42); assert.equal(calls, 2)
  for (const options of [{ retryOwner: 'source' }, {}]) {
    calls = 0
    await assert.rejects(runOnlineRequest(async () => { calls++; throw new SyntaxError() }, context, options))
    assert.equal(calls, 1)
  }
})
test('429 beyond budget and cancellation do not start another attempt', async () => {
  let calls = 0
  await assert.rejects(runOnlineRequest(async () => {
    calls++
    throw new OnlineRequestError({ ...context, code: 'rateLimited', scope: 'capability', retryAfterMs: 60_000 })
  }, context, { budgetMs: 12_000 }), e => e.failure.code === 'rateLimited')
  assert.equal(calls, 1)
  const c = new AbortController(); c.abort()
  await assert.rejects(runOnlineRequest(async () => { calls++; return 1 }, context, { signal: c.signal }))
  assert.equal(calls, 1)
})
test('deadline bounds an adapter that ignores its signal', async () => {
  await assert.rejects(runOnlineRequest(() => new Promise(() => {}), context, { budgetMs: 10, attemptMs: 10, retryOwner: 'none' }), e => e.failure.code === 'timeout')
})
