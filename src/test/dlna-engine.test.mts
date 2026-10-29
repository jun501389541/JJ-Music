import test from 'node:test'
import assert from 'node:assert/strict'
const {DlnaEngine}=await import('./renderer/audio/dlna-engine.js')
const session={sessionId:'s',generation:1,sequence:0,state:'connecting',position:0,duration:0}
function fixture(){let listener;const calls=[];let sequence=0;const bridge={onState:cb=>{listener=cb;return()=>{listener=undefined}},load:async(s,r,g)=>({...session,resource:r,generation:g+1,sequence:++sequence,state:'paused'}),command:async(...args)=>{calls.push(args);return {...session,generation:2,sequence:++sequence,state:'loading'}},disconnect:async()=>{}};const engine=new DlnaEngine({bridge,session});return{engine,bridge,calls,send:e=>listener?.({...session,generation:2,sequence:++sequence,resource:{kind:'local',trackId:'track'},...e})}}
test('DLNA engine requires business reference and never writes initialization volume or autoplays',async()=>{
 const f=fixture();f.engine.setVolume(.2);f.engine.setMuted(true);assert.equal(f.calls.length,0)
 await assert.rejects(f.engine.load({url:'file:///private'}))
 await f.engine.load({url:'',resourceRef:{kind:'local',trackId:'track'}});assert.equal(f.calls.length,0)
 await f.engine.play();assert.equal(f.calls[0][1],'play')
})
test('DLNA engine ignores stale identity/sequence and confirms only explicit playing evidence',async()=>{
 const f=fixture();let playing=0,ended=0;f.engine.on('playing',()=>playing++);f.engine.on('ended',()=>ended++)
 await f.engine.load({url:'',resourceRef:{kind:'local',trackId:'track'}})
 f.send({type:'state',state:'playing'});assert.equal(playing,0)
 f.send({type:'playing',state:'playing',generation:1});f.send({type:'playing',state:'playing',sessionId:'old'})
 f.send({type:'playing',state:'playing',resource:{kind:'local',trackId:'old'}});assert.equal(playing,0)
 f.send({type:'playing',state:'playing'});f.send({type:'playing',state:'playing'});assert.equal(playing,1)
 f.send({type:'state',state:'idle'});assert.equal(ended,0)
 f.send({type:'ended',state:'idle'});assert.equal(ended,1)
 f.engine.destroy()
})
test('DLNA engine rejects failed Play and reports terminal newer generation',async()=>{
 const f=fixture();await f.engine.load({url:'',resourceRef:{kind:'local',trackId:'track'}})
 let errors=0;f.engine.on('error',()=>errors++)
 f.send({type:'state',generation:3,state:'disconnected',reason:'taken-over'});assert.equal(errors,1)
 f.bridge.command=async()=>({...session,generation:3,sequence:9,state:'disconnected',reason:'taken-over'})
 await assert.rejects(f.engine.play(),/taken-over/)
})
test('DLNA engine serializes pause Stop and immediate replacement load using returned generations',async()=>{
 const f=fixture();await f.engine.load({url:'',resourceRef:{kind:'local',trackId:'track'}})
 let generation=2,sequence=10,release;const gate=new Promise(resolve=>{release=resolve});const order=[]
 f.bridge.command=async(_session,action,_value,g)=>{assert.equal(g,generation);order.push(action);if(action==='stop'){await gate;generation++}return {...session,generation,sequence:++sequence,state:'idle'}}
 f.bridge.load=async(_session,resource,g)=>{assert.equal(g,generation);order.push('load');return {...session,resource,generation:++generation,sequence:++sequence,state:'paused'}}
 const paused=f.engine.pause();f.engine.stop();const loading=f.engine.load({url:'',resourceRef:{kind:'local',trackId:'next'}})
 await new Promise(resolve=>setImmediate(resolve));assert.deepEqual(order,['pause','stop'])
 release();await Promise.all([paused,loading]);assert.deepEqual(order,['pause','stop','load'])
})
test('DLNA engine suppresses a failed pause superseded by explicit Stop',async()=>{
 const f=fixture();await f.engine.load({url:'',resourceRef:{kind:'local',trackId:'track'}})
 f.bridge.command=async(_session,action)=>{if(action==='pause')throw new Error('old pause failed');return {...session,generation:3,sequence:20,state:'idle'}}
 const paused=f.engine.pause();f.engine.stop();await assert.doesNotReject(paused)
})

test('DLNA engine keeps local and online references distinct in confirmation events',async()=>{
 const f=fixture();let playing=0;f.engine.on('playing',()=>playing++)
 await f.engine.load({url:'jjstream://audio/token',resourceRef:{kind:'online',resourceId:'track'}})
 f.send({type:'playing',state:'playing',resource:{kind:'local',trackId:'track'}})
 assert.equal(playing,0)
 f.send({type:'playing',state:'playing',resource:{kind:'online',resourceId:'track'}})
 assert.equal(playing,1)
 f.engine.destroy()
})

test('DLNA engine resumes playing state after pause without requiring duplicate confirmation',async()=>{
 const f=fixture();let playing=0;f.engine.on('playing',()=>playing++)
 await f.engine.load({url:'',resourceRef:{kind:'local',trackId:'track'}})
 f.send({type:'playing',state:'playing'});f.send({type:'state',state:'paused'})
 f.send({type:'state',state:'loading'});f.send({type:'state',state:'playing'})
 assert.equal(playing,2);f.engine.destroy()
})

test('remote Stop clears playing without ending queue and explicit replay reloads the resource',async()=>{
 const f=fixture();let paused=0,ended=0,loads=0
 f.engine.on('paused',()=>paused++);f.engine.on('ended',()=>ended++)
 await f.engine.load({url:'',resourceRef:{kind:'local',trackId:'track'}})
 f.send({type:'playing',state:'playing'});f.send({type:'state',state:'idle'})
 f.bridge.load=async(s,r,g)=>{loads++;return {...session,resource:r,generation:g+1,sequence:100,state:'paused'}}
 f.bridge.command=async()=>({...session,generation:3,sequence:101,state:'loading'})
 assert.ok(paused>0);assert.equal(ended,0);await f.engine.play();assert.equal(loads,1)
 f.engine.destroy()
})

test('Stop interrupts an in-flight load immediately and suppresses late ready before replacement',async()=>{
 const f=fixture();let finishLoad,finishStop;const order=[];let ready=0
 f.engine.on('ready',()=>ready++)
 f.bridge.load=async(_session,resource,g)=>{
  order.push(`load:${resource.trackId}:${g}`)
  if(resource.trackId==='track')return await new Promise(resolve=>{finishLoad=resolve})
  return {...session,resource,generation:g+1,sequence:30,state:'paused'}
 }
 f.bridge.command=async(_session,action,_value,g)=>{order.push(`${action}:${g}`);return await new Promise(resolve=>{finishStop=resolve})}
 const first=f.engine.load({url:'',resourceRef:{kind:'local',trackId:'track'}})
 await new Promise(resolve=>setImmediate(resolve))
 f.engine.stop();await new Promise(resolve=>setImmediate(resolve))
 assert.deepEqual(order,['load:track:1','stop:1'])
 finishLoad({...session,resource:{kind:'local',trackId:'track'},generation:2,sequence:20,state:'paused'})
 await first;assert.equal(ready,0)
 const replacement=f.engine.load({url:'',resourceRef:{kind:'local',trackId:'next'}})
 await new Promise(resolve=>setImmediate(resolve));assert.equal(order.length,2)
 finishStop({...session,generation:3,sequence:21,state:'idle'})
 await replacement;assert.deepEqual(order,['load:track:1','stop:1','load:next:3']);assert.equal(ready,1)
 f.engine.destroy()
})
