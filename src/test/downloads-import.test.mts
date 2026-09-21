import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, readFile, readdir, writeFile, copyFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseFile } from 'music-metadata'
import { DownloadManager, mergeLyrics, safeName, audioExtension, publishExclusive } from './downloads/download-manager.js'
import { readBounded } from './online/read-bounded.js'
import { canWriteTags, writeTags } from './library/tag-writer.js'
import { applyImportOrder, fetchImportCover, importPlaylist, normalizeCover, parsePlaylistId, playlistTrack } from './online/playlist-import.js'
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
  assert.equal(parsePlaylistId('mg','https://music.migu.cn/v5/#/playlist?playlistId=123'),'123')
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
test('咪咕歌单按封面与全部分页导入，音质与版权标识取自搜索适配器同一映射',async()=>{
  const seen=[]
  const http=async url=>{seen.push(String(url));const u=new URL(url),page=Number(u.searchParams.get('pageNo')||0)
    if(page)return new Response(JSON.stringify({code:'000000',data:{totalCount:51,songList:Array.from({length:page===1?50:1},(_,i)=>({songId:`s${page}-${i}`,songName:`Song ${page}-${i}`,duration:266,copyrightId:`c${page}-${i}`,singerList:[{name:'A'}],img2:'/cover'}))}}))
    return new Response(JSON.stringify({code:'000000',data:{title:'咪咕歌单',musicNum:51,imgItem:{img:'//d.musicapp.migu.cn/pic'}}}))}
  const result=await importPlaylist('mg','213040094',http)
  assert.equal(result.tracks.length,51);assert.equal(result.total,51)
  assert.equal(result.coverUrl,'https://d.musicapp.migu.cn/pic')
  // 歌单端点在 app.c 而不是搜索用的 app.u，写错主机名只会得到一份空数据，所以逐条钉住。
  assert.deepEqual([...new Set(seen.map(u=>new URL(u).host))],['app.c.nf.migu.cn'])
  assert.equal(seen.filter(u=>u.includes('song/v2.0')).length,2)
  assert.equal(seen.filter(u=>u.includes('resource/playlist/v2.0')).length,1)
  const [first]=result.tracks;assert.equal(first.id,'mg_s1-0');assert.equal(first.picUrl,'https://d.musicapp.migu.cn/cover')
  assert.equal(first.meta.copyrightId,'c1-0');assert.deepEqual(first.meta.qualitys.map(q=>q.type),['128k'])
  // 既无 songId 也无 copyrightId 的行无法解析播放地址，必须丢掉而不是变成 `mg_`
  assert.equal(playlistTrack('mg',{songName:'无 ID'}),null)
})
test('歌单封面按平台字段抓取，模板与裸路径都被补成可抓取的地址',async()=>{
  const covers=async(source,payload)=>(await importPlaylist(source,'123',async()=>new Response(JSON.stringify(payload)))).coverUrl
  assert.equal(await covers('wy',{code:200,playlist:{name:'W',trackCount:1,tracks:[{id:1,name:'A',ar:[],album:{}}],coverUrl:'https://p.music.163.com/x.jpg'}}),'https://p.music.163.com/x.jpg')
  assert.equal(await covers('tx',{code:0,cdlist:[{dissname:'T',total_song_num:1,songlist:[{mid:'a',title:'A',singer:[]}],imgurl:'//p.qpic.cn/y.jpg'}]}),'https://p.qpic.cn/y.jpg')
  // 酷狗给的是带 `{size}` 占位符的模板，酷我给裸路径，两者都不能原样丢给 <img>
  assert.equal(await covers('kg',{status:1,data:{specialname:'K',total:1,imgurl:'https://imge.kugou.com/{size}/{id}.jpg',info:[{hash:'h',songname:'A',singername:'S'}]}}),'https://imge.kugou.com/600/{id}.jpg')
  assert.equal(await covers('kw',{result:'ok',title:'P',total:1,pic:'/imgs/z.jpg',musiclist:[{id:1,name:'A',artist:'S'}]}),'https://img4.kuwo.cn/imgs/z.jpg')
  // 咪咕的封面同样是裸路径，域名结尾少一个斜杠就会拼出 `migu.cndata/...`
  assert.equal(normalizeCover('mg','/data/oss/resource/x.webp'),'https://d.musicapp.migu.cn/data/oss/resource/x.webp')
  assert.equal(await covers('wy',{code:200,playlist:{name:'W',trackCount:1,tracks:[{id:1,name:'A',ar:[],album:{}}]}}),undefined)
  assert.deepEqual(['wy','tx','kg','kw','mg'].map(s=>normalizeCover(s,'   ')),['','','','',''])
})
test('待导入列表只接受提交过的顺序与子集，封面抓取带平台 Referer 且受大小限制',async()=>{
  const row=id=>({id,name:'Song '+id,singer:'A',source:'mg',meta:{songmid:id}})
  const preview={name:'P',source:'mg',sourceListId:'1',coverUrl:'https://d.musicapp.migu.cn/pic',tracks:[row('mg_a'),row('mg_b')]}
  assert.deepEqual(applyImportOrder(preview,['mg_b','mg_a']).map(t=>t.id),['mg_b','mg_a'])
  // 重复与不存在的 id 来路不明（过期预览、篡改），丢弃而不是照着建条目
  assert.deepEqual(applyImportOrder(preview,['mg_a','mg_a','nope']).map(t=>t.id),['mg_a'])
  assert.deepEqual(applyImportOrder(preview,[1,null,'mg_b',{}]).map(t=>t.id),['mg_b'])
  assert.equal(applyImportOrder(preview,undefined).length,2)
  assert.deepEqual(applyImportOrder(preview,[]),[])
  const fetched=[],written=[]
  const get=async(url,opts)=>{fetched.push({url,...opts});return {body:Buffer.from('jpegbytes'),contentType:'image/jpeg'}}
  const saved=await fetchImportCover(preview,async(data,format)=>{written.push([data.length,format]);return '/covers/x.jpg'},get)
  assert.equal(saved,'/covers/x.jpg')
  assert.equal(fetched[0].url,'https://d.musicapp.migu.cn/pic')
  assert.equal(fetched[0].headers.Referer,'https://music.migu.cn/')
  assert.equal(fetched[0].maxBytes,8*1024*1024)
  // 落盘按 content-type 判格式，而不是信 URL 后缀（咪咕的 .webp 实际发的是 jpeg）
  assert.deepEqual(written,[[9,'image/jpeg']])
  assert.equal(await fetchImportCover({...preview,coverUrl:''},async()=>{throw Error('无封面不该写盘')},async()=>{throw Error('无封面不该抓')})  ,undefined)
  // 抓取失败要抛出去，让调用方标成「封面获取失败」而不是静默算成功
  await assert.rejects(()=>fetchImportCover(preview,async()=>'/covers/x.jpg',async()=>{throw Error('HTTP 403')}))
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
test('stream limits cancel readers and invalid FLAC metadata is never rewritten',async()=>{  let cancelled=false
  await assert.rejects(()=>readBounded(new Response(new ReadableStream({start(c){c.enqueue(new Uint8Array(100))},cancel(){cancelled=true}})),10))
  assert.equal(cancelled,true);assert.equal(canWriteTags('test.ogg'),false)
  const dir=await mkdtemp(join(tmpdir(),'jj-bad-flac-')),file=join(dir,'bad.flac'),bytes=Buffer.from('fLaC\x80\x00\xff\xffbroken')
  await writeFile(file,bytes);await assert.rejects(()=>writeTags(file,{title:'changed'},{skipBackup:true}));assert.deepEqual(await readFile(file),bytes)
})

/* ------------------------------------------------------------------ *
 * 断点续传 (需求 4).
 *
 * A hand-rolled response is used instead of `Response` so a body can stop
 * mid-stream without the whole request failing, and so the request headers the
 * manager sends are observable — the resume is only real if the second attempt
 * asks for the right byte offset.
 * ------------------------------------------------------------------ */
function fakeResponse(status, headers, chunks) {
  return {
    ok: status >= 200 && status < 400, status,
    headers: new Headers(headers),
    body: (async function* () { for (const chunk of chunks) yield chunk })()
  }
}

async function resumeSetup(fetch) {
  const dir = await mkdtemp(join(tmpdir(), 'jj-resume-'))
  const deps = {
    settings: () => ({ downloadFolder: dir }), defaultFolder: dir,
    resolve: async () => ({ url: 'https://audio.test/a', quality: 'flac' }),
    lyrics: async () => lyrics, cover: async () => '', fetch
  }
  return { dir, manager: new DownloadManager(dir, deps), deps }
}

test('an interrupted download resumes with Range and finishes from the byte it stopped at',async()=>{
  const body=flac(),half=Math.floor(body.length/2)
  const requests=[]
  let attempt=0
  const {dir,manager}=await resumeSetup(async(url,init)=>{
    requests.push(init?.headers??{})
    attempt+=1
    if(attempt===1) return fakeResponse(200,{'content-length':String(body.length),etag:'"v1"'},[body.subarray(0,half)])
    return fakeResponse(206,{'content-range':`bytes ${half}-${body.length-1}/${body.length}`},[body.subarray(half)])
  })
  const [id]=manager.add([track],'flac')
  const first=await settled(manager,id)
  assert.equal(first.status,'failed',first.error)
  assert.match(first.error,/未完成/,`the failure has to say it stopped early: ${first.error}`)
  assert.equal(first.received,half,'the partial byte count is what a resume is built on')
  const parts=(await readdir(dir)).filter(f=>f.endsWith('.part'))
  assert.equal(parts.length,1,'the partial file must survive the failure, or there is nothing to resume')
  assert.equal((await readFile(join(dir,parts[0]))).length,half)

  manager.retry(id)
  const second=await settled(manager,id)
  assert.equal(second.status,'completed',second.error)
  assert.deepEqual(requests[1],{Range:`bytes=${half}-`,'If-Range':'"v1"'},'the retry asks for the rest, conditionally')
  assert.equal(second.received,body.length)
  // The published file is larger than the body (tags and cover get embedded), so
  // what proves the resume is the byte count plus the tail — and the tail is
  // precisely the half that only arrived on the second attempt.
  assert.ok((await readFile(second.path)).subarray(-21).equals(body.subarray(-21)),'the resumed half is really in the file')
  assert.equal((await readdir(dir)).filter(f=>f.startsWith('.jj-')).length,0,'no leftovers after publishing')
})

test('a restart after the app closed resumes too, because the task record survives',async()=>{
  const body=flac(),half=Math.floor(body.length/2)
  const {dir,manager,deps}=await resumeSetup(async()=>fakeResponse(200,{'content-length':String(body.length)},[body.subarray(0,half)]))
  const [id]=manager.add([track],'flac')
  await settled(manager,id)
  // A new process: same folder, same task file. `load()` marks it failed but the
  // bytes on disk are what make 重试 continue rather than restart.
  const reloaded=new DownloadManager(dir,{...deps,fetch:async(url,init)=>{
    if(init?.headers?.Range===`bytes=${half}-`) return fakeResponse(206,{'content-range':`bytes ${half}-${body.length-1}/${body.length}`},[body.subarray(half)])
    return fakeResponse(200,{'content-length':String(body.length)},[body.subarray(0,half)])
  }})
  await reloaded.load()
  const restored=reloaded.list().find(t=>t.id===id)
  assert.equal(restored.status,'failed','a task interrupted by shutdown is not silently still running')
  assert.match(restored.error,/续传|重试/)
  reloaded.retry(id)
  const done=await settled(reloaded,id)
  assert.equal(done.status,'completed',done.error)
  assert.equal(done.received,body.length,'the reloaded manager continued from the bytes on disk')
  assert.ok((await readFile(done.path)).subarray(-21).equals(body.subarray(-21)))
})

test('a server that ignores Range restarts the file instead of gluing two copies',async()=>{
  const body=flac(),half=Math.floor(body.length/2)
  let attempt=0
  const {manager}=await resumeSetup(async()=>{
    attempt+=1
    // 200 with the whole body, even though a Range was offered: the only safe
    // reading is "start over", and appending here would corrupt the file.
    if(attempt===1) return fakeResponse(200,{'content-length':String(body.length)},[body.subarray(0,half)])
    return fakeResponse(200,{'content-length':String(body.length)},[body])
  })
  const [id]=manager.add([track],'flac')
  await settled(manager,id)
  manager.retry(id)
  const done=await settled(manager,id)
  assert.equal(done.status,'completed',done.error)
  assert.equal(done.received,body.length,'not half + whole')
  assert.ok((await readFile(done.path)).subarray(-21).equals(body.subarray(-21)))
})
