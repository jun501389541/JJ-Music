import assert from 'node:assert/strict'
import test from 'node:test'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { mkdtempSync, writeFileSync, rmSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, dirname, basename } from 'node:path'
import { spawn } from 'node:child_process'
import { setTimeout as delay } from 'node:timers/promises'
import { SourceRuntimeHost } from './sources/source-runtime-host.js'
import { SourceEngine } from './sources/source-engine.js'
import { SourceStore } from './sources/source-store.js'
import { applySourceUpdate, rollbackSourceUpdate } from './sources/source-updater.js'

const id='this-launch'
function fixture() {
  const dir=mkdtempSync(join(tmpdir(),'jj-windowless-'))
  const wrapper=new EventEmitter();wrapper.stdout=new PassThrough();wrapper.stderr=new PassThrough()
  wrapper.exitCode=null;wrapper.signalCode=null
  wrapper.kill=()=>{wrapper.signalCode='SIGTERM';wrapper.emit('exit',null,'SIGTERM');wrapper.emit('close',null,'SIGTERM');return true}
  let stopped=0,ready=0;const exits=[],results=[]
  const launch={wrapper,launchId:id,stop:async()=>{stopped++;wrapper.kill()}}
  const host=new SourceRuntimeHost('unused',{buildInit:()=>({}),onReady:()=>ready++,onExit:(_s,info)=>exits.push(info)})
  const state={api:{meta:{id:'synthetic',name:'synthetic'}},wrapper,launch,scratchDir:dir,sources:[],pending:new Map(),nextId:1,dead:false,logs:[],fileMode:true}
  host.attachFileLifecycle(state,error=>results.push(error??'ready'))
  const send=(type,extra={},launchId=id)=>wrapper.stdout.write(JSON.stringify({schema:1,launchId,type,...extra})+'\n')
  return {dir,wrapper,state,host,send,results,exits,get ready(){return ready},get stopped(){return stopped},readyFile:()=>writeFileSync(join(dir,'ready.json'),JSON.stringify({ok:true,sources:{}})),
    close:async()=>{await host.teardown(state,new Error('test cleanup'));rmSync(dir,{recursive:true,force:true})}}
}
test('ready before spawned waits for native confirmation',async()=>{
  const f=fixture();try {
    f.readyFile();await delay(240);assert.equal(f.ready,0);assert.equal(f.results.length,0)
    f.send('spawned',{pid:123});await delay(240);assert.equal(f.ready,1);assert.deepEqual(f.results,['ready'])
  }finally{await f.close()}
})
test('spawned before ready cannot finish initialization alone',async()=>{
  const f=fixture();try {
    f.send('spawned',{pid:123});await delay(30);assert.equal(f.results.length,0)
    f.readyFile();await delay(240);assert.equal(f.ready,1)
  }finally{await f.close()}
})
test('childExit code zero before ready is a failure and late ready cannot revive it',async()=>{
  const f=fixture();try {
    f.send('spawned',{pid:123});f.readyFile();f.send('childExit',{pid:123,exitCode:0})
    f.wrapper.emit('close',0,null);await delay(240)
    assert.equal(f.ready,0);assert.ok(f.results[0] instanceof Error);assert.equal(f.exits.length,1);assert.equal(f.state.dead,true)
  }finally{await f.close()}
})
test('launchError is immediate, safe, and stops the helper once',async()=>{
  const f=fixture();try {
    f.send('launchError',{stage:'createProcess',win32Code:1314,message:'C:\\private script'})
    await delay(20);assert.equal(f.results.length,1);assert.match(f.results[0].message,/createProcess.*1314/)
    assert.ok(!f.results[0].message.includes('private'));assert.equal(f.stopped,1)
  }finally{await f.close()}
})
test('malformed, overlong, truncated and missing statuses fail immediately',async()=>{
  for(const action of [
    f=>f.wrapper.stdout.write('private raw text\n'),
    f=>f.wrapper.stdout.write(Buffer.alloc(8193,32)),
    f=>f.wrapper.stderr.write(Buffer.alloc(65537,32)),
    f=>{f.wrapper.stdout.write('{');f.wrapper.stdout.end()},
    f=>{f.wrapper.exitCode=1;f.wrapper.emit('exit',1,null);f.wrapper.emit('close',1,null)}
  ]){
    const f=fixture();try{action(f);await delay(20);assert.ok(f.results[0] instanceof Error);assert.equal(f.state.dead,true);assert.equal(f.exits.length,1)}finally{await f.close()}
  }
})
test('an old launch status cannot satisfy the current ready',async()=>{
  const f=fixture();try{
    f.readyFile();f.send('spawned',{pid:999},'old-launch');await delay(240);assert.equal(f.ready,0)
    f.send('spawned',{pid:123});await delay(240);assert.equal(f.ready,1)
  }finally{await f.close()}
})
test('unconfirmed helper cleanup retains the owned scratch directory',async()=>{
  const f=fixture()
  f.state.launch.stop=async()=>{throw new Error('回收未确认')}
  try{await assert.rejects(f.host.teardown(f.state,new Error('stop')),/回收未确认/);assert.equal(existsSync(f.dir),true)}
  finally{rmSync(f.dir,{recursive:true,force:true})}
})
test('a missing helper fails without running a shell or ordinary source host',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'jj-windowless-missing-')),entry=join(dir,'host.cjs'),marker=join(dir,'ran')
  writeFileSync(entry,`require('fs').writeFileSync(${JSON.stringify(marker)},'unexpected')`)
  const host=new SourceRuntimeHost(entry,{buildInit:()=>({}),onReady:()=>{},onExit:()=>{}},process.execPath,'file',join(dir,'missing.exe'))
  try{await assert.rejects(host.start({meta:{id:'synthetic',name:'synthetic'}},''),/启动器缺失/);assert.equal(existsSync(marker),false)}
  finally{rmSync(dir,{recursive:true,force:true})}
})

const windows=process.platform==='win32'
const dead=pid=>{try{process.kill(pid,0);return false}catch{return true}}
const realHost=()=>new SourceRuntimeHost(resolve('out/test/source-host.cjs'),{buildInit:()=>({env:'desktop',version:'2.2.2',apiId:'synthetic',scriptInfo:{name:'synthetic'}}),onReady:()=>{},onExit:()=>{}})
const api={meta:{id:'synthetic',name:'synthetic'}}
test('native file IPC works; forged heartbeat cannot kill an unrelated process', {skip:!windows},async()=>{
  const host=realHost(),sentinel=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore',windowsHide:true})
  let state,pid
  try {
    state=await host.start(api,`const {EVENT_NAMES,send,on}=lx;on(EVENT_NAMES.request,()=>Promise.resolve('https://synthetic.invalid/track.mp3'));send(EVENT_NAMES.inited,{sources:{wy:{name:'synthetic',type:'music',actions:['musicUrl'],qualitys:['128k']}}});`)
    pid=JSON.parse(readFileSync(join(state.scratchDir,'heartbeat.json'),'utf8')).pid
    const url=await host.request(state,{source:'wy',action:'musicUrl',info:{}})
    assert.equal(url,'https://synthetic.invalid/track.mp3')
    writeFileSync(join(state.scratchDir,'heartbeat.json'),JSON.stringify({pid:sentinel.pid,at:Date.now()}))
    await host.teardown(state,new Error('synthetic stop'))
    assert.equal(dead(pid),true);assert.equal(dead(sentinel.pid),false);assert.equal(existsSync(state.scratchDir),false)
    assert.equal(state.wrapper.exitCode,0,'normal stop must let helper drain Job and exit normally')
  }finally{if(state)await host.teardown(state,new Error('cleanup'));sentinel.kill()}
})
test('native initialization cancellation reaps the helper before rejection', {skip:!windows},async()=>{
  const markerDir=mkdtempSync(join(tmpdir(),'jj-windowless-cancel-')),marker=join(markerDir,'pid.json')
  const host=realHost(),controller=new AbortController()
  let pid
  try {
    const started=host.start(api,`require('fs').writeFileSync(${JSON.stringify(marker)},JSON.stringify({pid:process.pid,scratch:process.argv[4]}));setInterval(()=>{},1000)`,controller.signal)
    const rejected=assert.rejects(started,/取消/)
    const until=Date.now()+5000
    while(!existsSync(marker)&&Date.now()<until)await delay(20)
    assert.ok(existsSync(marker),'synthetic source must reach initialization')
    const report=JSON.parse(readFileSync(marker,'utf8'));pid=report.pid
    controller.abort();await rejected
    assert.equal(dead(pid),true);assert.equal(existsSync(report.scratch),false)
  }finally{controller.abort();if(pid&&!dead(pid))process.kill(pid);rmSync(markerDir,{recursive:true,force:true})}
})
test('an early clean native host exit disables the source and rejects initialization', {skip:!windows},async()=>{
  const dir=mkdtempSync(join(tmpdir(),'jj-windowless-early-')),entry=join(dir,'host.cjs')
  writeFileSync(entry,'process.exit(0)')
  const store=new SourceStore(dir);store.load()
  const meta=store.import('/* @name synthetic */\nlx.send(lx.EVENT_NAMES.inited,{sources:{}})','synthetic')
  store.setEnabled(meta.id,true)
  const engine=new SourceEngine(store,entry,'file',{launcherPath:resolve('build/native/x64/source-launcher.exe')})
  try {await assert.rejects(engine.reload(meta.id),/退出/);assert.equal(store.get(meta.id).meta.enabled,false)}
  finally {await engine.stopAll();rmSync(dir,{recursive:true,force:true})}
})

test('a native host exiting zero after ready disables the source and persists its error', {skip:!windows},async()=>{
  const dir=mkdtempSync(join(tmpdir(),'jj-windowless-after-ready-')),entry=join(dir,'host.cjs'),marker=join(dir,'host.json'),exit=join(dir,'exit')
  writeFileSync(entry,`const fs=require('fs'),p=require('path'),scratch=process.argv[4];fs.writeFileSync(${JSON.stringify(marker)},JSON.stringify({pid:process.pid,scratch}));fs.writeFileSync(p.join(scratch,'ready.json'),JSON.stringify({ok:true,sources:{wy:{type:'music',actions:['musicUrl'],qualitys:['128k']}}}));setInterval(()=>{if(fs.existsSync(${JSON.stringify(exit)}))process.exit(0)},20);`)
  const store=new SourceStore(dir);store.load()
  const meta=store.import('/* @name after-ready fixture */\nlx.send(lx.EVENT_NAMES.inited,{sources:{}})','fixture');store.setEnabled(meta.id,true)
  const engine=new SourceEngine(store,entry,'file',{launcherPath:resolve('build/native/x64/source-launcher.exe')})
  const changed=[];engine.on({sourcesChanged:id=>changed.push(id)})
  try {
    await engine.reload(meta.id);assert.equal(engine.isInitialized(meta.id),true)
    const before=changed.length;writeFileSync(exit,'exit')
    const end=Date.now()+3000
    while(engine.getSources().length&&Date.now()<end)await delay(20)
    assert.equal(engine.getSources().length,0)
    assert.equal(store.get(meta.id).meta.enabled,false)
    assert.match(store.get(meta.id).meta.lastError,/退出|结束/)
    assert.ok(changed.length>before,'the stored stopped state must notify observers')
    const disk=new SourceStore(dir);disk.load();assert.equal(disk.get(meta.id).meta.enabled,false)
  } finally {await engine.stopAll();rmSync(dir,{recursive:true,force:true})}
})

for(const method of ['stop','stopAll'])test(`engine ${method} waits for a native initializing host to be reaped`, {skip:!windows},async()=>{
  const dir=mkdtempSync(join(tmpdir(),'jj-windowless-engine-stop-')),entry=join(dir,'host.cjs'),marker=join(dir,'host.json')
  writeFileSync(entry,`require('fs').writeFileSync(${JSON.stringify(marker)},JSON.stringify({pid:process.pid,scratch:process.argv[4]}));setInterval(()=>{},1000);`)
  const store=new SourceStore(dir);store.load()
  const meta=store.import('/* @name pending fixture */\nlx.send(lx.EVENT_NAMES.inited,{sources:{}})','fixture');store.setEnabled(meta.id,true)
  const engine=new SourceEngine(store,entry,'file',{launcherPath:resolve('build/native/x64/source-launcher.exe')})
  const controller=new AbortController(),starting=engine.startAll(controller.signal)
  try {
    const end=Date.now()+4000;while(!existsSync(marker)&&Date.now()<end)await delay(20)
    assert.ok(existsSync(marker));const report=JSON.parse(readFileSync(marker,'utf8'))
    await engine[method](meta.id)
    assert.equal(dead(report.pid),true,'stop must not return while the initializing host still runs')
    assert.equal(existsSync(report.scratch),false)
    const settled=await Promise.race([starting.then(()=>true),delay(1000).then(()=>false)])
    assert.equal(settled,true)
    assert.equal(store.get(meta.id).meta.enabled,true,'cancellation must not persist a source failure')
    assert.equal(store.get(meta.id).meta.lastError,undefined)
  } finally {controller.abort();await starting;await engine.stopAll();rmSync(dir,{recursive:true,force:true})}
})

test('native reload reaps an initializing generation before its replacement executes', {skip:!windows},async()=>{
  const dir=mkdtempSync(join(tmpdir(),'jj-windowless-reload-')),entry=join(dir,'host.cjs'),first=join(dir,'first.json'),second=join(dir,'second.json')
  writeFileSync(entry,`const fs=require('fs'),p=require('path'),scratch=process.argv[4];if(!fs.existsSync(${JSON.stringify(first)})){fs.writeFileSync(${JSON.stringify(first)},JSON.stringify({pid:process.pid,scratch}));}else{const old=JSON.parse(fs.readFileSync(${JSON.stringify(first)},'utf8'));let previousAlive=true;try{process.kill(old.pid,0)}catch{previousAlive=false}fs.writeFileSync(${JSON.stringify(second)},JSON.stringify({previousAlive}));fs.writeFileSync(p.join(scratch,'ready.json'),JSON.stringify({ok:true,sources:{wy:{type:'music',actions:['musicUrl'],qualitys:['128k']}}}));}setInterval(()=>{},1000);`)
  const store=new SourceStore(dir);store.load()
  const meta=store.import('/* @name reload fixture */\nlx.send(lx.EVENT_NAMES.inited,{sources:{}})','fixture');store.setEnabled(meta.id,true)
  const engine=new SourceEngine(store,entry,'file',{launcherPath:resolve('build/native/x64/source-launcher.exe')})
  const controller=new AbortController(),starting=engine.startAll(controller.signal)
  try {
    const end=Date.now()+4000;while(!existsSync(first)&&Date.now()<end)await delay(20)
    assert.ok(existsSync(first));const old=JSON.parse(readFileSync(first,'utf8'))
    await engine.reload(meta.id)
    assert.equal(JSON.parse(readFileSync(second,'utf8')).previousAlive,false,'old and replacement scripts must not execute concurrently')
    assert.equal(existsSync(old.scratch),false);await starting
    assert.equal(engine.isInitialized(meta.id),true)
  } finally {controller.abort();await starting;await engine.stopAll();rmSync(dir,{recursive:true,force:true})}
})

const updateScript=version=>`/*!\n * @name Native update fixture\n * @version ${version}\n */
const {send,on,EVENT_NAMES}=globalThis.lx;
on(EVENT_NAMES.request,()=>Promise.resolve('https://native-fixture.invalid/v${version}.mp3'));
send(EVENT_NAMES.inited,{status:true,sources:{wy:{type:'music',actions:['musicUrl'],qualitys:['128k']}}});`
const updateSong={id:'wy_native_update',source:'wy',name:'Synthetic',singer:'',meta:{songmid:'native_update'}}
async function nativeUpdateFixture(run){
  const dir=mkdtempSync(join(tmpdir(),'jj-native-update-')),store=new SourceStore(dir)
  store.load();const meta=store.import(updateScript('1'),'fixture');store.setEnabled(meta.id,true)
  const engine=new SourceEngine(store,resolve('out/test/source-host.cjs'),'file',{launcherPath:resolve('build/native/x64/source-launcher.exe')})
  try{await engine.reload(meta.id);await run({dir,store,meta,engine})}
  finally{
    await engine.stopAll()
    assert.equal(dirname(resolve(dir)).toLowerCase(),resolve(tmpdir()).toLowerCase())
    assert.ok(basename(dir).startsWith('jj-native-update-'))
    rmSync(dir,{recursive:true,force:true})
  }
}
function installedNativeState(engine,id){
  const state=engine.runtimes.get(id).host
  assert.equal(state.fileMode,true);assert.ok(state.launch)
  return state
}
function assertNativeReaped(state){
  assert.equal(state.wrapper.exitCode,0,'superseded native helper must confirm Job drain')
  assert.equal(existsSync(state.scratchDir),false)
}
test('native enabled source updates and rolls back with stable identity and new runtime revisions',{skip:!windows},async()=>{
  await nativeUpdateFixture(async({dir,store,meta,engine})=>{
    const v1=installedNativeState(engine,meta.id),before=engine.providerRevision(meta.id)
    assert.equal((await engine.getMusicUrl('wy',updateSong,'128k',true)).url,'https://native-fixture.invalid/v1.mp3')
    await applySourceUpdate(store,engine,meta.id,updateScript('2'))
    assertNativeReaped(v1)
    const v2=installedNativeState(engine,meta.id),updated=store.get(meta.id),revision2=engine.providerRevision(meta.id)
    assert.equal(updated.meta.version,'2');assert.equal(updated.meta.stableId,meta.stableId);assert.equal(updated.meta.enabled,true)
    assert.equal(store.previousSource(meta.id),updateScript('1'))
    assert.notEqual(revision2.generation,before.generation);assert.notEqual(revision2.providerVersion,before.providerVersion)
    assert.equal((await engine.getMusicUrl('wy',updateSong,'128k',true)).url,'https://native-fixture.invalid/v2.mp3')
    await rollbackSourceUpdate(store,engine,meta.id)
    assertNativeReaped(v2)
    const revision1=engine.providerRevision(meta.id)
    assert.notEqual(revision1.generation,revision2.generation)
    assert.equal((await engine.getMusicUrl('wy',updateSong,'128k',true)).url,'https://native-fixture.invalid/v1.mp3')
    const disk=new SourceStore(dir);disk.load()
    assert.equal(disk.get(meta.id).source,updateScript('1'));assert.equal(disk.get(meta.id).meta.stableId,meta.stableId)
    assert.equal(disk.get(meta.id).meta.enabled,true)
  })
})
test('a failed native update candidate restores the enabled installed source without committing bad bytes',{skip:!windows},async()=>{
  await nativeUpdateFixture(async({dir,store,meta,engine})=>{
    const old=installedNativeState(engine,meta.id),before=engine.providerRevision(meta.id)
    const candidateMarker=join(dir,'candidate.json')
    const bad=`/*!\n * @name Native update fixture\n * @version 2\n */\nrequire('fs').writeFileSync(${JSON.stringify(candidateMarker)},JSON.stringify({pid:process.pid,scratch:process.argv[4]}));lx.on(lx.EVENT_NAMES.request,()=>1);throw new Error('synthetic candidate failure');`
    await assert.rejects(applySourceUpdate(store,engine,meta.id,bad),/已自动恢复旧版本/)
    assertNativeReaped(old)
    assert.ok(existsSync(candidateMarker),'failed candidate must execute in its own host')
    const candidate=JSON.parse(readFileSync(candidateMarker,'utf8'))
    assert.equal(dead(candidate.pid),true,'failed native candidate must be reaped')
    assert.equal(existsSync(candidate.scratch),false,'failed candidate scratch must be removed')
    const installed=store.get(meta.id),restored=engine.providerRevision(meta.id)
    assert.equal(installed.source,updateScript('1'));assert.equal(installed.meta.enabled,true)
    assert.equal(installed.meta.stableId,meta.stableId);assert.equal(installed.meta.lastError,undefined)
    assert.equal(store.previousSource(meta.id),undefined)
    assert.notEqual(restored.generation,before.generation)
    assert.equal((await engine.getMusicUrl('wy',updateSong,'128k',true)).url,'https://native-fixture.invalid/v1.mp3')
    const disk=new SourceStore(dir);disk.load();assert.equal(disk.get(meta.id).source,updateScript('1'));assert.equal(disk.get(meta.id).meta.enabled,true)
  })
})

for(const ready of [false,true])test(`unconfirmed native cleanup ${ready?'after ready':'during initialization'} rejects stop and blocks replacement`,{skip:!windows},async()=>{
  const dir=mkdtempSync(join(tmpdir(),'jj-cleanup-failure-')),marker=join(dir,'host.json'),entry=join(dir,'host.cjs')
  writeFileSync(entry,`const fs=require('fs'),p=require('path'),scratch=process.argv[4];fs.writeFileSync(${JSON.stringify(marker)},JSON.stringify({pid:process.pid,scratch}));${ready?"fs.writeFileSync(p.join(scratch,'ready.json'),JSON.stringify({ok:true,sources:{wy:{type:'music',actions:['musicUrl'],qualitys:['128k']}}}));":''}setInterval(()=>{},1000);`)
  const store=new SourceStore(dir);store.load()
  const meta=store.import('/* @name cleanup fixture */\nlx.on(lx.EVENT_NAMES.request,()=>1)','fixture');store.setEnabled(meta.id,true)
  const engine=new SourceEngine(store,entry,'file',{launcherPath:resolve('build/native/x64/source-launcher.exe')})
  const host=engine.getHost(),realTeardown=host.teardown.bind(host),realStart=host.start.bind(host)
  let starts=0
  host.start=(...args)=>{starts++;return realStart(...args)}
  // Reap real test processes first; inject only the missing-confirmation error.
  host.teardown=async(state,reason)=>{await realTeardown(state,reason);throw new Error('synthetic cleanup unconfirmed')}
  const controller=new AbortController(),starting=engine.startAll(controller.signal)
  try{
    const end=Date.now()+4000;while(!existsSync(marker)&&Date.now()<end)await delay(20)
    assert.ok(existsSync(marker));if(ready)await starting
    await assert.rejects(engine.stop(meta.id),/回收未确认|cleanup unconfirmed/)
    await starting
    await assert.rejects(engine.reload(meta.id),/回收未确认|cleanup unconfirmed/)
    assert.equal(starts,1,'a replacement must not start while prior cleanup is unconfirmed')
    await assert.rejects(engine.stopAll(),/回收未确认|cleanup unconfirmed/)
    assert.equal(engine.getSources().length,0)
    const report=JSON.parse(readFileSync(marker,'utf8'))
    assert.equal(dead(report.pid),true);assert.equal(existsSync(report.scratch),false,'injection must not leak actual fixture processes or scratch')
  }finally{
    host.teardown=realTeardown;controller.abort();await starting;await engine.stopAll().catch(()=>{})
    assert.equal(dirname(resolve(dir)).toLowerCase(),resolve(tmpdir()).toLowerCase());assert.ok(basename(dir).startsWith('jj-cleanup-failure-'))
    rmSync(dir,{recursive:true,force:true})
  }
})

test('concurrent native reload waits for an in-flight stop and rejects its unconfirmed cleanup',{skip:!windows},async()=>{
  await nativeUpdateFixture(async({meta,engine})=>{
    const host=engine.getHost(),realTeardown=host.teardown.bind(host),realStart=host.start.bind(host)
    let release,entered,starts=0
    const gate=new Promise(resolve=>{release=resolve}),tearingDown=new Promise(resolve=>{entered=resolve})
    host.start=(...args)=>{starts++;return realStart(...args)}
    host.teardown=async(state,reason)=>{await realTeardown(state,reason);entered();await gate;throw new Error('synthetic cleanup unconfirmed')}
    const stopping=assert.rejects(engine.stop(meta.id),/cleanup unconfirmed/)
    let reloading
    try{
      await tearingDown
      reloading=assert.rejects(engine.reload(meta.id),/cleanup unconfirmed/)
      // Observe rejection immediately even if a regression starts the replacement.
      void reloading.catch(()=>{})
      await delay(100)
      assert.equal(starts,0,'replacement must wait while the prior stop is still pending')
      release();await Promise.all([stopping,reloading])
    }finally{
      release();await stopping;await reloading?.catch(()=>{})
      host.teardown=realTeardown
    }
  })
})
