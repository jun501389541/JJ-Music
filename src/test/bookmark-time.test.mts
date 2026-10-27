import {test} from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,rm,readFile} from 'node:fs/promises'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
test('bookmark time parser uses exact integer tenths and rejects precision or clock overflow',async()=>{
 const {parseBookmarkTime}=await import('./shared/track-bookmarks.js')
 assert.equal(parseBookmarkTime('0'),0);assert.equal(parseBookmarkTime('1.1'),1100);assert.equal(parseBookmarkTime(' 01:23.4 '),83400);assert.equal(parseBookmarkTime('1:02:03.4'),3723400)
 for(const input of ['', '-1','1e2','1.01','1:60','1:60:00','1::2','1: 2','NaN','9007199254740993','1'.repeat(41)])assert.throws(()=>parseBookmarkTime(input),input)
 assert.equal(parseBookmarkTime('9007199254740.9'),9007199254740900)
})
test('bookmark move CAS preserves identity, sorts, skips no-op, rejects duplicate and rolls back failed write',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'jj-bookmark-time-'));t.after(()=>rm(dir,{recursive:true,force:true}))
 const {TrackBookmarksStore}=await import('./store/track-bookmarks-store.js'),{writeJsonAtomic}=await import('./store/json-file.js');let writes=0,fail=false
 const store=new TrackBookmarksStore(dir,{write:async(path,data)=>{if(fail)throw Error('disk');writes++;await writeJsonAtomic(path,data)}})
 await store.mutate({kind:'add',key:'local:a',name:'one',positionMs:1000});await store.mutate({kind:'add',key:'local:a',name:'two',positionMs:2000});const before=await store.get(),one=before.records['local:a'][0]
 await store.mutate({kind:'move',key:'local:a',expected:one,positionMs:1000});assert.equal(writes,2);assert.equal((await store.get()).revision,before.revision)
 await assert.rejects(store.mutate({kind:'move',key:'local:a',expected:one,positionMs:2000}));assert.equal(writes,2)
 fail=true;const text=await readFile(join(dir,'track-bookmarks.json'),'utf8');await assert.rejects(store.mutate({kind:'move',key:'local:a',expected:one,positionMs:3000}),/disk/);assert.equal(await readFile(join(dir,'track-bookmarks.json'),'utf8'),text);assert.equal((await store.get()).records['local:a'][0].positionMs,1000)
 fail=false;await store.mutate({kind:'move',key:'local:a',expected:one,positionMs:3000});const after=await store.get();assert.equal(after.records['local:a'][1].id,one.id);assert.equal(after.records['local:a'][1].name,one.name);assert.equal(after.records['local:a'][1].createdAt,one.createdAt)
 await assert.rejects(store.mutate({kind:'move',key:'local:a',expected:one,positionMs:3000}),/变化/)
 const fresh=after.records['local:a'][1];await store.mutate({kind:'rename',key:'local:a',expected:fresh,name:'renamed'});await assert.rejects(store.mutate({kind:'move',key:'local:a',expected:fresh,positionMs:4000}),/变化/)
})
