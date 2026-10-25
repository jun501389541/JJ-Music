import assert from 'node:assert/strict'
import {test} from 'node:test'
import {mkdtemp,readFile,rm} from 'node:fs/promises'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {PlaylistStore} from './store/settings-store.js'
import {writeJsonAtomic} from './store/json-file.js'
test('removeMany protects system/unknown/duplicate IDs and commits one atomic ordinary batch',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'jj-bulk-lists-'))
 try{
  let fail=false,writes=0
  const store=new PlaylistStore(dir,{write:async(path,value)=>{writes++;if(fail)throw Error('disk full');await writeJsonAtomic(path,value)}})
  const a=await store.create('Same'),b=await store.create('Same'),c=await store.create('Keep')
  await store.addTracks(a.id,[{id:'x',path:'E:/x.wav',name:'X',singer:''}])
  const before=await readFile(join(dir,'playlists.json'),'utf8'),count=writes
  for(const ids of [[],['favorites'],['default',a.id],[a.id,'unknown'],[a.id,a.id],Array.from({length:1001},(_,i)=>'id'+i)])await assert.rejects(store.removeMany(ids))
  assert.equal(writes,count)
  fail=true;await assert.rejects(store.removeMany([a.id,b.id]),/disk full/);assert.equal(await readFile(join(dir,'playlists.json'),'utf8'),before);assert.equal((await store.list()).length,5)
  fail=false;assert.equal(await store.removeMany([a.id,b.id]),2);assert.equal(writes,count+2)
  assert.deepEqual((await store.list()).map(p=>p.id),['default','favorites',c.id]);assert.deepEqual(await store.getItems(a.id),[])
  assert.equal((await new PlaylistStore(dir).list()).length,3)
 }finally{await rm(dir,{recursive:true,force:true})}
})
test('removeMany waits behind prior durable writes and later changes cannot restore removed lists',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'jj-bulk-lists-'))
 try{
  let entered,release,hold=false
  const store=new PlaylistStore(dir,{write:async(path,value)=>{if(hold){hold=false;entered();await new Promise(r=>release=r)}await writeJsonAtomic(path,value)}})
  const a=await store.create('A'),b=await store.create('B'),ready=new Promise(r=>entered=r);hold=true
  const rename=store.rename(a.id,'Renamed');await ready
  let settled=false;const remove=store.removeMany([a.id]).then(r=>{settled=true;return r});const next=store.rename(b.id,'Keep')
  await new Promise(r=>setImmediate(r));assert.equal(settled,false)
  release();await rename;assert.equal(await remove,1);await next
  assert.equal((await store.list()).find(p=>p.id===b.id).name,'Keep');assert.ok(!(await store.list()).some(p=>p.id===a.id))
 }finally{await rm(dir,{recursive:true,force:true})}
})

test('local reference snapshot waits for durable writes and returns no opaque assets or online rows',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'jj-bulk-lists-'))
 try{
  let entered,release,hold=false
  const store=new PlaylistStore(dir,{write:async(path,value)=>{if(hold){hold=false;entered();await new Promise(r=>release=r)}await writeJsonAtomic(path,value)}})
  const a=await store.create('Source')
  const ready=new Promise(r=>entered=r);hold=true
  const writing=store.addTracks(a.id,[{id:'x',path:'E:/missing.wav',name:'X',singer:'',assets:{cover:[{data:'PRIVATE'}]}},{id:'online',name:'Online',singer:'',source:'wy',meta:{}}]);await ready
  let settled=false;const pending=store.localReferences().then(r=>{settled=true;return r});await new Promise(r=>setImmediate(r));assert.equal(settled,false)
  release();await writing;const result=await pending
  assert.equal(result.references.length,1);assert.equal(result.references[0].origin.name,'Source');assert.equal(result.references[0].track.path,'E:/missing.wav');assert.equal(JSON.stringify(result).includes('PRIVATE'),false)
 }finally{await rm(dir,{recursive:true,force:true})}
})
