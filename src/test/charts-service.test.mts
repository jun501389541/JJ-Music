import assert from 'node:assert/strict'
import { test } from 'node:test'
import { ChartsService } from './online/charts-service.js'
import { ResourceCache } from './online/resource-cache.js'
const row = { source: 'wy', id: '1', name: 'Fixture chart' }
const page = { source: 'wy', id: '1', page: 1, period: 'v1', total: 20, tracks: [], hasMore: false, truncated: false, partial: true }
test('cache hits, forced failures, isolation and clear use the common reliability envelope', async () => {
  let calls = 0, fail = false
  const service = new ChartsService({ adapter: { list: async source => { calls++; if (fail) throw Error('offline'); return [{ ...row, source }] }, tracks: async () => page } })
  assert.equal((await service.list('wy')).data[0].source, 'wy')
  await service.list('wy'); assert.equal(calls, 1)
  await service.list('tx'); assert.equal(calls, 2)
  fail = true
  const stale = await service.list('wy', undefined, true)
  assert.equal(stale.cacheState, 'stale'); assert.equal(stale.data[0].name, row.name)
  assert.ok(stale.error)
  service.clear(); fail = false
  await service.list('wy'); assert.equal(calls, 4)
})
test('changed periods never cache new snapshot under old identity or mix tracks', async () => {
  let calls = 0
  const service = new ChartsService({ adapter: { list: async () => [row], tracks: async () => { calls++; return { ...page, period: 'v2' } } } })
  const result = await service.tracks('wy', '1', 1, 'v1')
  assert.equal(result.data.periodChanged, true); assert.deepEqual(result.data.tracks, [])
  await service.tracks('wy', '1', 1, 'v1'); assert.equal(calls, 2)
})
test('shared cancellations detach consumers independently', async () => {
  let release, upstream
  const pending = new Promise(resolve => { release = resolve })
  const service = new ChartsService({ adapter: { list: async (_source, signal) => { upstream = signal; return pending }, tracks: async () => page } })
  const a = new AbortController(), b = new AbortController()
  const first = service.list('wy', a.signal).catch(error => error)
  const second = service.list('wy', b.signal)
  await new Promise(resolve => setImmediate(resolve)); a.abort()
  await first; assert.equal(upstream.aborted, false)
  release([row]); assert.equal((await second).data.length, 1)
})
test('malformed and cross-platform adapter results cannot replace last good data', async () => {
  let bad = false
  const service = new ChartsService({ adapter: { list: async () => bad ? [{ ...row, source: 'tx' }] : [row], tracks: async () => page } })
  await service.list('wy'); bad = true
  const result = await service.list('wy', undefined, true)
  assert.equal(result.cacheState, 'stale'); assert.equal(result.data[0].source, 'wy')
  assert.equal(result.error.code, 'schemaChanged')
})

test('forced refresh respects Retry-After and never starts a second upstream request', async () => {
  const { OnlineRequestError } = await import('./online/reliability-policy.js')
  let calls = 0
  const service = new ChartsService({ adapter: { list: async () => {
    calls++; throw new OnlineRequestError({ platform: 'wy', capability: 'chartList', code: 'rateLimited', retryAfterMs: 60000, httpStatus: 429 })
  }, tracks: async () => page } })
  await service.list('wy').catch(() => {})
  const firstCalls = calls
  await service.list('wy', undefined, true).catch(() => {})
  assert.equal(firstCalls, 1)
  assert.equal(calls, 1)
})

test('last cancelled consumer aborts upstream and does not populate the cache', async () => {
  let upstream, calls = 0
  const service = new ChartsService({ adapter: { list: async (_source, signal) => {
    calls++; upstream = signal
    return new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }))
  }, tracks: async () => page } })
  const controller = new AbortController()
  const result = service.list('wy', controller.signal).catch(error => error)
  await new Promise(resolve => setImmediate(resolve)); controller.abort()
  await result
  assert.equal(upstream.aborted, true)
  assert.equal(calls, 1)
})

test('persisted lists survive service reconstruction without another adapter request', async () => {
  const { mkdtemp, rm } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const dataDir = await mkdtemp(join(tmpdir(), 'jj-charts-'))
  try {
    let calls = 0
    const adapter = { list: async () => { calls++; return [row] }, tracks: async () => page }
    const first = new ChartsService({ dataDir, adapter })
    await first.list('wy'); await first.flush()
    const restored = new ChartsService({ dataDir, adapter }); await restored.load()
    assert.equal((await restored.list('wy')).data[0].name, row.name)
    assert.equal(calls, 1)
  } finally { await rm(dataDir, { recursive: true, force: true }) }
})

test('new platform lists persist independently and do not restore another platform identity', async () => {
  const { mkdtemp, rm } = await import('node:fs/promises'), { tmpdir } = await import('node:os'), { join } = await import('node:path')
  const dataDir = await mkdtemp(join(tmpdir(), 'jj-charts-more-'))
  try {
    let calls=0
    const adapter={list:async source=>{calls++;return [{source,id:'16',name:'New chart'}]},tracks:async()=>page}
    const first=new ChartsService({dataDir,adapter});await first.list('kg');await first.list('kw');await first.flush()
    const restored=new ChartsService({dataDir,adapter});await restored.load()
    assert.equal((await restored.list('kg')).data[0].source,'kg');assert.equal((await restored.list('kw')).data[0].source,'kw');assert.equal(calls,2)
  } finally { await rm(dataDir,{recursive:true,force:true}) }
})

test('a new-platform track cannot smuggle another platform identity through the cache', async () => {
  const service=new ChartsService({adapter:{list:async()=>[],tracks:async()=>({...page,source:'kw',partial:false,tracks:[{source:'kw',id:'wy_1',name:'Wrong identity',singer:'',meta:{songmid:'1'}}]})}})
  const result=await service.tracks('kw','1',1)
  assert.equal(result.data,undefined);assert.equal(result.error.code,'schemaChanged')
})

test('Kugou hash/audio id and Kuwo rid survive track-cache reconstruction', async () => {
  const { mkdtemp, rm } = await import('node:fs/promises'), { tmpdir } = await import('node:os'), { join } = await import('node:path')
  const dataDir=await mkdtemp(join(tmpdir(),'jj-charts-track-'))
  try {
    let calls=0
    const hash='ABCDEF0123456789ABCDEF0123456789'
    const adapter={list:async()=>[],tracks:async source=>{calls++;return {...page,source,partial:false,total:1,tracks:[source==='kg'?{source,id:`kg_${hash}`,name:'KG',singer:'Artist',meta:{hash,songmid:'1108466835',qualitys:[{type:'128k',hash}]}}:{source,id:'kw_624683929',name:'KW',singer:'Artist',meta:{songmid:'624683929'}}]}}}
    const first=new ChartsService({dataDir,adapter})
    await first.tracks('kg','1',1);await first.tracks('kw','1',1);await first.flush()
    const restored=new ChartsService({dataDir,adapter});await restored.load()
    const kg=(await restored.tracks('kg','1',1)).data.tracks[0],kw=(await restored.tracks('kw','1',1)).data.tracks[0]
    assert.equal(calls,2);assert.equal(kg.id,`kg_${hash}`);assert.equal(kg.meta.hash,hash);assert.equal(kg.meta.songmid,'1108466835');assert.equal(kw.id,'kw_624683929');assert.equal(kw.meta.songmid,'624683929')
  } finally { await rm(dataDir,{recursive:true,force:true}) }
})

test('Migu production snapshots persist songId and copyrightId across service reconstruction', async () => {
  const { ChartAdapter }=await import('./online/platform-charts.js')
  const { mkdtemp,rm }=await import('node:fs/promises'),{tmpdir}=await import('node:os'),{join}=await import('node:path')
  const dataDir=await mkdtemp(join(tmpdir(),'jj-charts-mg-'))
  try {
    let calls=0
    const rows=Array.from({length:30},(_,i)=>({songId:String(100+i),copyrightId:String(60000000000+i),songData:JSON.stringify({songId:String(100+i),copyrightId:String(60000000000+i),songName:'MG',singerList:[{name:'Artist'}]})}))
    const adapter=new ChartAdapter(async()=>{calls++;return new Response(JSON.stringify({code:'000000',data:{columnId:'1',contents:rows,hasNextPage:false,totalCount:30}}))})
    const service=new ChartsService({dataDir,adapter}),first=await service.tracks('mg','1',1)
    assert.equal(first.data.tracks[0].meta.copyrightId,'60000000000')
    await service.tracks('mg','1',2,first.data.period);await service.flush()
    const restored=new ChartsService({dataDir,adapter});await restored.load()
    const page=await restored.tracks('mg','1',2,first.data.period)
    assert.equal(calls,2);assert.equal(page.data.tracks[0].id,'mg_120');assert.equal(page.data.tracks[0].meta.songmid,'120');assert.equal(page.data.tracks[0].meta.copyrightId,'60000000020')
  } finally { await rm(dataDir,{recursive:true,force:true}) }
})
