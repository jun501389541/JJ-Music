import assert from 'node:assert/strict'
import {test} from 'node:test'
import {mkdtemp,readFile,rm,writeFile} from 'node:fs/promises'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {PlaylistStore} from './store/settings-store.js'
import {
 PLAYLIST_BULK_RENAME_MAX_BYTES,
 PLAYLIST_BULK_RENAME_MAX_LISTS,
 PLAYLIST_BULK_RENAME_MAX_NAME_CHARS,
 assertPlaylistBulkRenameSelection,
 parsePlaylistBulkRenameTransform,
 transformPlaylistName,
 playlistBulkRenameRowBytes
} from './shared/playlist-bulk-rename.js'

test('selection accepts only distinct ordinary playlist ids within the batch cap',()=>{
 assert.equal(PLAYLIST_BULK_RENAME_MAX_LISTS,1000)
 assert.doesNotThrow(()=>assertPlaylistBulkRenameSelection(['one','two']))
 for(const ids of [[],['default'],['favorites'],['one','one'],[''],['x'.repeat(257)],['bad\0id'],Array.from({length:1001},(_,i)=>String(i))])assert.throws(()=>assertPlaylistBulkRenameSelection(ids))
 assert.throws(()=>assertPlaylistBulkRenameSelection({length:1}))
})

test('affix mode preserves original text and composes prefix and suffix',()=>{
 const transform=parsePlaylistBulkRenameTransform({mode:'affix',prefix:'  [Mix] ',suffix:' (2026) '})
 assert.equal(transformPlaylistName(' Song ',transform), '  [Mix]  Song  (2026) ')
 assert.equal(transformPlaylistName('Song',parsePlaylistBulkRenameTransform({mode:'affix',prefix:'',suffix:'!'})),'Song!')
 assert.throws(()=>parsePlaylistBulkRenameTransform({mode:'affix',prefix:'',suffix:''}))
})

test('replace mode matches all literal case-sensitive occurrences and keeps replacement tokens literal',()=>{
 const transform=parsePlaylistBulkRenameTransform({mode:'replace',find:'mix',replacement:'$&'})
 assert.equal(transformPlaylistName('mix MIX remix',transform),'$& MIX re$&')
 assert.equal(transformPlaylistName('aaaa',parsePlaylistBulkRenameTransform({mode:'replace',find:'aa',replacement:'b'})),'bb')
})

test('empty replacement is allowed but empty search and blank final names are rejected',()=>{
 assert.equal(transformPlaylistName('remove this word',parsePlaylistBulkRenameTransform({mode:'replace',find:'remove ',replacement:''})),'this word')
 assert.throws(()=>parsePlaylistBulkRenameTransform({mode:'replace',find:'',replacement:'x'}))
 assert.throws(()=>transformPlaylistName('only',parsePlaylistBulkRenameTransform({mode:'replace',find:'only',replacement:'  '})),/空白|名称/)
 assert.throws(()=>transformPlaylistName('   ',parsePlaylistBulkRenameTransform({mode:'affix',prefix:'x',suffix:''})),/空白|名称/)
})

test('overlong affix and replacement results fail before building output strings',()=>{
 const original='x'.repeat(PLAYLIST_BULK_RENAME_MAX_NAME_CHARS)
 assert.throws(()=>transformPlaylistName(original,parsePlaylistBulkRenameTransform({mode:'affix',prefix:'y',suffix:''})),/4096|超长/)
 const explosive=parsePlaylistBulkRenameTransform({mode:'replace',find:'x',replacement:'z'.repeat(256)})
 assert.throws(()=>transformPlaylistName(original,explosive),/4096|超长/)
})

test('names and transform fragments are bounded and reject NUL and extra fields',()=>{
 assert.equal(PLAYLIST_BULK_RENAME_MAX_NAME_CHARS,4096)
 assert.throws(()=>parsePlaylistBulkRenameTransform({mode:'affix',prefix:'x'.repeat(257),suffix:''}))
 assert.throws(()=>parsePlaylistBulkRenameTransform({mode:'affix',prefix:'\0',suffix:''}))
 assert.throws(()=>parsePlaylistBulkRenameTransform({mode:'affix',prefix:'x',suffix:'',find:'hidden'}))
 assert.throws(()=>parsePlaylistBulkRenameTransform({mode:'replace',find:'x'.repeat(257),replacement:''}))
 assert.throws(()=>parsePlaylistBulkRenameTransform({mode:'replace',find:'x',replacement:'\0'}))
 assert.throws(()=>parsePlaylistBulkRenameTransform({mode:'other',find:'x',replacement:'y'}))
 assert.throws(()=>transformPlaylistName('x'.repeat(4097),parsePlaylistBulkRenameTransform({mode:'affix',prefix:'y',suffix:''})))
})

test('candidate row byte accounting includes exact UTF-8 JSON representation',()=>{
 const row={id:'列表-1',oldName:'旧名',newName:'新名'}
 assert.equal(playlistBulkRenameRowBytes(row),Buffer.byteLength(JSON.stringify(row),'utf8')+1)
 assert.ok(playlistBulkRenameRowBytes(row)<PLAYLIST_BULK_RENAME_MAX_BYTES)
})

const local=(id,name)=>({id,path:`E:/generated/${id}.wav`,name,singer:'Singer'})
async function makeStore(t,write){
 const dir=await mkdtemp(join(tmpdir(),'jj-bulk-rename-'));t.after(()=>rm(dir,{recursive:true,force:true}))
 const store=new PlaylistStore(dir,{write:write??((path,value)=>writeFile(path,JSON.stringify(value)))})
 const first=await store.create('First'),second=await store.create('Second')
 await store.addTracks(first.id,[local('a','A'),local('b','B')])
 await store.addTracks(second.id,[local('c','C')])
 return{dir,store,first,second}
}

test('store takes a consistent name-only snapshot and rejects invalid selection',async t=>{
 const f=await makeStore(t),snapshot=await f.store.renameSnapshot([f.second.id,f.first.id])
 assert.deepEqual(snapshot,[{id:f.second.id,name:'Second'},{id:f.first.id,name:'First'}])
 for(const ids of [[],['default'],['favorites'],[f.first.id,f.first.id],[f.first.id,'missing']])await assert.rejects(f.store.renameSnapshot(ids))
})

test('store renames multiple names once and preserves concurrent track and playlist metadata changes',async t=>{
 let writes=0
 const f=await makeStore(t,async(path,value)=>{writes++;await writeFile(path,JSON.stringify(value))}),expected=await f.store.renameSnapshot([f.first.id,f.second.id])
 await f.store.setCover(f.first.id,'E:/generated/cover.webp')
 await f.store.addTracks(f.second.id,[local('d','Concurrent track')])
 const before=writes,changed=await f.store.renameMany(expected,[{id:f.first.id,name:'Renamed First'},{id:f.second.id,name:'Renamed Second'}])
 assert.equal(changed,2);assert.equal(writes,before+1)
 const lists=await f.store.list(),first=lists.find(x=>x.id===f.first.id),second=lists.find(x=>x.id===f.second.id)
 assert.equal(first?.name,'Renamed First');assert.equal(first?.coverPath,'E:/generated/cover.webp')
 assert.equal(second?.name,'Renamed Second');assert.deepEqual((await f.store.getItems(f.second.id)).map(x=>x.id),['c','d'])
 const reloaded=new PlaylistStore(f.dir)
 assert.equal((await reloaded.list()).find(x=>x.id===f.first.id)?.name,'Renamed First')
})

test('store rejects a stale selected name atomically and does not block unrelated changes',async t=>{
 const f=await makeStore(t),expected=await f.store.renameSnapshot([f.first.id,f.second.id])
 await f.store.rename(f.second.id,'Changed elsewhere')
 await assert.rejects(f.store.renameMany(expected,[{id:f.first.id,name:'Would change'},{id:f.second.id,name:'New name'}]),/已变更/)
 assert.equal((await f.store.list()).find(x=>x.id===f.first.id)?.name,'First')
 assert.equal((await f.store.list()).find(x=>x.id===f.second.id)?.name,'Changed elsewhere')
})

test('store rolls back a failed batch and continues the queued mutation',async t=>{
 let fail=false
 const f=await makeStore(t,async(path,value)=>{if(fail){fail=false;throw Error('disk full')}await writeFile(path,JSON.stringify(value))})
 const expected=await f.store.renameSnapshot([f.first.id,f.second.id]),disk=await readFile(join(f.dir,'playlists.json'),'utf8');fail=true
 const applying=f.store.renameMany(expected,[{id:f.first.id,name:'Failed rename'}]),later=f.store.rename(f.second.id,'Queued rename')
 await assert.rejects(applying,/disk full/);await later
 const lists=await f.store.list()
 assert.equal(lists.find(x=>x.id===f.first.id)?.name,'First');assert.equal(lists.find(x=>x.id===f.second.id)?.name,'Queued rename')
 assert.notEqual(await readFile(join(f.dir,'playlists.json'),'utf8'),disk)
 assert.equal((await new PlaylistStore(f.dir).list()).find(x=>x.id===f.first.id)?.name,'First')
})

test('store refuses no-op and malformed changes, system ids, missing ids, and oversized name snapshots',async t=>{
 const f=await makeStore(t),expected=await f.store.renameSnapshot([f.first.id])
 await assert.rejects(f.store.renameMany(expected,[]))
 await assert.rejects(f.store.renameMany(expected,[{id:'default',name:'Changed'}]))
 await assert.rejects(f.store.renameMany(expected,[{id:'missing',name:'Changed'}]))
 await assert.rejects(f.store.renameMany(expected,[{id:f.first.id,name:'\0'}]))
 const dir=await mkdtemp(join(tmpdir(),'jj-bulk-rename-large-'));t.after(()=>rm(dir,{recursive:true,force:true}))
 const ids=Array.from({length:1000},(_,i)=>`list_${i}`),name='a'+'\u000b'.repeat(PLAYLIST_BULK_RENAME_MAX_NAME_CHARS-1)
 await writeFile(join(dir,'playlists.json'),JSON.stringify({version:1,playlists:ids.map((id,position)=>({id,name,source:'local',position})),items:{}}))
 await assert.rejects(new PlaylistStore(dir).renameSnapshot(ids),/20MiB|上限|过大/)
})
