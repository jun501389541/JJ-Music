import assert from 'node:assert/strict'
import {test} from 'node:test'
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
async function setup(t){const dir=await mkdtemp(join(tmpdir(),'jj-books-'));t.after(()=>rm(dir,{recursive:true,force:true}));const {TrackBookmarksStore}=await import('./store/track-bookmarks-store.js');return{dir,Store:TrackBookmarksStore,store:new TrackBookmarksStore(dir)}}
const add=(key='local:a',positionMs=1200,name='Label')=>({kind:'add',key,positionMs,name})
test('bookmarks add rename remove CAS and concurrent full identity updates',async t=>{
 const {store,dir,Store}=await setup(t);await store.mutate(add());const first=(await store.get()).records['local:a'][0]
 assert.match(first.id,/^[0-9a-f-]{36}$/i);await assert.rejects(store.mutate(add()),/已有/)
 await Promise.all([store.mutate(add('online:wy:a',0)),store.mutate(add('online:tx:a',0))])
 await store.mutate({kind:'rename',key:'local:a',expected:first,name:'Renamed'});await assert.rejects(store.mutate({kind:'remove',key:'local:a',expected:first}),/变化/)
 const current=(await store.get()).records['local:a'][0];await store.mutate({kind:'remove',key:'local:a',expected:current});assert.equal((await new Store(dir).get()).records['local:a'],undefined)
 assert.equal(Object.keys((await store.get()).records).length,2)
})
test('bookmarks atomically retain published file on failure and enforce per-track cap',async t=>{
 const {store,dir,Store}=await setup(t);await store.mutate(add());const original=await readFile(join(dir,'track-bookmarks.json'),'utf8')
 const failed=new Store(dir,{write:async()=>{throw Error('disk')}});await assert.rejects(failed.mutate(add('local:b')),/disk/);assert.equal((await failed.get()).records['local:b'],undefined);assert.equal(await readFile(join(dir,'track-bookmarks.json'),'utf8'),original)
 for(let i=1;i<50;i++)await store.mutate(add('local:a',i*100+2000))
 await assert.rejects(store.mutate(add('local:a',9000)),/50/);await assert.rejects(store.mutate(add('local:b',-100)));await assert.rejects(store.mutate(add('local:b',10)));await assert.rejects(store.mutate(add('local:b',100,'  ')))
})
test('bookmarks corrupt file and duplicate IDs are never silently overwritten',async t=>{
 const {store,dir,Store}=await setup(t);await store.mutate(add());const data=JSON.parse(await readFile(join(dir,'track-bookmarks.json'),'utf8'));data.records['local:b']=[data.records['local:a'][0]];const text=JSON.stringify(data);await writeFile(join(dir,'track-bookmarks.json'),text);await assert.rejects(new Store(dir).get());assert.equal(await readFile(join(dir,'track-bookmarks.json'),'utf8'),text)
})
