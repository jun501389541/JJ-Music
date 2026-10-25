import assert from 'node:assert/strict'
import {test} from 'node:test'
import {mkdtemp,readFile,rm} from 'node:fs/promises'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {PlaylistStore} from './store/settings-store.js'
import {writeJsonAtomic} from './store/json-file.js'
const local=(id='same',name='First')=>({id,path:'E:/generated/'+id+'.wav',name,singer:'Singer'})
const online=(source='wy',id='same',name='Online')=>({id,source,name,singer:'Singer',meta:{songmid:id,custom:'retained'}})
async function setup(t,write){const dir=await mkdtemp(join(tmpdir(),'jj-derive-'));t.after(()=>rm(dir,{recursive:true,force:true}));const store=new PlaylistStore(dir,write?{write}:{});const a=await store.create('First',{source:'wy',sourceListId:'123'}),b=await store.create('Second');await store.addTracks(a.id,[local(),online()]);await store.addTracks(b.id,[local('same','Later'),online('tx'),online('wy','other')]);return{dir,store,a,b}}
async function service(store,options={}){const{PlaylistDerive}=await import('./library/playlist-derive.js');return new PlaylistDerive({playlists:store,...options})}

test('derive snapshots are consistent, owned and reject system/unknown/duplicate selection',async t=>{
 const f=await setup(t),snap=await f.store.deriveSnapshot([f.b.id,f.a.id])
 assert.deepEqual(snap.map(x=>x.playlist.id),[f.b.id,f.a.id]);snap[0].tracks[0].name='Mutated'
 assert.equal((await f.store.getItems(f.b.id))[0].name,'Later')
 for(const ids of [[],['default'],['favorites'],[f.a.id,f.a.id],[f.a.id,'missing'],Array.from({length:1001},(_,i)=>String(i))])await assert.rejects(f.store.deriveSnapshot(ids))
})

test('copy creates independent new records once, preserves native data/origin/order, and reloads',async t=>{
 let writes=0;const f=await setup(t,async(path,data)=>{writes++;await writeJsonAtomic(path,data)}),s=await service(f.store),before=await f.store.backupSnapshot(),count=writes
 const p=await s.preview('copy',[f.b.id,f.a.id],'')
 assert.equal(p.outputs.length,2);assert.equal(p.inputTracks,5);assert.equal((await f.store.list()).length,4)
 const r=await s.apply(p.token);assert.equal(writes,count+1);assert.equal(r.ids.length,2)
 const lists=await f.store.list();assert.equal(lists.find(x=>x.id===r.ids[0]).name,'Second（副本）')
 const remote=lists.find(x=>x.id===r.ids[1]);assert.equal(remote.source,'wy');assert.equal(remote.sourceListId,'123')
 assert.deepEqual(await f.store.getItems(r.ids[1]),await f.store.getItems(f.a.id))
 assert.deepEqual((await f.store.backupSnapshot()).slice(0,4),before)
 assert.deepEqual(await new PlaylistStore(f.dir).getItems(r.ids[1]),await f.store.getItems(f.a.id))
 await assert.rejects(s.apply(p.token),/失效/)
})

test('merge preserves visible source order, local/online/platform separation and first metadata',async t=>{
 const f=await setup(t),s=await service(f.store),p=await s.preview('merge',[f.b.id,f.a.id],'  My merged  ')
 assert.equal(p.inputTracks,5);assert.equal(p.outputTracks,4);assert.equal(p.duplicates,1)
 const r=await s.apply(p.token),list=(await f.store.list()).find(x=>x.id===r.ids[0]),tracks=await f.store.getItems(r.ids[0])
 assert.equal(list.name,'My merged');assert.equal(list.source,'local');assert.equal(list.sourceListId,undefined)
 assert.deepEqual(tracks.map(x=>[x.path?'local':x.source,x.id]),[['local','same'],['tx','same'],['wy','other'],['wy','same']]);assert.equal(tracks[0].name,'Later')
})

test('selected source changes reject complete batch while unrelated edits survive creation',async t=>{
 const f=await setup(t),s=await service(f.store),p=await s.preview('copy',[f.a.id],'')
 await f.store.rename(f.a.id,'Changed');await assert.rejects(s.apply(p.token),/已变更/);assert.equal((await f.store.list()).length,4)
 const next=await s.preview('copy',[f.a.id],'');await f.store.rename(f.b.id,'Unrelated')
 await s.apply(next.token);assert.equal((await f.store.list()).find(x=>x.id===f.b.id).name,'Unrelated')
})

test('disk failure rolls back whole creation before queued edit and does not reuse consumed token',async t=>{
 let fail=false;const f=await setup(t,async(path,data)=>{if(fail){fail=false;throw Error('disk full')}await writeJsonAtomic(path,data)}),s=await service(f.store)
 const p=await s.preview('copy',[f.a.id,f.b.id],''),disk=await readFile(join(f.dir,'playlists.json'),'utf8');fail=true
 const apply=s.apply(p.token),rename=f.store.rename(f.b.id,'After failure');await assert.rejects(apply,/disk full/);await rename
 assert.equal((await f.store.list()).length,4);assert.equal((await new PlaylistStore(f.dir).list()).length,4)
 assert.equal((await f.store.list()).find(x=>x.id===f.b.id).name,'After failure');await assert.rejects(s.apply(p.token),/失效/)
 assert.notEqual(await readFile(join(f.dir,'playlists.json'),'utf8'),disk)
})

test('new preview, exact discard, expiration, clock rollback and clear invalidate only appropriate lease',async t=>{
 const f=await setup(t);let now=100;const s=await service(f.store,{now:()=>now})
 const first=await s.preview('copy',[f.a.id],''),second=await s.preview('copy',[f.b.id],'');s.discard(first.token)
 await assert.rejects(s.apply(first.token),/失效/);await s.apply(second.token)
 const expired=await s.preview('copy',[f.a.id],'');now+=600000;await assert.rejects(s.apply(expired.token),/过期|失效/)
 const rollback=await s.preview('copy',[f.a.id],'');now--;await assert.rejects(s.apply(rollback.token),/过期|失效/)
 const cleared=await s.preview('copy',[f.a.id],'');s.clear();await assert.rejects(s.apply(cleared.token),/失效/)
})

test('cancellation and superseding request cannot register late candidates',async t=>{
 const f=await setup(t);let release,hold=true;const original=f.store.deriveSnapshot.bind(f.store)
 const wrapped={deriveSnapshot:async ids=>{const snap=await original(ids);if(hold){hold=false;await new Promise(r=>release=r)}return snap},createDerived:(...args)=>f.store.createDerived(...args)}
 const s=await service(wrapped),controller=new AbortController(),pending=s.preview('copy',[f.a.id],'',controller.signal)
 const rejected=assert.rejects(pending,/取消|失效/)
 while(!release)await new Promise(r=>setImmediate(r))
 const next=await s.preview('copy',[f.b.id],'');controller.abort();release();await rejected;await s.apply(next.token)
 assert.equal((await f.store.list()).length,5)
})

test('capacity and malformed identities fail without creating a partial result',async t=>{
 const f=await setup(t,async()=>{}),s=await service(f.store)
 for(const args of [['merge',[f.a.id],'x'],['merge',[f.a.id,f.b.id],' '],['copy',[f.a.id],'unexpected'],['wrong',[f.a.id],'']])await assert.rejects(s.preview(...args))
 await f.store.addTracks(f.a.id,[{id:'broken',name:'Bad',singer:''}]);await assert.rejects(s.preview('copy',[f.a.id],''),/身份|无效/)
 const huge=await f.store.create('Huge');await f.store.addTracks(huge.id,Array.from({length:50001},(_,i)=>local(String(i))))
 await assert.rejects(f.store.deriveSnapshot([huge.id]),/50000|过多|上限/)
 const bytes=await f.store.create('Bytes');await f.store.addTracks(bytes.id,[{...local('bytes'),extra:'x'.repeat(20*1024*1024)}])
 await assert.rejects(f.store.deriveSnapshot([bytes.id]),/20|过大|上限/)
})

test('empty lists can be copied or merged, long copied names remain bounded, maintenance blocks commit',async t=>{
 const f=await setup(t),a=await f.store.create('x'.repeat(4096)),b=await f.store.create('Empty');let ready=true
 const s=await service(f.store,{assertReady:()=>{if(!ready)throw Error('maintenance')}})
 const p=await s.preview('copy',[a.id],'');assert.equal(p.outputs[0].name.length,4096);assert.equal(p.outputTracks,0)
 ready=false;await assert.rejects(s.apply(p.token),/maintenance/);ready=true
 const merged=await s.preview('merge',[a.id,b.id],'Empty merged'),r=await s.apply(merged.token)
 assert.deepEqual(await f.store.getItems(r.ids[0]),[])
})
test('snapshot waits for durable prior mutation and does not observe half-persisted state',async t=>{
 let hold=false,entered,release;const f=await setup(t,async(path,value)=>{if(hold){hold=false;entered();await new Promise(r=>release=r)}await writeJsonAtomic(path,value)})
 const waiting=new Promise(r=>entered=r);hold=true;const writing=f.store.rename(f.a.id,'Durable name');await waiting
 let settled=false;const pending=f.store.deriveSnapshot([f.a.id]).then(s=>{settled=true;return s})
 await new Promise(r=>setImmediate(r));assert.equal(settled,false);release();await writing;assert.equal((await pending)[0].playlist.name,'Durable name')
})

test('maintenance is rechecked inside queued commit, after an unrelated write finishes',async t=>{
 let hold=false,entered,release,ready=true;const f=await setup(t,async(path,value)=>{if(hold){hold=false;entered();await new Promise(r=>release=r)}await writeJsonAtomic(path,value)})
 const s=await service(f.store,{assertReady:()=>{if(!ready)throw Error('maintenance')}}),p=await s.preview('copy',[f.a.id],'')
 const waiting=new Promise(r=>entered=r);hold=true;const editing=f.store.rename(f.b.id,'Unrelated durable');await waiting
 const pending=s.apply(p.token),rejected=assert.rejects(pending,/maintenance/);await new Promise(r=>setImmediate(r));ready=false;release();await editing;await rejected
 assert.equal((await f.store.list()).length,4);assert.equal((await f.store.list()).find(x=>x.id===f.b.id).name,'Unrelated durable')
})
