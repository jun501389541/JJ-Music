import assert from 'node:assert/strict'
import {test} from 'node:test'
import {mkdtemp,rm,writeFile,readFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
async function setup(t,options){const dir=await mkdtemp(join(tmpdir(),'jj-lyric-offset-'));t.after(()=>rm(dir,{recursive:true,force:true}));const {LyricOffsetStore}=await import('./store/lyric-offset-store.js');return{dir,store:new LyricOffsetStore(dir,options),LyricOffsetStore}}
test('lyric offset store serializes per-key writes and survives restart and reset',async t=>{
 const {store,dir,LyricOffsetStore}=await setup(t);assert.deepEqual(await store.get(),{})
 await Promise.all([store.set('local:same',100),store.set('online:wy:same',-200),store.set('local:same',300)])
 assert.deepEqual(await new LyricOffsetStore(dir).get(),{'local:same':300,'online:wy:same':-200})
 await store.set('local:same',0);await store.flush();assert.deepEqual(await new LyricOffsetStore(dir).get(),{'online:wy:same':-200})
})
test('lyric offset store commits only after write success and recovers subsequent writes',async t=>{
 let fail=false,writes=0
 const {store,dir,LyricOffsetStore}=await setup(t,{write:async(path,data)=>{writes++;if(fail)throw Error('disk fixture');await writeFile(path,JSON.stringify(data))}})
 await store.set('local:a',100);fail=true;await assert.rejects(store.set('local:a',200),/disk fixture/)
 assert.deepEqual(await store.get(),{'local:a':100});assert.deepEqual(await new LyricOffsetStore(dir).get(),{'local:a':100})
 fail=false;await store.set('local:b',300);const before=writes;await store.set('local:missing',0);await store.set('local:b',300);assert.equal(writes,before)
 assert.deepEqual(await store.get(),{'local:a':100,'local:b':300})
})
test('lyric offset corrupt unsupported invalid or oversized files remain untouched and block writes',async t=>{
 for(const data of ['{broken',JSON.stringify({version:2,offsets:{}}),JSON.stringify({version:1,offsets:{'local:a':101}}),' '.repeat(4*1024*1024+1)]){
  const {dir,store}=await setup(t);const path=join(dir,'lyric-offsets.json');await writeFile(path,data)
  await assert.rejects(store.get());await assert.rejects(store.set('local:a',100));assert.equal(await readFile(path,'utf8'),data)
 }
})
test('lyric offset rejects malformed writes without poisoning queue and does not expose mutable map',async t=>{
 const {store}=await setup(t);await assert.rejects(store.set('online:bad:a',100));await assert.rejects(store.set('local:a',30100))
 await store.set('local:a',100);const map=await store.get();map['local:a']=300;assert.equal((await store.get())['local:a'],100)
})
test('lyric offset limits new entries while allowing existing edit reset and reclaimed slot',async t=>{
 const {store,dir}=await setup(t),offsets=Object.fromEntries(Array.from({length:50000},(_,i)=>['local:'+i,100]))
 await writeFile(join(dir,'lyric-offsets.json'),JSON.stringify({version:1,offsets}))
 await assert.rejects(store.set('local:overflow',100));await store.set('local:0',200);await store.set('local:0',0);await store.set('local:overflow',100)
 assert.equal(Object.keys(await store.get()).length,50000)
})
