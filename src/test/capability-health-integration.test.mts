import assert from 'node:assert/strict'
import { test } from 'node:test'
import { CapabilityHealth } from './online/capability-health.js'
import { CatalogReliability } from './online/catalog-reliability.js'
import { SourceEngine } from './sources/source-engine.js'
import { onlineContext, OnlineRequestError } from './online/reliability-policy.js'
test('catalog cache reads do not count as recovery and cooling only blocks the failed capability', async () => {
  let now=0,calls=0; const health=new CapabilityHealth({now:()=>now}), catalog=new CatalogReliability({health})
  const good=async()=>({list:[{id:'wy_1',source:'wy',name:'One',singer:''}],total:1})
  await catalog.search('wy','one',1,good)
  const broken=async()=>{calls++;throw new SyntaxError('private raw')}
  for(let i=0;i<3;i++)assert.equal((await catalog.search('wy','one',1,broken,undefined,true)).cacheState,'stale')
  assert.equal(calls,3)
  assert.equal((await catalog.search('wy','one',1,broken)).cacheState,'fresh')
  assert.equal(health.state(onlineContext('wy','search','wy-1')).status,'cooling')
  const denied=await catalog.search('wy','other',1,broken)
  assert.equal(denied.error.code,'cooling');assert.equal(calls,3)
  const album=await catalog.entity('wy','albumDetail','1',1,async()=>({status:'available',entity:{id:'1'},tracks:[],total:0,page:1,hasMore:false}))
  assert.equal(album.data.status,'available')
})
function engine(health, answer){
  const api={meta:{id:'a',stableId:'stable-a',name:'Fixture',enabled:true},source:''}
  const store={versionOf:()=> 'v1',get:id=>id==='a'?api:undefined}
  const source=new SourceEngine(store,'unused','ipc',{health})
  source.runtimes.set('a',{api,host:{dead:false},sources:[{id:'wy',actions:['musicUrl','lyric'],qualitys:['128k']}]})
  source.sourceProviders.set('wy',['a'])
  source.getHost=()=>({request:answer})
  return source
}
test('source failures are scoped by stable provider/version/action and bound tracks cannot escape cooling',async()=>{
  let calls=0, mode='fail'; const health=new CapabilityHealth(),source=engine(health,async(_host,payload)=>{
    calls++;if(payload.action==='lyric')return {lyric:'[00:01]ok'}
    if(mode==='fail')throw Object.assign(new Error('host timeout'),{code:'ETIMEDOUT'})
    return 'https://cdn.test/a.mp3'
  }),track={id:'wy_1',source:'wy',name:'One',singer:'',providerId:'stable-a',meta:{songmid:'1'}}
  for(let i=0;i<3;i++)await assert.rejects(source.getMusicUrl('wy',track,'128k',true))
  mode='good';await assert.rejects(source.getMusicUrl('wy',track,'128k',true),/冷却/);assert.equal(calls,3)
  assert.equal((await source.getLyric('wy',track)).lyric,'[00:01]ok');assert.equal(calls,4)
})
test('an invalid source URL counts as schema failure but ordinary unknown script errors do not cool',async()=>{
  const health=new CapabilityHealth();let calls=0;const source=engine(health,async()=>{calls++;return 'not a URL'})
  const track={id:'wy_1',source:'wy',name:'One',singer:'',meta:{songmid:'1'}}
  for(let i=0;i<4;i++)await assert.rejects(source.getMusicUrl('wy',track,'128k',true))
  assert.equal(calls,3)
  const otherHealth=new CapabilityHealth();let unknown=0;const other=engine(otherHealth,async()=>{unknown++;throw Error('HTTP 404')})
  for(let i=0;i<4;i++)await assert.rejects(other.getMusicUrl('wy',track,'128k',true))
  assert.equal(unknown,4)
})
test('429 wait is published while the retry owner is waiting, before its final result',async()=>{
  const health=new CapabilityHealth(),catalog=new CatalogReliability({health}),ctx=onlineContext('wy','search','wy-1'),c=new AbortController()
  let firstCall
  const started=new Promise(resolve=>firstCall=resolve)
  const first=catalog.search('wy','first',1,async()=>{firstCall();throw new OnlineRequestError({...ctx,code:'rateLimited',retryAfterMs:5000})},c.signal).catch(()=>undefined)
  await started;await new Promise(r=>setImmediate(r))
  let secondCalls=0
  try{
    const second=await catalog.search('wy','second',1,async()=>{secondCalls++;return {list:[]}})
    assert.equal(second.error?.code,'rateLimited');assert.equal(secondCalls,0)
  }finally{c.abort();await first}
})
test('empty per-track URL is quality absence and cannot cool the whole source capability',async()=>{
  const health=new CapabilityHealth();let calls=0;const source=engine(health,async()=>{calls++;return ''})
  const track={id:'wy_1',source:'wy',name:'One',singer:'',meta:{songmid:'1'}}
  for(let i=0;i<4;i++)await assert.rejects(source.getMusicUrl('wy',track,'128k',true))
  assert.equal(calls,4)
  source.runtimes.get('a').sources[0].qualitys=['flac24bit','flac','320k','128k']
  source.getHost=()=>({request:async(_host,payload)=>{calls++;return payload.info.type==='128k'?'https://cdn.test/low.mp3':''}})
  assert.equal((await source.getMusicUrl('wy',track,'flac24bit')).quality,'128k')
  assert.equal(calls,8,'three unavailable tiers must not prevent the fourth valid tier')
})
test('an already admitted retry cannot ignore a later longer 429 wait from another request',async()=>{
  const health=new CapabilityHealth(),catalog=new CatalogReliability({health}),ctx=onlineContext('wy','search','wy-1'),c=new AbortController()
  const releases=[],calls=[0,0]
  const tasks=[0,1].map(i=>catalog.search('wy',`concurrent${i}`,1,async()=>{
    calls[i]++
    if(calls[i]===1)return new Promise((_,reject)=>releases[i]=()=>reject(new OnlineRequestError({...ctx,code:'rateLimited',retryAfterMs:i===0?50:5000})))
    return {list:[]}
  },c.signal).catch(()=>undefined))
  while(releases.filter(Boolean).length!==2)await new Promise(r=>setImmediate(r))
  releases[0]();releases[1]()
  try{await new Promise(r=>setTimeout(r,120));assert.deepEqual(calls,[1,1])}
  finally{c.abort();await Promise.all(tasks)}
})
