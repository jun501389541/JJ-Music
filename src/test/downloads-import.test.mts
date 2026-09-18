import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, readFile, readdir, writeFile, copyFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseFile } from 'music-metadata'
import { DownloadManager, mergeLyrics, safeName, audioExtension, publishExclusive } from './downloads/download-manager.js'
import { readBounded } from './online/read-bounded.js'
import { canWriteTags, writeTags } from './library/tag-writer.js'
import { importPlaylist, parsePlaylistId, playlistTrack } from './online/playlist-import.js'
import { SourceEngine } from './sources/source-engine.js'
import { parseLyrics } from './renderer/audio/lyrics.js'

const track={id:'wy_1',source:'wy',name:'Test/Title',singer:'Singer',meta:{songmid:'1'}}
const lyrics={lyric:'[00:01.00]原文\n[00:02.00]次行',tlyric:'[00:01.00]翻译',rlyric:'[00:01.00]roman'}
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aVtUAAAAASUVORK5CYII=','base64')
function flac() {
  const b=Buffer.alloc(42);b.write('fLaC');b[4]=0x80;b[7]=34
  b.writeUInt16BE(4096,8);b.writeUInt16BE(4096,10)
  b.writeBigUInt64BE((44100n<<44n)|(1n<<41n)|(15n<<36n)|44100n,18)
  return Buffer.concat([b,Buffer.from('audio-frame-preserved')])
}
async function setup(overrides={}) {
  const dir=await mkdtemp(join(tmpdir(),'jj-download-'))
  const manager=new DownloadManager(dir,{settings:()=>({downloadFolder:dir,downloadLyric:true,downloadEmbedLyric:true,downloadTranslation:true,downloadRomanization:true,downloadEmbedCover:true}),defaultFolder:dir,resolve:async()=>({url:'https://audio.test/a',quality:'flac'}),lyrics:async()=>lyrics,cover:async()=> 'https://audio.test/cover',fetch:async url=>new Response(url.endsWith('/cover')?png:flac()),...overrides})
  return {manager,dir}
}
async function settled(manager,id) {
  for(let i=0;i<300;i++){const t=manager.list().find(t=>t.id===id);if(['failed','completed','cancelled'].includes(t.status)){await new Promise(r=>setTimeout(r,30));return t}await new Promise(r=>setTimeout(r,10))}
  throw Error('did not settle')
}
test('download writes audio, merged lyrics and embedded FLAC cover; duplicate names never overwrite',async()=>{
  const {manager,dir}=await setup()
  const [id]=manager.add([track],'flac');const result=await settled(manager,id)
  assert.equal(result.status,'completed',result.error);assert.deepEqual(result.warnings,[])
  const meta=await parseFile(result.path)
  assert.equal(meta.common.title,track.name);assert.equal(meta.common.picture[0].format,'image/png')
  assert.ok(Buffer.from(meta.common.picture[0].data).equals(png))
  assert.match(JSON.stringify(meta.common.lyrics),/roman/);assert.match(JSON.stringify(meta.common.lyrics),/翻译/)
  assert.match(parseLyrics(mergeLyrics(lyrics,true,true)).lines[0].text,/原文\n翻译\nroman/)
  assert.ok((await readFile(result.path)).subarray(-21).equals(flac().subarray(-21)))
  const lrc=await readFile(result.path.replace(/\.flac$/,'.lrc'),'utf8');assert.match(lrc,/原文/)
  const [next]=manager.add([track],'flac');const second=await settled(manager,next);assert.equal(second.status,'completed');assert.notEqual(result.path,second.path)
  assert.ok(!(await readdir(dir)).some(f=>f.startsWith('.jj-')))
  // Verify actual persistence/restart semantics separately using the saved directory.
  const reload=new DownloadManager(dir,{});await reload.load();assert.equal(reload.list().length,2)
})
test('bad responses fail cleanly and strict quality cannot silently downgrade',async()=>{
  const {manager,dir}=await setup({fetch:async()=>new Response('{"error":"expired"}')})
  const [id]=manager.add([track],'flac');assert.equal((await settled(manager,id)).status,'failed')
  assert.ok(!(await readdir(dir)).some(f=>/\.(part|flac)$/.test(f)))
  const engine=new SourceEngine({list:()=>[{meta:{id:'api1',enabled:true}}]},'unused')
  // Route the engine at a fake running script so `getMusicUrl` reaches the
  // quality ladder. `providersFor` is derived from the started runtimes, so a
  // minimal runtime stub is what makes the platform resolve.
  engine.getSources=()=>[{id:'wy',qualitys:['128k','flac']}]
  engine.runtimes=new Map([['api1',{api:{meta:{id:'api1',name:'测试源'}},dead:false,sources:[{id:'wy',type:'music',actions:['musicUrl'],qualitys:['128k','flac']}],pending:new Map(),nextId:1,logs:[],scratchDir:''}]]);
  engine.rebuildOwners()
  const qualities=[];engine.requestFrom=async(_api,_s,_a,args)=>{qualities.push(args.type);throw Error('unavailable')}
  await assert.rejects(()=>engine.getMusicUrl('wy',track,'flac',true));assert.deepEqual(qualities,['flac'])
})
test('MP3 embeds lyrics and cover and optional lyric downloads can be disabled',async()=>{
  const frame=Buffer.alloc(417);frame.set([0xff,0xfb,0x90,0x64])
  const audio=Buffer.concat(Array.from({length:40},()=>frame))
  const {manager}=await setup({resolve:async()=>({url:'https://audio.test/a',quality:'128k'}),fetch:async url=>new Response(url.endsWith('/cover')?png:audio)})
  const [id]=manager.add([track],'128k');const result=await settled(manager,id)
  assert.equal(result.status,'completed',result.error);assert.deepEqual(result.warnings,[])
  const meta=await parseFile(result.path);assert.equal(meta.common.title,track.name);assert.ok(meta.common.picture?.length);assert.match(JSON.stringify(meta.common.lyrics),/roman/)
})
test('cancel before URL resolution never starts transfer; lyrics options and safe names',async()=>{
  let resolve,fetches=0
  const {manager}=await setup({resolve:()=>new Promise(r=>resolve=r),fetch:async()=>{fetches++;return new Response(flac())}})
  const [id]=manager.add([track],'flac');await new Promise(r=>setTimeout(r,20));manager.cancel(id);resolve({url:'https://audio.test/a',quality:'flac'})
  await new Promise(r=>setTimeout(r,50));assert.equal(manager.list()[0].status,'cancelled');assert.equal(fetches,0)
  assert.equal(safeName('../CON?'), '.._CON_');assert.equal(safeName('CON'),'_CON')
  assert.equal(mergeLyrics(lyrics,false,false),lyrics.lyric)
  assert.equal(mergeLyrics(lyrics,true,true).split('\n')[1],'[00:01.00]翻译')
})
test('playlist links validate platform and preserve provider identifiers',()=>{
  assert.equal(parsePlaylistId('wy','https://music.163.com/#/playlist?id=123'),'123')
  assert.equal(parsePlaylistId('tx','https://y.qq.com/n/ryqq/playlist/123'),'123')
  assert.equal(parsePlaylistId('kw','https://www.kuwo.cn/playlist_detail/123'),'123')
  assert.equal(parsePlaylistId('kg','https://www.kugou.com/yy/special/single/123.html'),'123')
  assert.throws(()=>parsePlaylistId('wy','https://evil.test/?id=123'))
  const song=playlistTrack('tx',{mid:'abc',id:42,title:'Song',album:{mid:'al'},file:{media_mid:'media'},singer:[{name:'Artist'}]})
  assert.equal(song.meta.songmid,'abc');assert.equal(song.meta.strMediaMid,'media')
})
test('playlist pagination, detail completion, deduplication and partial imports are explicit',async()=>{
  const calls=[]
  const http=async url=>{calls.push(url);return new Response(JSON.stringify(url.includes('/song/detail')?{songs:[{id:2,name:'B',ar:[]}]}:{code:200,playlist:{name:'List',trackCount:3,trackIds:[{id:1},{id:2},{id:3}],tracks:[{id:1,name:'A',ar:[]}]}}))}
  const result=await importPlaylist('wy','123',http);assert.equal(result.tracks.length,2);assert.equal(calls.length,2);assert.equal(result.warnings.length,1)
  let page=0
  const kw=await importPlaylist('kw','123',async()=>new Response(JSON.stringify({result:'ok',title:'KW',total:2,musiclist:[{id:++page,name:'Song',artist:'A'}]})))
  assert.equal(kw.tracks.length,2);assert.equal(page,2)
  await assert.rejects(()=>importPlaylist('tx','123',async()=>new Response(JSON.stringify({code:1}))))
})

test('filesystem fallback preserves existing files and container names are accurate',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'jj-publish-')),src=join(dir,'source'),target=join(dir,'target')
  await writeFile(src,'audio')
  const fs={link:async()=>{throw Object.assign(Error('unsupported'),{code:'ENOTSUP'})},copyFile}
  await publishExclusive(src,target,fs);assert.equal(await readFile(target,'utf8'),'audio')
  await writeFile(src,'replacement');await assert.rejects(()=>publishExclusive(src,target,fs));assert.equal(await readFile(target,'utf8'),'audio')
  assert.equal(audioExtension('MPEG-4','AAC'),'.m4a');assert.equal(audioExtension('ADTS/MPEG-4','AAC'),'.aac')
  assert.equal(audioExtension('ADTS','AAC'),'.aac');assert.equal(audioExtension('MPEG','MPEG 1 Layer 3'),'.mp3')
})
test('shutdown releases hung resolvers, stops queued work and flushes task state',async()=>{
  const {manager,dir}=await setup({resolve:()=>new Promise(()=>{})})
  manager.add([track,{...track,id:'wy_2'},{...track,id:'wy_3'}],'flac')
  await new Promise(r=>setTimeout(r,20))
  await manager.shutdown()
  assert.ok(manager.list().every(t=>t.status==='failed'))
  const saved=JSON.parse(await readFile(join(dir,'downloads.json'),'utf8'));assert.equal(saved.length,3);assert.ok(saved.every(t=>t.status==='failed'))
  assert.throws(()=>manager.add([track],'flac'))
})
test('stream limits cancel readers and invalid FLAC metadata is never rewritten',async()=>{
  let cancelled=false
  await assert.rejects(()=>readBounded(new Response(new ReadableStream({start(c){c.enqueue(new Uint8Array(100))},cancel(){cancelled=true}})),10))
  assert.equal(cancelled,true);assert.equal(canWriteTags('test.ogg'),false)
  const dir=await mkdtemp(join(tmpdir(),'jj-bad-flac-')),file=join(dir,'bad.flac'),bytes=Buffer.from('fLaC\x80\x00\xff\xffbroken')
  await writeFile(file,bytes);await assert.rejects(()=>writeTags(file,{title:'changed'},{skipBackup:true}));assert.deepEqual(await readFile(file),bytes)
})
