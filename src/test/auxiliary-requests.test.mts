import assert from 'node:assert/strict'
import test from 'node:test'
import { AuxiliaryRequests } from './online/auxiliary-requests.js'
import { CapabilityHealth } from './online/capability-health.js'
import { OnlineDiagnostics } from './online/online-diagnostics.js'
import { OnlineRequestError, onlineContext } from './online/reliability-policy.js'
import { resolveArtistImage } from './online/artist-image.js'
import { fetchNeteaseDetails } from './online/search.js'

test('artist adapter reports malformed upstream responses before fallback and respects cooling', async () => {
  const health = new CapabilityHealth(), diagnostics = new OnlineDiagnostics()
  const auxiliary = new AuxiliaryRequests({health,diagnostics,revision:()=> 'wy-1'})
  let attempts = 0
  const http = async () => { attempts++; return new Response('not json') }
  for(let i=0;i<4;i++) await assert.rejects(resolveArtistImage('fixture artist',http,['wy'],auxiliary))
  assert.equal(attempts,3)
  assert.ok(diagnostics.export().events.some(e=>e.capability==='artistImage'&&e.code==='schemaChanged'))
})

test('best-effort detail enrichment records failures while leaving its base result available', async () => {
  const health = new CapabilityHealth(), diagnostics = new OnlineDiagnostics()
  const auxiliary = new AuxiliaryRequests({health,diagnostics,revision:()=> 'wy-1'})
  const previous = globalThis.fetch
  let attempts = 0
  globalThis.fetch = async () => { attempts++; return new Response('not json') }
  try {
    for(let i=0;i<4;i++) assert.equal((await fetchNeteaseDetails([1],undefined,auxiliary)).size,0)
    assert.equal(attempts,3)
    assert.ok(diagnostics.export().events.some(e=>e.capability==='trackDetail'&&e.code==='schemaChanged'))
  } finally { globalThis.fetch=previous }
})

test('auxiliary failures cool only their capability, without retries or leaking payloads', async () => {
  const health = new CapabilityHealth(), diagnostics = new OnlineDiagnostics()
  const requests = new AuxiliaryRequests({ health, diagnostics, revision: () => 'wy-1' })
  let attempts = 0
  for (let i = 0; i < 3; i++) await assert.rejects(requests.run('wy', 'artistImage', async () => {
    attempts++; throw Object.assign(new Error('https://private:token@host/private'), { code: 'ECONNRESET' })
  }))
  await assert.rejects(requests.run('wy', 'artistImage', async () => { attempts++; return 1 }), /冷却/)
  assert.equal(attempts, 3)
  assert.equal(diagnostics.export().events.at(-1).attempt, 0)
  assert.equal(await requests.run('wy', 'trackDetail', async () => 42), 42)
  assert.equal(health.state(onlineContext('wy', 'trackDetail', 'wy-1')).failures, 0)
  const events = diagnostics.export().events
  assert.ok(events.some(event => event.capability === 'artistImage' && event.code === 'network'))
  assert.equal(JSON.stringify(events).includes('private'), false)
  assert.equal(JSON.stringify(events).includes('token'), false)
})

test('auxiliary cancellation does not count as failure and opt-out keeps the base operation', async () => {
  const health = new CapabilityHealth({ enabled: () => false }), diagnostics = new OnlineDiagnostics()
  const requests = new AuxiliaryRequests({ health, diagnostics, revision: () => 'wy-1' })
  const signal = AbortSignal.abort()
  await assert.rejects(requests.run('wy', 'downloadCover', async () => 1, { signal }))
  assert.equal(health.state(onlineContext('wy', 'downloadCover', 'wy-1')).failures, 0)
  assert.equal(await requests.run('wy', 'downloadCover', async () => 2), 2)
})

test('auxiliary HTTP rate wait uses shared health without adding a retry owner', async () => {
  const health = new CapabilityHealth(), diagnostics = new OnlineDiagnostics()
  const requests = new AuxiliaryRequests({ health, diagnostics, revision: () => 'wy-1' })
  await assert.rejects(requests.run('wy', 'trackDetail', async () => {
    throw new OnlineRequestError({ ...onlineContext('wy', 'trackDetail'), code: 'rateLimited', retryAfterMs: 60000 })
  }))
  await assert.rejects(requests.run('wy', 'trackDetail', async () => 1), /频繁/)
  assert.equal(await requests.run('tx', 'trackDetail', async () => 2), 2)
})

test('upstream timeout counts toward cooling while user cancellation does not', async () => {
  const health = new CapabilityHealth(), diagnostics = new OnlineDiagnostics()
  const requests = new AuxiliaryRequests({health,diagnostics,revision:()=> 'wy-1'})
  const context=onlineContext('wy','downloadCover','wy-1')
  for(let i=0;i<3;i++) {
    const controller=new AbortController()
    await assert.rejects(requests.run('wy','downloadCover',async()=>{
      controller.abort(new DOMException('controlled timeout','TimeoutError'))
      throw controller.signal.reason
    },{signal:controller.signal}))
  }
  assert.equal(health.state(context).status,'cooling')
  const cancelled=new AbortController()
  await assert.rejects(requests.run('tx','downloadCover',async()=>{
    cancelled.abort(); throw cancelled.signal.reason
  },{signal:cancelled.signal}))
  assert.equal(health.state(onlineContext('tx','downloadCover','wy-1')).failures,0)
})
