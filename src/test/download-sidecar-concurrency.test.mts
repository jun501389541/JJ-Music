import assert from 'node:assert/strict'
import { test, mock } from 'node:test'
import fs from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { DownloadManager } from './downloads/download-manager.js'

const turn=()=>new Promise(resolve=>setImmediate(resolve))
const deferred=()=>{let resolve;const promise=new Promise(r=>{resolve=r});return {promise,resolve}}
function flac(){const b=Buffer.alloc(42);b.write('fLaC');b[4]=0x80;b[7]=34;b.writeUInt16BE(4096,8);b.writeUInt16BE(4096,10);b.writeBigUInt64BE((44100n<<44n)|(1n<<41n)|(15n<<36n)|44100n,18);return b}
async function fixture(work){
  const dir=await fs.mkdtemp(join(tmpdir(),'jj-sidecar-race-')),entered=deferred(),release=deferred(),trashed=[]
  const rename=fs.rename
  const hook=mock.method(fs,'rename',async(from,to)=>{
    if(String(to).startsWith(dir+sep)&&String(to).endsWith('.lrc')){entered.resolve();await release.promise}
    return rename(from,to)
  })
  syncBuiltinESMExports()
  let imports=0
  const manager=new DownloadManager(dir,{
    defaultFolder:dir,settings:()=>({downloadFolder:dir,downloadLyric:true,downloadEmbedLyric:false,downloadEmbedCover:false}),
    resolve:async()=>({url:'https://fixture.invalid/audio',quality:'flac'}),fetch:async()=>new Response(flac()),
    lyrics:async()=>({lyric:'[00:01]controlled lyric'}),cover:async()=>'',trash:async path=>{trashed.push(path)},
    importFile:async path=>{imports++;await fs.readFile(path.replace(/\.flac$/,'.lrc'));return 'local-track'}
  })
  const [id]=manager.add([{id:'wy_1',source:'wy',name:'Controlled',singer:'Fixture',meta:{songmid:'1'}}],'flac')
  try{
    await Promise.race([entered.promise,new Promise((_r,reject)=>{const timer=setTimeout(()=>reject(new Error('LRC gate not reached')),3000);entered.promise.then(()=>clearTimeout(timer))})])
    await work({manager,id,dir,release:release.resolve,imports:()=>imports,trashed})
  }finally{
    release.resolve();await manager.shutdown();hook.mock.restore();syncBuiltinESMExports()
    assert.ok(resolve(dir).startsWith(resolve(tmpdir())+sep));await fs.rm(dir,{recursive:true,force:true})
  }
}

test('manual import waits for published download sidecar and shares automatic import',async()=>{
  await fixture(async({manager,id,release,imports,dir})=>{
    const published=manager.list()[0];assert.equal(published.status,'completed');assert.equal(published.lyricPath,undefined)
    let settled=false
    const pending=manager.retryImport(id).then(()=>{settled=true},()=>{settled=true})
    // importCompleted changes this synchronously before its first filesystem
    // await, so this observation does not depend on disk speed or a delay.
    const earlyStatus=manager.list()[0].libraryStatus,earlySettled=settled
    release();await pending;await manager.shutdown()
    assert.equal(earlyStatus,'pending','scan must not start while LRC publication is blocked')
    assert.equal(earlySettled,false);assert.equal(imports(),1)
    const [saved]=JSON.parse(await fs.readFile(join(dir,'downloads.json'),'utf8'))
    assert.equal(saved.libraryStatus,'imported');assert.ok(saved.lyricPath.endsWith('.lrc'))
  })
})

test('remove waits for LRC publication and includes its recorded sidecar',async()=>{
  await fixture(async({manager,id,release,trashed})=>{
    let done=false;const pending=manager.remove(id,true).then(()=>{done=true})
    await turn();const earlyDone=done,earlyTrashed=[...trashed]
    release();await pending
    assert.equal(earlyDone,false);assert.deepEqual(earlyTrashed,[])
    assert.equal(trashed.length,2);assert.ok(trashed[1].endsWith('.lrc'));assert.equal(manager.list().length,0)
  })
})

test('shutdown waits for sidecar metadata before persisting a completed download',async()=>{
  await fixture(async({manager,release,dir})=>{
    let done=false;const pending=manager.shutdown().then(()=>{done=true})
    await turn();const earlyDone=done;release();await pending
    assert.equal(earlyDone,false)
    const [saved]=JSON.parse(await fs.readFile(join(dir,'downloads.json'),'utf8'))
    assert.equal(saved.status,'completed');assert.ok(saved.lyricPath.endsWith('.lrc'))
    assert.match(await fs.readFile(saved.lyricPath,'utf8'),/controlled lyric/)
  })
})

test('a manual import waiting for LRC cannot restart import during removal',async()=>{
  await fixture(async({manager,id,release,imports})=>{
    const retry=manager.retryImport(id).then(()=>null,error=>error)
    const removal=manager.remove(id,false)
    release();await removal
    assert.match((await retry)?.message??'',/移除|不存在/)
    assert.equal(imports(),0);assert.equal(manager.list().length,0)
  })
})

test('a manual import waiting for LRC rechecks shutdown before retrying',async()=>{
  await fixture(async({manager,id,release,imports})=>{
    const retry=manager.retryImport(id).then(()=>null,error=>error)
    const shutdown=manager.shutdown()
    release();await shutdown
    assert.match((await retry)?.message??'',/退出/)
    assert.equal(imports(),1,'only graceful automatic import runs')
  })
})
