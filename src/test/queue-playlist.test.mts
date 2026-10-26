import assert from 'node:assert/strict'
import {test} from 'node:test'
import {mkdtemp,rm,readFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {PlaylistStore} from './store/settings-store.js'
import {writeJsonAtomic} from './store/json-file.js'
import {assertIpcArgs} from './ipc-validation.js'
const local=(id='same')=>({id,name:id,singer:'Artist',path:'E:/generated/'+id+'.wav'})
const online=(source='wy')=>({id:'same',name:'Online',singer:'Singer',source,providerId:'bound-source',providerData:{native:'retained'},meta:{songmid:'native',hash:'hash'},url:'https://runtime/never',picUrl:'data:image/png;base64,AAAA',assets:{cover:[{origin:'remote',provider:'音源脚本'}]}})
async function setup(t,write){const dir=await mkdtemp(join(tmpdir(),'jj-queue-'));t.after(()=>rm(dir,{recursive:true,force:true}));const store=new PlaylistStore(dir,write?{write}:{});await store.load();return{store,dir}}

test('queue save atomically creates an independent full-identity stable snapshot',async t=>{
 const {store,dir}=await setup(t),input=[local(),online(),online('tx'),local(),online()];const raw=structuredClone(input)
 const r=await store.createFromQueue('  Saved queue  ',input)
 assert.equal(r.playlist.name,'Saved queue');assert.equal(r.playlist.source,'local');assert.equal(r.inputTracks,5);assert.equal(r.tracks,3);assert.equal(r.duplicates,2)
 assert.equal(r.playlist.sourceListId,undefined)
 const tracks=await store.getItems(r.playlist.id);assert.deepEqual(tracks.map(v=>v.source??'local'),['local','wy','tx'])
 assert.equal(tracks[1].providerId,'bound-source');assert.deepEqual(tracks[1].providerData,{native:'retained'});assert.equal(tracks[1].meta.songmid,'native')
 assert.equal(tracks[1].picUrl,undefined);assert.equal(tracks[1].url,undefined);assert.deepEqual(input,raw)
 const reloaded=new PlaylistStore(dir);assert.deepEqual(await reloaded.getItems(r.playlist.id),tracks)
})
test('queue save rejects invalid and oversized raw input without partial lists',async t=>{
 const {store}=await setup(t);const count=(await store.list()).length
 for(const [name,tracks] of [[' ',[local()]],['x'.repeat(4097),[local()]],['bad\0',[local()]],['Empty',[]],['Malformed',[{id:'bad',name:'Bad'}]],['Huge',Array(50001).fill(local())],['Bytes',[{...local(),extra:'x'.repeat(20*1024*1024)}]]])await assert.rejects(store.createFromQueue(name,tracks))
 assert.equal((await store.list()).length,count)
 for(const args of [[],['name'],['name',[]],['name',[local()],true]])assert.throws(()=>assertIpcArgs('playlist:create-from-queue',args))
 assert.doesNotThrow(()=>assertIpcArgs('playlist:create-from-queue',['Valid',[local()]]))
})
test('queue creation persistence failure rolls back while the next mutation remains durable',async t=>{
 let fail=true;const {store,dir}=await setup(t,async(path,value)=>{if(fail){fail=false;throw Error('disk rejected')}await writeJsonAtomic(path,value)})
 const rejected=assert.rejects(store.createFromQueue('Failed',[local()]),/disk rejected/)
 const next=store.create('Concurrent');await rejected;const created=await next
 assert.deepEqual((await store.list()).map(p=>p.name),['默认列表','我喜欢的','Concurrent'])
 const disk=JSON.parse(await readFile(join(dir,'playlists.json'),'utf8'));assert.deepEqual(disk.items[created.id],[]);assert.equal(disk.playlists.some(p=>p.name==='Failed'),false)
})
test('queue payload is captured before waiting for persistence and cannot mutate saved references',async t=>{
 let release,entered;const wait=new Promise(r=>entered=r);const {store}=await setup(t,async(path,value)=>{entered();await new Promise(r=>release=r);await writeJsonAtomic(path,value)})
 const input=[local('original')],pending=store.createFromQueue('Frozen',input);await wait;input[0].name='changed';input.push(local('late'));release()
 const r=await pending;assert.equal(r.tracks,1);assert.equal((await store.getItems(r.playlist.id))[0].name,'original')
})
test('queue save rejects ambiguous identities and malformed typed metadata without storing broken rows',async t=>{
 const {store}=await setup(t);const bad=[{...local(),source:'wy'},{...online(),meta:{qualitys:'bad'}},{...online(),meta:{songmid:{id:1}}},{...local(),assets:{cover:'bad'}},{...local(),assets:{lyrics:{main:[{origin:'invented'}]}}}]
 for(const track of bad)await assert.rejects(store.createFromQueue('Rejected',[track]))
 assert.equal((await store.list()).length,2)
})
test('queue names are trimmed before length validation and non-script inline covers stay intact',async t=>{
 const {store}=await setup(t);const track={...online(),assets:{cover:[{origin:'user'}]},picUrl:'data:image/png;base64,AAAA'}
 const r=await store.createFromQueue(' '+ 'x'.repeat(4096)+' ',[track]);assert.equal(r.playlist.name.length,4096)
 assert.equal((await store.getItems(r.playlist.id))[0].picUrl,track.picUrl)
})
