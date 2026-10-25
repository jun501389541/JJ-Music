import assert from 'node:assert/strict'
import {test} from 'node:test'
import {mkdtemp,mkdir,readFile,writeFile,rm,readdir,symlink} from 'node:fs/promises'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {serializePlaylistBackup,PlaylistBackup} from './library/playlist-backup.js'
import {PlaylistStore} from './store/settings-store.js'
import {writeJsonAtomic} from './store/json-file.js'
const local={id:'local-id',path:'E:/missing.wav',name:'Local',singer:'',coverPath:'E:/cache.jpg',assets:{cover:[{path:'secret'}]}}
const online={id:'wy_1',source:'wy',name:'Online',singer:'Artist',meta:{songmid:'1',hash:'HASH',copyrightId:'6005754QZEE',url:'https://secret/audio',qualitys:[{type:'128k',hash:'QHASH'}]},providerData:{token:'PRIVATE'},picUrl:'data:image/png;base64,PRIVATE'}
const snapshots=[{playlist:{id:'a',name:'Same',source:'local',position:2},tracks:[local,online]},{playlist:{id:'b',name:'Same',source:'wy',sourceListId:'123',position:3},tracks:[]}]
test('versioned backup preserves track identity/order and excludes runtime URLs, assets and opaque fields',()=>{
 const before=JSON.stringify(snapshots),data=JSON.parse(serializePlaylistBackup(snapshots,'all',0))
 assert.equal(data.version,1);assert.equal(data.kind,'jj-music-playlists');assert.equal(data.playlists.length,2)
 assert.deepEqual(data.playlists[0].tracks.map(t=>[t.kind,t.id]),[['local','local-id'],['online','wy_1']]);assert.equal(data.playlists[0].tracks[1].meta.copyrightId,'6005754QZEE');assert.equal(data.playlists[0].tracks[1].meta.qualitys[0].hash,'QHASH')
 const text=JSON.stringify(data);for(const value of ['PRIVATE','https://secret','cache.jpg'])assert.equal(text.includes(value),false)
 assert.equal(JSON.stringify(snapshots),before);assert.equal(data.playlists[1].sourceListId,'123')
})
test('backup rejects malformed, excessive counts and byte overflow without silently truncating',()=>{
 assert.throws(()=>serializePlaylistBackup([{...snapshots[0],tracks:[{...online,name:null}]}],'single'))
 for(const position of [undefined,null,NaN,Infinity,-1,1.5,{url:'https://secret/audio',providerData:{token:'PRIVATE'}}])assert.throws(()=>serializePlaylistBackup([{...snapshots[0],playlist:{...snapshots[0].playlist,position}}],'single'),/顺序/)
 assert.throws(()=>serializePlaylistBackup(Array.from({length:1001},()=>snapshots[0]),'all'))
 assert.throws(()=>serializePlaylistBackup([{...snapshots[0],tracks:Array.from({length:50001},()=>online)}],'single'))
 assert.throws(()=>serializePlaylistBackup([{...snapshots[0],tracks:Array.from({length:25000},()=>({...online,name:'x'.repeat(1000)}))}],'single'),/过大|20/)
})
test('native destination is authoritative; cancel writes nothing, data directory and symlink aliases are refused',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'jj-backup-'))
 try{
  const dataDir=join(dir,'profile');await mkdir(dataDir);let selected=null,writes=0
  const service=new PlaylistBackup({dataDir,snapshot:async()=>snapshots,choose:async()=>selected,write:async()=>{writes++}})
  assert.equal(await service.export(),null);assert.equal(writes,0)
  selected=join(dataDir,'playlists.json');await assert.rejects(service.export(),/资料目录/);assert.equal(writes,0)
  await symlink(dataDir,join(dir,'alias'),'junction');selected=join(dir,'alias','backup.json');await assert.rejects(service.export(),/资料目录/)
  selected=join(dir,'music.wav');await assert.rejects(service.export(),/json/i);assert.equal(writes,0)
  selected=join(dir,'valid.json');const result=await service.export();assert.equal(result.playlists,2);assert.equal(result.tracks,2);assert.equal(writes,1)
 }finally{await rm(dir,{recursive:true,force:true})}
})
test('atomic export writes a readable file and cleans temporary files when a destination cannot be replaced',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'jj-backup-'))
 try{
  const dataDir=join(dir,'profile');await mkdir(dataDir);let selected=join(dir,'backup.json')
  const service=new PlaylistBackup({dataDir,snapshot:async()=>snapshots,choose:async()=>selected})
  await service.export();assert.equal(JSON.parse(await readFile(selected,'utf8')).playlists[0].tracks.length,2)
  selected=join(dir,'blocked.json');await mkdir(selected);await assert.rejects(service.export());assert.equal((await readdir(dir)).some(n=>n.endsWith('.tmp')),false)
 }finally{await rm(dir,{recursive:true,force:true})}
})
test('queued backup snapshot waits for durable mutation and never exports rolled-back state',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'jj-backup-'))
 try{
  let hold=false,fail=false,release,entered
  const store=new PlaylistStore(dir,{write:async(path,value)=>{if(hold){entered();await new Promise(r=>{release=r})}if(fail)throw Error('disk full');await writeJsonAtomic(path,value)}})
  const list=await store.create('Snapshot');await store.addTracks(list.id,[online])
  const ready=new Promise(r=>{entered=r});hold=true;const adding=store.addTracks(list.id,[{...online,id:'wy_2',meta:{songmid:'2'}}]);await ready
  let settled=false;const pending=store.backupSnapshot(list.id).then(value=>{settled=true;return value});await new Promise(r=>setImmediate(r));assert.equal(settled,false)
  hold=false;release();await adding;assert.equal((await pending)[0].tracks.length,2)
  fail=true;const failed=store.addTracks(list.id,[{...online,id:'wy_3'}]).catch(()=>{});await failed;assert.equal((await store.backupSnapshot(list.id))[0].tracks.length,2)
  await assert.rejects(store.backupSnapshot('unknown'));assert.equal((await store.backupSnapshot()).length,3)
 }finally{await rm(dir,{recursive:true,force:true})}
})
