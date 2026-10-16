import assert from 'node:assert/strict'
import { test } from 'node:test'
import { CapabilityHealth, healthKey } from './online/capability-health.js'
import { onlineContext, OnlineRequestError } from './online/reliability-policy.js'
const context = (capability = 'search', extra = {}) => ({ ...onlineContext('wy', capability, 'wy-1'), ...extra })
const fail = (ctx, code = 'timeout', extra = {}) => { throw new OnlineRequestError({ ...ctx, code, ...extra }) }
const rejected = async (health, ctx, code = 'timeout', extra = {}) => assert.rejects(health.run(ctx, async () => fail(ctx, code, extra)))
test('only consecutive service failures in the window cool the exact versioned capability', async () => {
  let now = 0; const health = new CapabilityHealth({ now: () => now }), ctx = context()
  for (const code of ['notFound','qualityUnavailable','cancelled','cacheIO','forbidden','unknown','unsupported']) await rejected(health, ctx, code)
  assert.equal(health.state(ctx).failures, 0)
  await rejected(health, ctx); await rejected(health, ctx); now += 300_001; await rejected(health, ctx)
  assert.equal(health.state(ctx).failures, 1)
  await health.run(ctx, async () => 'actual success'); await rejected(health, ctx)
  assert.equal(health.state(ctx).failures, 1)
  await rejected(health, ctx); await rejected(health, ctx)
  assert.equal(health.state(ctx).status, 'cooling'); assert.equal(health.state(ctx).retryAfterMs, 60_000)
  let calls = 0; await assert.rejects(health.run(ctx, async () => calls++), e => e.failure.code === 'cooling'); assert.equal(calls, 0)
  for (const other of [context('lyrics'), context('search', {adapterRevision:'wy-2'}), context('search', {providerId:'a',providerVersion:'v1'})]) assert.equal(await health.run(other, async () => 'ok'), 'ok')
  assert.notEqual(healthKey(ctx), healthKey(context('search',{providerId:'a',providerVersion:'v1'})))
})
test('one demand-driven half-open probe owns recovery, cancellation releases it without proving success', async () => {
  let now = 0; const health = new CapabilityHealth({ now: () => now }), ctx = context('musicUrl', {providerId:'a',providerVersion:'v1'})
  for (let i = 0; i < 3; i++) await rejected(health, ctx)
  now += 60_000
  let release; const c = new AbortController()
  const pending = health.run(ctx, () => new Promise(r => { release = r }), {signal:c.signal})
  while (!release) await new Promise(r=>setImmediate(r))
  assert.equal(health.state(ctx).status, 'halfOpen')
  await assert.rejects(health.run(ctx, async () => 'duplicate'), e=>e.failure.code==='cooling')
  c.abort(); await assert.rejects(pending); release('late success')
  assert.notEqual(health.state(ctx).status, 'healthy')
  await rejected(health, ctx); assert.equal(health.state(ctx).retryAfterMs, 120_000)
  now += 120_000; await rejected(health, ctx); assert.equal(health.state(ctx).retryAfterMs, 300_000)
  now += 300_000; await health.run(ctx, async () => 'real success')
  assert.equal(health.state(ctx).status, 'healthy'); assert.equal(health.state(ctx).failures, 0)
})
test('manual bypass is bounded and never bypasses rate limiting or an active probe', async () => {
  let now = 0; const health = new CapabilityHealth({now:()=>now}), ctx=context()
  for(let i=0;i<3;i++)await rejected(health,ctx)
  await assert.rejects(health.run(ctx,async()=>fail(ctx),{manual:true}))
  await assert.rejects(health.run(ctx,async()=> 'too soon',{manual:true}), e=>e.failure.code==='cooling')
  now+=30_000; await assert.rejects(health.run(ctx,async()=>fail(ctx,'rateLimited',{retryAfterMs:90_000}),{manual:true}))
  now+=30_000; await assert.rejects(health.run(ctx,async()=> 'bypass429',{manual:true}), e=>e.failure.code==='rateLimited'&&e.failure.retryAfterMs===60_000)
  now+=60_000; await health.run(ctx,async()=> 'success'); assert.equal(health.state(ctx).status,'healthy')
})
test('old successes cannot clear newer cooling or reinsert cleared state; opt-out and bounded keys', async () => {
  let enabled=true,release; const ctx=context(),health=new CapabilityHealth({maxEntries:4,enabled:()=>enabled})
  const old=health.run(ctx,()=>new Promise(r=>release=r));while(!release)await new Promise(r=>setImmediate(r))
  for(let i=0;i<3;i++)await rejected(health,ctx)
  release('old');await old;assert.equal(health.state(ctx).status,'cooling')
  health.clear();assert.equal(health.state(ctx).status,'healthy')
  enabled=false;for(let i=0;i<4;i++)await rejected(health,ctx);assert.equal(health.state(ctx).failures,0)
  enabled=true;for(let i=0;i<20;i++)await health.run(context('cap'+i),async()=>1)
  assert.ok(health.size<=4)
})
test('another healthy response cannot falsely block a still-valid concurrent attempt',async()=>{
  const health=new CapabilityHealth(),ctx=context();let release
  const pending=health.run(ctx,async(_observe,beforeAttempt)=>{
    await new Promise(resolve=>release=resolve);beforeAttempt();return 'still valid'
  })
  await health.run(ctx,async()=> 'other success');release()
  assert.equal(await pending,'still valid')
})
