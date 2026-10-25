import assert from 'node:assert/strict'
import {test} from 'node:test'
import {mkdtemp,writeFile,readFile,rm,mkdir} from 'node:fs/promises'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {parsePlaylistBackup,readPlaylistBackup,PlaylistRestore} from './library/playlist-restore.js'
import {serializePlaylistBackup} from './library/playlist-backup.js'
import {PlaylistStore} from './store/settings-store.js'
import {writeJsonAtomic} from './store/json-file.js'
const local={id:'same',path:'E:/missing.wav',name:'Local',singer:''}
const online={id:'same',source:'wy',name:'Online',singer:'Artist',meta:{songmid:'123',qualitys:[{type:'128k'}]}}
const snapshots=[{playlist:{id:'favorites',name:'我喜欢的',source:'local',position:1},tracks:[local,online]},{playlist:{id:'empty',name:'空',source:'local',position:3},tracks:[]}]
const document=()=>JSON.parse(serializePlaylistBackup(snapshots,'all',0))
const parse=value=>parsePlaylistBackup(Buffer.from(JSON.stringify(value)))

test('v1 export restores ordered local/online identity and strips unknown runtime fields',()=>{
 const data=document();data.playlists[0].providerData={token:'PRIVATE'};data.playlists[0].tracks[1].providerData={url:'https://secret/audio'};data.playlists[0].tracks[1].meta.url='https://secret/audio'
 const result=parse(data)
 assert.equal(result.createdAt,'1970-01-01T00:00:00.000Z');assert.deepEqual(result.snapshots[0].tracks,[local,online])
 assert.equal(JSON.stringify(result).includes('PRIVATE'),false);assert.equal(JSON.stringify(result).includes('https://secret'),false)
 assert.equal(result.snapshots[1].tracks.length,0)
 assert.equal(parsePlaylistBackup(Buffer.from('\ufeff'+JSON.stringify(data))).snapshots.length,2)
})
test('rejects wrong version, malformed kind/date/scope/counts, duplicate identities and discriminator mismatches',()=>{
 const changes=[d=>d.version=2,d=>d.kind='other',d=>d.createdAt='invalid',d=>d.scope='single',d=>d.playlists.push(d.playlists[0]),d=>d.playlists[0].tracks.push(local),d=>d.playlists[0].tracks[0].kind='online',d=>d.playlists[0].tracks[1].path='E:/extra.wav',d=>d.playlists[0].position={},d=>d.playlists=Array.from({length:1001},()=>d.playlists[0])]
 for(const change of changes){const d=document();change(d);assert.throws(()=>parse(d))}
 assert.throws(()=>parsePlaylistBackup(Buffer.alloc(20*1024*1024+1,32)))
 assert.throws(()=>parsePlaylistBackup(Buffer.from([0xff])))
 const d=document();d.playlists[0].tracks.push({...online,kind:'online',source:'tx'});assert.equal(parse(d).snapshots[0].tracks.length,3)
})
test('bounded file reader accepts JSON only and refuses directories/oversize without modifying input',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'jj-restore-'))
 try{
  const path=join(dir,'backup.json'),bytes=Buffer.from(JSON.stringify(document()));await writeFile(path,bytes)
  assert.equal((await readPlaylistBackup(path)).snapshots.length,2);assert.deepEqual(await readFile(path),bytes)
  await assert.rejects(readPlaylistBackup(join(dir,'script.js')))
  await mkdir(join(dir,'folder.json'));await assert.rejects(readPlaylistBackup(join(dir,'folder.json')))
  await writeFile(path,Buffer.alloc(20*1024*1024+1));await assert.rejects(readPlaylistBackup(path),/20MiB/)
 }finally{await rm(dir,{recursive:true,force:true})}
})
test('restore preview is readonly, single-use, expires, cancels, and retains authoritative snapshot',async()=>{
 let now=0,commits=0,seenTracks=0,path='backup.json',picked=structuredClone(parse(document()))
 const service=new PlaylistRestore({choose:async()=>path,read:async()=>picked,commit:async data=>{commits++;seenTracks=data[0].tracks.length;return {playlists:data.length,tracks:2,ids:['new']}},now:()=>now})
 const p=await service.preview();assert.equal(commits,0);assert.equal(p.playlists.length,2)
 picked.snapshots[0].tracks=[];await service.apply(p.token);assert.equal(commits,1);assert.equal(seenTracks,2);await assert.rejects(service.apply(p.token))
 const stale=await service.preview();now=600001;await assert.rejects(service.apply(stale.token));assert.equal(commits,1)
 path=null;assert.equal(await service.preview(),null)
 path='backup.json';const discarded=await service.preview();service.discard(discarded.token);await assert.rejects(service.apply(discarded.token))
})
test('late picker cannot replace a newer preview, and failed commit consumes only its lease',async()=>{
 let release,first=true,fail=true
 const service=new PlaylistRestore({choose:()=>first?(first=false,new Promise(r=>release=r)):Promise.resolve('new.json'),read:async()=>parse(document()),commit:async()=>{if(fail)throw Error('disk full');return{playlists:2,tracks:2,ids:['a','b']}}})
 const old=service.preview(),current=await service.preview();release('old.json');assert.equal(await old,null)
 await assert.rejects(service.apply(current.token),/disk full/);await assert.rejects(service.apply(current.token),/预览/)
 fail=false;const retry=await service.preview();assert.equal((await service.apply(retry.token)).playlists,2)
})
test('single atomic restore appends new IDs, preserves system lists and rolls back entire failed batch',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'jj-restore-'))
 try{
  let fail=false,writes=0
  const store=new PlaylistStore(dir,{write:async(path,value)=>{writes++;if(fail)throw Error('disk full');await writeJsonAtomic(path,value)}})
  await store.addTracks('favorites',[local]);const before=await store.list(),disk=await readFile(join(dir,'playlists.json'),'utf8'),count=writes
  fail=true;await assert.rejects(store.restoreBackup(snapshots),/disk full/);assert.deepEqual(await store.list(),before);assert.equal(await readFile(join(dir,'playlists.json'),'utf8'),disk)
  fail=false;const result=await store.restoreBackup(snapshots);assert.equal(writes,count+2);assert.equal(result.ids.length,2)
  assert.ok(result.ids.every(id=>!['favorites','empty','default'].includes(id)))
  assert.deepEqual(await store.getItems('favorites'),[local]);assert.deepEqual(await store.getItems(result.ids[0]),[local,online])
  assert.equal((await store.list()).find(p=>p.id===result.ids[0]).name,'我喜欢的（恢复）')
  const reloaded=new PlaylistStore(dir);assert.equal((await reloaded.list()).length,4);assert.deepEqual(await reloaded.getItems(result.ids[0]),[local,online])
 }finally{await rm(dir,{recursive:true,force:true})}
})

test('restore waits behind durable writes and subsequent rename sees the whole restored batch',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'jj-restore-'))
 try{
  let release,entered,hold=false
  const store=new PlaylistStore(dir,{write:async(path,value)=>{if(hold){hold=false;entered();await new Promise(r=>release=r)}await writeJsonAtomic(path,value)}})
  const original=await store.create('Original')
  const ready=new Promise(r=>entered=r);hold=true
  const adding=store.addTracks(original.id,[local]);await ready
  let settled=false;const restored=store.restoreBackup(snapshots).then(r=>{settled=true;return r})
  const renamed=store.rename(original.id,'Renamed')
  await new Promise(r=>setImmediate(r));assert.equal(settled,false)
  release();await adding;const result=await restored;await renamed
  assert.equal((await store.list()).length,5);assert.equal((await store.list()).find(p=>p.id===original.id).name,'Renamed')
  assert.deepEqual(await store.getItems(original.id),[local]);assert.deepEqual(await store.getItems(result.ids[0]),[local,online])
 }finally{await rm(dir,{recursive:true,force:true})}
})
test('maximum valid playlist name remains exportable after restore without truncation',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'jj-restore-'))
 try{
  const store=new PlaylistStore(dir),name='长'.repeat(4096)
  const result=await store.restoreBackup([{...snapshots[1],playlist:{...snapshots[1].playlist,name}}])
  const backup=await store.backupSnapshot(result.ids[0])
  assert.ok(backup[0].playlist.name.includes(name));assert.doesNotThrow(()=>serializePlaylistBackup(backup,'single'))
 }finally{await rm(dir,{recursive:true,force:true})}
})

test('restored raw-ID collisions remain independent through reorder and single-entry remove',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'jj-restore-'))
 try{
  const store=new PlaylistStore(dir),{ids:[id]}=await store.restoreBackup(snapshots)
  await store.reorder(id,['online:wy:same','local:same'],true)
  assert.deepEqual(await store.getItems(id),[online,local])
  assert.equal(await store.removeTracks(id,['online:wy:same'],true),1);assert.deepEqual(await store.getItems(id),[local])
  const {ids:[legacy]}=await store.restoreBackup(snapshots)
  await assert.rejects(store.reorder(legacy,['same','same']),/身份/)
  await assert.rejects(store.removeTracks(legacy,['same']),/身份/)
  assert.deepEqual(await store.getItems(legacy),[local,online])
 }finally{await rm(dir,{recursive:true,force:true})}
})
test('copying restored identities into another list does not collapse local and online songs',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'jj-restore-'))
 try{
  const store=new PlaylistStore(dir)
  assert.equal(await store.addTracks('favorites',[local]),1)
  assert.equal(await store.addTracks('favorites',[online]),1)
  assert.deepEqual(await store.getItems('favorites'),[local,online])
  assert.equal(await store.addTracks('favorites',[local,online]),0)
 }finally{await rm(dir,{recursive:true,force:true})}
})
