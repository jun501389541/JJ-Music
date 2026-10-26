import assert from 'node:assert/strict'
import {test} from 'node:test'
import {mkdtemp,rm,writeFile} from 'node:fs/promises'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {PlaylistStore} from './store/settings-store.js'
import {PlaylistBulkRename} from './library/playlist-bulk-rename.js'
import {PLAYLIST_BULK_RENAME_MAX_BYTES} from './shared/playlist-bulk-rename.js'

const local=(id,name)=>({id,path:`E:/generated/${id}.wav`,name,singer:'Singer'})
async function setup(t){
 const dir=await mkdtemp(join(tmpdir(),'jj-bulk-rename-service-'));t.after(()=>rm(dir,{recursive:true,force:true}))
 const store=new PlaylistStore(dir,{write:(path,value)=>writeFile(path,JSON.stringify(value))})
 const first=await store.create('First'),second=await store.create('Second')
 await store.addTracks(first.id,[local('a','A'),local('b','B')]);await store.addTracks(second.id,[local('c','C')])
 return{dir,store,first,second}
}
const service=(playlists,options={})=>new PlaylistBulkRename({playlists,...options})

test('preview follows supplied visible order and apply only renames selected playlists',async t=>{
 const f=await setup(t),before=await f.store.list(),rename=service(f.store),preview=await rename.preview([f.second.id,f.first.id],{mode:'affix',prefix:'[Mix] ',suffix:''})
 assert.deepEqual(preview.rows.map(row=>row.id),[f.second.id,f.first.id]);assert.deepEqual(preview.rows.map(row=>row.newName),['[Mix] Second','[Mix] First'])
 assert.equal(preview.selected,2);assert.equal(preview.renamed,2);assert.equal(preview.unchanged,0)
 assert.deepEqual(await f.store.getItems(f.first.id),[local('a','A'),local('b','B')])
 assert.deepEqual(await rename.apply(preview.token),{renamed:2})
 const after=await f.store.list()
 assert.deepEqual(after.map(list=>list.id),before.map(list=>list.id));assert.deepEqual(after.map(list=>list.position),before.map(list=>list.position))
 assert.equal(after.find(list=>list.id===f.first.id)?.name,'[Mix] First');assert.equal(after.find(list=>list.id===f.second.id)?.name,'[Mix] Second')
 await assert.rejects(rename.apply(preview.token),/失效/)
})

test('no-op previews show unchanged rows but cannot be applied',async t=>{
 const f=await setup(t),rename=service(f.store),preview=await rename.preview([f.first.id],{mode:'replace',find:'not found',replacement:'x'})
 assert.equal(preview.renamed,0);assert.equal(preview.unchanged,1);assert.equal(preview.rows[0].newName,'First')
 await assert.rejects(rename.apply(preview.token),/没有可变更/)
})

test('new preview replaces a lease and stale discard cannot remove it',async t=>{
 const f=await setup(t),rename=service(f.store),first=await rename.preview([f.first.id],{mode:'affix',prefix:'A',suffix:''}),second=await rename.preview([f.second.id],{mode:'affix',prefix:'B',suffix:''})
 rename.discard(first.token);await assert.rejects(rename.apply(first.token),/失效/)
 assert.deepEqual(await rename.apply(second.token),{renamed:1})
})

test('expiry, clock rollback, clear and maintenance invalidate candidates',async t=>{
 const f=await setup(t);let now=100,ready=true
 const rename=service(f.store,{now:()=>now,assertReady:()=>{if(!ready)throw Error('maintenance')}})
 const expired=await rename.preview([f.first.id],{mode:'affix',prefix:'A',suffix:''});now+=600000;await assert.rejects(rename.apply(expired.token),/过期|失效/)
 const rollback=await rename.preview([f.first.id],{mode:'affix',prefix:'B',suffix:''});now--;await assert.rejects(rename.apply(rollback.token),/过期|失效/)
 const cleared=await rename.preview([f.first.id],{mode:'affix',prefix:'C',suffix:''});rename.clear();await assert.rejects(rename.apply(cleared.token),/失效/)
 const blocked=await rename.preview([f.first.id],{mode:'affix',prefix:'D',suffix:''});ready=false;await assert.rejects(rename.apply(blocked.token),/maintenance/)
 await assert.rejects(rename.preview([f.first.id],{mode:'affix',prefix:'E',suffix:''}),/maintenance/)
})

test('cancellation and a superseding request cannot register a late candidate',async t=>{
 const f=await setup(t);let release,entered,hold=true
 const gate=new Promise(resolve=>{entered=resolve}),wait=new Promise(resolve=>{release=resolve})
 const wrapped={renameSnapshot:async ids=>{if(hold){hold=false;entered();await wait}return f.store.renameSnapshot(ids)},renameMany:(...args)=>f.store.renameMany(...args)}
 const rename=service(wrapped),controller=new AbortController(),pending=rename.preview([f.first.id],{mode:'affix',prefix:'Late',suffix:''},controller.signal),rejected=assert.rejects(pending,/取消|失效/)
 await gate
 const latest=await rename.preview([f.second.id],{mode:'affix',prefix:'Current',suffix:''})
 controller.abort();release();await rejected;assert.deepEqual(await rename.apply(latest.token),{renamed:1})
})

test('expanded output is rejected incrementally before a candidate is retained',async()=>{
 const rows=Array.from({length:1000},(_,index)=>({id:`list_${index}`,name:'a'.repeat(4096)}))
 const fake={renameSnapshot:async()=>rows,renameMany:async()=>{throw Error('must not apply')}}
 const rename=service(fake)
 await assert.rejects(rename.preview(rows.map(row=>row.id),{mode:'replace',find:'a',replacement:'\u0001'}),/20MiB|上限|过大/)
 assert.ok(PLAYLIST_BULK_RENAME_MAX_BYTES===20*1024*1024)
})
