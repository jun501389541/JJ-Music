import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { SourceStore } from './sources/source-store.js'
import { SourceEngine } from './sources/source-engine.js'
import { applySourceUpdate, rollbackSourceUpdate, checkForUpdate, checkDailySourceUpdates } from './sources/source-updater.js'
import { createHash } from 'node:crypto'
const script = version => `/*!\n * @name Revision fixture\n * @version ${version}\n */\nfunction init(){return 1}`
const song={id:'wy_1',source:'wy',name:'One',singer:'',meta:{songmid:'1'}}
const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no});return {promise,resolve,reject}}
function fixture(){
  const dir=mkdtempSync(join(tmpdir(),'jj-revision-')),store=new SourceStore(dir),meta=store.import(script('1'),'fixture')
  store.setEnabled(meta.id,true)
  const states=[],events=[]
  const engine=new SourceEngine(store,resolve('out/test/source-host.cjs'))
  engine.host={
    start:async api=>{const state={api,dead:false,sources:[{id:'wy',type:'music',actions:['musicUrl','lyric','pic'],qualitys:['128k']}],ready:Promise.resolve(),pending:new Map(),logs:[]};states.push(state);return state},
    teardown:async state=>{state.dead=true},request:async()=> 'https://cdn.test/music.mp3'
  }
  engine.on({providerChanged:event=>events.push(event)})
  return {store,meta,engine,states,events,cleanup:()=>{assert.ok(resolve(dir).startsWith(resolve(tmpdir())+sep));rmSync(dir,{recursive:true,force:true})}}
}
test('transient candidates stay unroutable until durable commit publishes their real revision',async()=>{
  const f=fixture();try{
    await f.engine.reload(f.meta.id)
    const before=await f.engine.getMusicUrl('wy',song,'128k',true)
    await f.engine.reload(f.meta.id,script('2'))
    assert.deepEqual(f.engine.getSources(),[],'candidate init is not durable source availability')
    assert.deepEqual(f.engine.getSourcesByScript(),[])
    await assert.rejects(f.engine.getMusicUrl('wy',{...song,providerId:f.meta.stableId},'128k',true))
    f.store.replaceScript(f.meta.id,script('2'),'fixture');f.engine.commitCandidate(f.meta.id)
    const after=await f.engine.getMusicUrl('wy',song,'128k',true)
    assert.notEqual(after.providerVersion,before.providerVersion);assert.notEqual(after.providerGeneration,before.providerGeneration)
    assert.equal(after.providerId,before.providerId)
    assert.equal(f.events.at(-1).phase,'ready');assert.equal(f.events.at(-1).providerVersion,after.providerVersion)
  }finally{f.cleanup()}
})

test('GA06 a quarantined same-name replacement cannot route the old runtime or its late response', async () => {
  const f = fixture()
  try {
    await f.engine.reload(f.meta.id)
    f.store.import(script('2'), 'fixture')
    f.store.quarantine(f.meta.id, 'controlled quarantine')
    assert.equal(f.engine.providerRevision(f.meta.id), undefined)
    await assert.rejects(f.engine.getMusicUrl('wy', { ...song, providerId: f.meta.stableId }, '128k', true))
  } finally { f.cleanup() }
})

test('GA06 quarantine tears down the old host and invalidates its late response', async () => {
  const f = fixture(), gate = deferred(), entered = deferred()
  let pending
  try {
    await f.engine.reload(f.meta.id)
    f.engine.host.request = async () => { entered.resolve(); return gate.promise }
    pending = assert.rejects(f.engine.getMusicUrl('wy', { ...song, providerId: f.meta.stableId }, '128k', true))
    await entered.promise
    f.store.import(script('2'), 'fixture')
    await f.engine.quarantine(f.meta.id, 'controlled quarantine')
    assert.equal(f.states[0].dead, true)
    assert.equal(f.engine.isInitialized(f.meta.id), false)
    gate.resolve('https://cdn.test/old.mp3'); await pending
  } finally { gate.resolve('https://cdn.test/old.mp3'); await pending; f.cleanup() }
})
test('invalidation is synchronous before teardown waits, and same-content restoration cannot accept an old response',async()=>{
  const f=fixture();try{
    await f.engine.reload(f.meta.id)
    const before=await f.engine.getMusicUrl('wy',song,'128k',true),pending=deferred(),stop=deferred()
    f.engine.host.request=()=>pending.promise
    const old=f.engine.getMusicUrl('wy',song,'128k',true).catch(e=>e)
    f.engine.host.teardown=async state=>{state.dead=true;await stop.promise}
    const restarting=f.engine.reload(f.meta.id)
    assert.equal(f.events.at(-1).phase,'invalidated','broadcast cannot wait for old process teardown')
    stop.resolve();await restarting
    pending.resolve('https://cdn.test/late.mp3');assert.ok((await old) instanceof Error)
    f.engine.host.request=async()=> 'https://cdn.test/new.mp3'
    const after=await f.engine.getMusicUrl('wy',song,'128k',true)
    assert.equal(after.providerVersion,before.providerVersion)
    assert.notEqual(after.providerGeneration,before.providerGeneration,'content equality must not alias runtime generations')
  }finally{f.cleanup()}
})
test('an obsolete host exit cannot remove or disable a replacement runtime',async()=>{
  const f=fixture();try{
    await f.engine.reload(f.meta.id);const old=f.states[0]
    await f.engine.reload(f.meta.id,script('2'))
    f.engine.handleHostExit(old,{intentional:false,aborted:true,code:1,reason:'obsolete exit'})
    assert.equal(f.store.get(f.meta.id).meta.enabled,true)
    f.store.replaceScript(f.meta.id,script('2'),'fixture');f.engine.commitCandidate(f.meta.id)
    assert.equal((await f.engine.getMusicUrl('wy',song,'128k',true)).url,'https://cdn.test/music.mp3')
  }finally{f.cleanup()}
})

test('a candidate exiting before host.start returns leaves the old source enabled and restores it',async()=>{
  const f=fixture();try{
    await f.engine.reload(f.meta.id)
    const originalStart=f.engine.host.start;let failedState
    f.engine.host.start=async api=>{
      if(api.source===script('2')){
        failedState={api,dead:true,sources:[],pending:new Map(),logs:[]}
        f.engine.handleHostExit(failedState,{intentional:false,aborted:true,code:1,reason:'candidate startup failed'})
        throw new Error('candidate startup failed')
      }
      return originalStart(api)
    }
    await assert.rejects(applySourceUpdate(f.store,f.engine,f.meta.id,script('2')))
    assert.equal(f.store.get(f.meta.id).meta.enabled,true)
    assert.equal(f.store.get(f.meta.id).source,script('1'))
    assert.ok(f.engine.providerRevision(f.meta.id),'old version is running again')
    f.engine.handleHostExit(failedState,{intentional:false,aborted:true,code:1,reason:'late candidate exit'})
    assert.ok(f.engine.providerRevision(f.meta.id),'late startup exit cannot remove the restored runtime')
  }finally{f.cleanup()}
})

test('a committed candidate crash is handled as an installed runtime failure',async()=>{
  const f=fixture();try{
    await applySourceUpdate(f.store,f.engine,f.meta.id,script('2'))
    f.engine.handleHostExit(f.states.at(-1),{intentional:false,aborted:true,code:1,reason:'installed runtime crashed'})
    assert.equal(f.store.get(f.meta.id).meta.enabled,false)
    assert.match(f.store.get(f.meta.id).meta.lastError,/installed runtime crashed/)
  }finally{f.cleanup()}
})

test('queued daily checks reread source content before starting',async()=>{
  const f=fixture();try{
    f.store.import(script('1'),'fixture','https://fixture.invalid/source.js')
    const other=f.store.import(script('1').replace('Revision fixture','Second fixture'),'second','https://fixture.invalid/second.js')
    f.store.setEnabled(other.id,true)
    const pending=deferred(),seen=[]
    const checking=checkDailySourceUpdates(f.store,{concurrency:1,check:async input=>{
      seen.push(input);if(seen.length===1)await pending.promise
      return {ok:false,reason:'sameVersion',message:`checked ${input.currentVersion}`}
    }})
    while(!seen.length)await new Promise(r=>setImmediate(r))
    f.store.replaceScript(other.id,script('2').replace('Revision fixture','Second fixture'),'second')
    pending.resolve();await checking
    assert.equal(seen[1]?.currentVersion,'2')
    assert.equal(f.store.get(other.id).meta.updateCheck.message,'checked 2')
  }finally{f.cleanup()}
})
test('same-source update and rollback cannot overlap, and changed bytes during candidate init are preserved',async()=>{
  const f=fixture();try{
    const pending=deferred();let entered=false
    const engine={reload:async(_id,candidate)=>{if(candidate===script('2')){entered=true;await pending.promise}}}
    const first=applySourceUpdate(f.store,engine,f.meta.id,script('2'))
    while(!entered)await new Promise(r=>setImmediate(r))
    await assert.rejects(applySourceUpdate(f.store,engine,f.meta.id,script('3')),/正在更新|进行|更新中|处理中/)
    pending.resolve();await first
    const wait=deferred();let again=false
    const changing=applySourceUpdate(f.store,{reload:async(_id,candidate)=>{if(candidate){again=true;await wait.promise}}},f.meta.id,script('3'))
    while(!again)await new Promise(r=>setImmediate(r))
    f.store.replaceScript(f.meta.id,script('4'),'external change');wait.resolve()
    await assert.rejects(changing,/变化|变更/)
    assert.equal(f.store.get(f.meta.id).source,script('4'))
  }finally{f.cleanup()}
})
test('disabled update and rollback publish invalidation without executing a candidate',async()=>{
  const f=fixture();try{
    f.store.setEnabled(f.meta.id,false)
    await applySourceUpdate(f.store,f.engine,f.meta.id,script('2'))
    assert.equal(f.states.length,0);assert.equal(f.events.at(-1)?.phase,'invalidated')
    await rollbackSourceUpdate(f.store,f.engine,f.meta.id)
    assert.equal(f.states.length,0);assert.equal(f.store.get(f.meta.id).meta.enabled,false)
    assert.equal(f.events.at(-1)?.phase,'invalidated')
  }finally{f.cleanup()}
})
test('reviewed update binds the installed content, including changes under the same version label',async()=>{
  const f=fixture();try{
    const original=f.store.get(f.meta.id).source,digest=createHash('sha256').update(original).digest('hex')
    const checked=await checkForUpdate({currentVersion:'1',homepage:'https://fixture.invalid/source.js',currentScript:original},async()=>({body:Buffer.from(script('2'))}))
    assert.equal(checked.plan.baseSha256,digest)
    f.store.replaceScript(f.meta.id,script('1')+'\n// changed same version','fixture')
    let reloads=0
    await assert.rejects(applySourceUpdate(f.store,{reload:async()=>{reloads++}},f.meta.id,checked.plan.script,digest),/变化|变更/)
    assert.equal(reloads,0)
  }finally{f.cleanup()}
})
test('a daily check finishing after a source change cannot write its old summary onto the new revision',async()=>{
  const f=fixture();try{
    f.store.import(script('1'),'fixture','https://fixture.invalid/source.js')
    const pending=deferred();let entered=false
    const check=checkDailySourceUpdates(f.store,{check:async()=>{entered=true;return pending.promise}})
    while(!entered)await new Promise(r=>setImmediate(r))
    f.store.replaceScript(f.meta.id,script('2'),'fixture')
    pending.resolve({ok:false,reason:'sameVersion',message:'old check'});await check
    assert.equal(f.store.get(f.meta.id).meta.updateCheck,undefined)
  }finally{f.cleanup()}
})
