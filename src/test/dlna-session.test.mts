import assert from 'node:assert/strict'
import test from 'node:test'
const { DlnaSessionManager } = await import('./dlna/session-manager.js')
const device = { id:'dev',name:'Speaker',address:'192.168.1.2', capabilities:{pause:true,seek:true,volume:true} }
function fixture() {
  let observation={state:'PLAYING',uri:'http://192.168.1.1/audio',position:0,duration:10}
  let bytes=0, revoked=0, stops=0
  const events=[]
  const transport={setUri:async()=>{},play:async()=>{},pause:async()=>{},seek:async()=>{},setVolume:async()=>{},stop:async()=>{stops++},inspect:async()=>({...observation})}
  const manager=new DlnaSessionManager({transport,leases:{create:async()=>({id:'lease',url:observation.uri,audioBytesTransferred:()=>bytes,revoke:()=>{revoked++}})},onEvent:e=>events.push(e),scheduler:{set:()=>0,clear:()=>{}},id:()=> 'session'})
  manager.select(device)
  return {manager,events,transport,set:(o)=>Object.assign(observation,o),bytes:()=>{bytes++},revoked:()=>revoked,stops:()=>stops}
}
test('DLNA confirms once only with matching URI and playback evidence',async()=>{
  const f=fixture();await f.manager.load({kind:'local',trackId:'track'})
  await f.manager.pollNow();assert.equal(f.events.filter(e=>e.type==='playing').length,0)
  f.set({position:1});await f.manager.pollNow();await f.manager.pollNow()
  assert.equal(f.events.filter(e=>e.type==='playing').length,1)
  f.set({state:'STOPPED'});await f.manager.pollNow()
  assert.equal(f.events.filter(e=>e.type==='ended').length,0)
})
test('DLNA takeover revokes lease without stopping another controller',async()=>{
  const f=fixture();await f.manager.load({kind:'local',trackId:'track'});f.set({uri:'http://other/program'})
  await f.manager.pollNow();await f.manager.stop()
  assert.equal(f.stops(),0);assert.equal(f.revoked(),1);assert.equal(f.manager.snapshot().reason,'taken-over')
})
test('DLNA disconnects after three poll failures',async()=>{
  const f=fixture();await f.manager.load({kind:'local',trackId:'track'})
  f.transport.inspect=async()=>{throw Error('offline')}
  await f.manager.pollNow();await f.manager.pollNow();assert.notEqual(f.manager.snapshot().state,'disconnected')
  await f.manager.pollNow();assert.equal(f.manager.snapshot().state,'disconnected');assert.equal(f.revoked(),1)
})
test('DLNA load never autoplays a restored paused queue',async()=>{
  const f=fixture();let plays=0;f.transport.play=async()=>{plays++}
  await f.manager.load({kind:'local',trackId:'track'},{autoplay:false})
  assert.equal(plays,0);assert.equal(f.manager.snapshot().state,'paused')
  f.set({state:'STOPPED'});await f.manager.pollNow();assert.equal(f.revoked(),0)
  await f.manager.play();assert.equal(plays,1)
})
test('DLNA aborts stale loads, revokes late leases, and serializes device controls',async()=>{
  const f=fixture();let release;let entered;const entry=new Promise(resolve=>{entered=resolve})
  const gate=new Promise(resolve=>{release=resolve});const calls=[]
  f.transport.setUri=async(_d,uri)=>{calls.push(uri);entered();await gate}
  const first=f.manager.load({kind:'local',trackId:'first'},{autoplay:true});await entry
  const second=f.manager.load({kind:'local',trackId:'second'},{autoplay:true})
  await Promise.resolve();assert.equal(calls.length,1)
  release();await Promise.all([first,second]);assert.equal(calls.length,2)
  assert.equal(f.manager.snapshot().resource.trackId,'second');assert.equal(f.revoked(),1)
})
test('DLNA rejects observations arriving after a newer command',async()=>{
  const f=fixture();await f.manager.load({kind:'local',trackId:'track'})
  let release;let entered;const entry=new Promise(resolve=>{entered=resolve})
  const gate=new Promise(resolve=>{release=resolve})
  f.transport.inspect=async()=>{entered();await gate;return {state:'PLAYING',uri:'http://192.168.1.1/audio',position:8,duration:10}}
  const poll=f.manager.pollNow();await entry;const pause=f.manager.pause();release();await Promise.all([poll,pause])
  assert.equal(f.manager.snapshot().state,'paused');assert.equal(f.events.filter(e=>e.type==='playing').length,0)
})
test('DLNA reports an unconfirmed Stop when current URI is unavailable',async()=>{
  const f=fixture();await f.manager.load({kind:'local',trackId:'track'});f.set({uri:''})
  await assert.rejects(f.manager.stop(),/ownership/);assert.equal(f.manager.snapshot().reason,'stop-unconfirmed');assert.equal(f.stops(),0)
})
test('DLNA requires a stopped observation after successful SOAP Stop',async()=>{
  const f=fixture();await f.manager.load({kind:'local',trackId:'track'})
  await assert.rejects(f.manager.stop(),/not confirmed/);assert.equal(f.manager.snapshot().reason,'stop-unconfirmed')
})
test('DLNA caps total load budget, aborts its work, and revokes a late lease',async()=>{
  let expire,release,signal;let revoked=0
  const manager=new DlnaSessionManager({transport:{},leases:{create:async(_input,s)=>{signal=s;return await new Promise(resolve=>{release=resolve})}},onEvent:()=>{},scheduler:{set:(cb,delay)=>{assert.equal(delay,15000);expire=cb;return 1},clear:()=>{}}})
  manager.select(device);const loading=manager.load({kind:'local',trackId:'track'})
  expire();await assert.rejects(loading,/timed out/);assert.equal(signal.aborted,true);assert.equal(manager.snapshot().state,'error')
  release({id:'late',url:'http://lan',audioBytesTransferred:()=>0,revoke:()=>{revoked++}});await Promise.resolve();await Promise.resolve();assert.equal(revoked,1)
})


test('DLNA volume uses confirmed observations, preserves initial reading and rejects unsupported or invalid writes',async()=>{
 const f=fixture();await f.manager.load({kind:'local',trackId:'track'});let writes=0
 f.transport.setVolume=async()=>{writes++};f.set({volume:.2});await f.manager.pollNow();assert.equal(f.manager.snapshot().volume,.2)
 await f.manager.setVolume(.8);assert.equal(writes,1);assert.equal(f.manager.snapshot().volume,.2)
 for(const value of [-.1,1.1,NaN])await assert.rejects(f.manager.setVolume(value),/invalid/)
 assert.equal(writes,1)
 const unsupported=new DlnaSessionManager({transport:f.transport,leases:{create:async()=>({id:'x',url:'http://192.168.1.1/audio',audioBytesTransferred:()=>0,revoke(){}})},onEvent(){},scheduler:{set:()=>0,clear(){}}})
 unsupported.select({...device,capabilities:{...device.capabilities,volume:false},initialVolume:.3});assert.equal(unsupported.snapshot().volume,.3);await assert.rejects(unsupported.setVolume(.9),/unsupported/)
 f.set({state:'STOPPED'});await f.manager.disconnect()
})

test('Stop cancels a pending lease load and reclaims its late result without changing selected device',async()=>{
 const f=fixture();let release,entered;const ready=new Promise(r=>entered=r);let revoked=0
 f.manager.options.leases.create=async()=>{entered();return new Promise(r=>release=()=>r({id:'late',url:'http://late',audioBytesTransferred:()=>0,revoke(){revoked++}}))}
 const load=f.manager.load({kind:'online',resourceId:'pending'});await ready;await f.manager.stop();assert.equal(f.manager.snapshot().state,'idle');assert.equal(f.manager.snapshot().deviceId,'dev');release();await load;assert.equal(revoked,1);assert.equal(f.manager.snapshot().state,'idle')
})
