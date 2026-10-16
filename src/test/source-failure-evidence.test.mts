import assert from 'node:assert/strict'
import { test } from 'node:test'
import { SourceEngine } from './sources/source-engine.js'
import { OnlineRequestError, normalizeOnlineError, onlineContext } from './online/reliability-policy.js'
import { runDiagnosticChecks } from './online/diagnostic-check.js'
const track={id:'wy_1',source:'wy',name:'Fixture',singer:'Fixture',meta:{songmid:'1'}}
const context=action=>onlineContext('wy',action)
function engine(answers){
  const source=new SourceEngine({versionOf:id=>id+'-version'},'unused','ipc')
  for(const id of Object.keys(answers))source.runtimes.set(id,{api:{meta:{id,stableId:'stable-'+id,name:'Fixture '+id}},host:{dead:false,id},sources:[{id:'wy',actions:['musicUrl','lyric'],qualitys:['128k']}]})
  source.sourceProviders.set('wy',Object.keys(answers))
  source.getHost=()=>({request:async(host,payload)=>answers[host.id](payload)})
  return source
}
async function failure(work,action='musicUrl'){
  try{await work();assert.fail('expected failure')}catch(error){return {error,value:normalizeOnlineError(error,context(action))}}
}

test('host timeout and network codes survive music URL aggregation without exposing private text in diagnostics',async()=>{
  for(const [native,expected]of[['ETIMEDOUT','timeout'],['ECONNRESET','network']]){
    const source=engine({a:()=>{throw Object.assign(Error('PRIVATE token C:/private'),{code:native})}})
    const result=await failure(()=>source.getMusicUrl('wy',track,'128k',true))
    assert.equal(result.value.code,expected);assert.match(result.error.message,/无法获取播放地址/)
    assert.ok(!result.value.message.includes('PRIVATE'))
    const report=await runDiagnosticChecks({mode:'live',checks:[{platform:'wy',capability:'musicUrl',level:'resolution',run:()=>source.getMusicUrl('wy',track,'128k',true)}]})
    assert.equal(report.levels.resolution[0].code,expected);assert.ok(!JSON.stringify(report).includes('PRIVATE'))
  }
})

test('lyric fallback retains unanimous timeout evidence while removing ambiguous provider identity',async()=>{
  const timeout=()=>{throw Object.assign(Error('host timeout'),{code:'ETIMEDOUT'})}
  const source=engine({a:timeout,b:timeout})
  const result=await failure(()=>source.getLyric('wy',track),'lyric')
  assert.equal(result.value.code,'timeout');assert.equal(result.value.providerId,undefined)
  assert.equal(result.value.providerVersion,undefined)
})

test('mixed source failures stay unknown, and a later success still wins',async()=>{
  const source=engine({a:()=>{throw Object.assign(Error('timeout'),{code:'ETIMEDOUT'})},b:()=>{throw Error('HTTP 404 PRIVATE')}})
  const result=await failure(()=>source.getMusicUrl('wy',track,'128k',true))
  assert.equal(result.value.code,'unknown');assert.equal(result.value.httpStatus,undefined)
  const good=engine({a:()=>{throw Object.assign(Error('timeout'),{code:'ETIMEDOUT'})},b:()=> 'https://cdn.test/music.mp3'})
  assert.equal((await good.getMusicUrl('wy',track,'128k',true)).providerId,'stable-b')
})

test('agreed rate limits retain HTTP status and longest known wait, without choosing one provider',async()=>{
  const limited=delay=>()=>{throw new OnlineRequestError({...context('musicUrl'),code:'rateLimited',httpStatus:429,retryAfterMs:delay})}
  const source=engine({a:limited(1000),b:limited(7000)})
  const result=await failure(()=>source.getMusicUrl('wy',track,'128k',true))
  assert.equal(result.value.code,'rateLimited');assert.equal(result.value.httpStatus,429)
  assert.equal(result.value.retryAfterMs,7000);assert.equal(result.value.providerId,undefined)
})

test('cooling and unavailable target quality remain distinct from unknown failures',async()=>{
  const source=engine({a:()=>{throw new OnlineRequestError({...context('musicUrl'),code:'cooling'})}})
  const cooled=await failure(()=>source.getMusicUrl('wy',track,'128k',true));assert.equal(cooled.value.code,'cooling')
  const report=await runDiagnosticChecks({mode:'live',checks:[{platform:'wy',capability:'musicUrl',level:'resolution',run:()=>source.getMusicUrl('wy',track,'128k',true)}]})
  assert.equal(report.levels.resolution[0].code,'cooling')
  const missing=engine({a:()=>assert.fail('unsupported quality must not dispatch')})
  const result=await failure(()=>missing.getMusicUrl('wy',track,'320k',true));assert.equal(result.value.code,'qualityUnavailable')
})
