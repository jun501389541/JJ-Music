/** Controlled upstream faults/generated sources; production Electron/IPC/stores. */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { createServer } from 'node:net'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
const root=resolve(dirname(fileURLToPath(import.meta.url)),'../..')
const output=join(root,'.cache/or8-controlled-interactions');await mkdir(output,{recursive:true})
const runId=randomUUID(),profile=await mkdtemp(join(output,'profile-'))
const report={runId,status:'running',checks:[],scope:'controlled 503 and generated source/media fixtures; no real upstream failure or listening claim',profileRemoved:false}
const save=()=>Promise.all(['report.json',`${runId}-report.json`].map(name=>writeFile(join(output,name),JSON.stringify(report,null,2))))
const check=(label,value)=>{assert.ok(value,label);report.checks.push(label)}
const pause=ms=>new Promise(r=>setTimeout(r,ms))
let child,ws,evaluate
try {
  await mkdir(join(profile,'cache/online/v1'),{recursive:true})
  await writeFile(join(profile,'settings.json'),JSON.stringify({showSearchHotWords:false,onlineReliability:true,onlineDiagnostics:true,onlineLyricSource:'off',onlineLyricFallback:false,libraryFolders:[],minimizeToTray:false,volume:0,shortAudioTransitions:false}))
  const cached={status:'available',entity:{id:'7',name:'OR8缓存艺术家'},tracks:[{id:'wy_101',name:'OR8保留曲目',singer:'OR8合成',source:'wy',meta:{songmid:'101',qualitys:[{type:'128k'}]}}],page:1,total:1,hasMore:false}
  const now=Date.now(),key=JSON.stringify([1,'artistDetail','wy','7:1','zh-CN','wy-1','',''])
  await writeFile(join(profile,'cache/online/v1/artistDetail.json'),JSON.stringify({schema:1,entries:[[key,{data:cached,fetchedAt:now-7_200_000,expiresAt:now-3_600_000,staleUntil:now+86_400_000,persist:true}]]}))
  const wav=Buffer.alloc(44+32_000);wav.write('RIFF');wav.writeUInt32LE(wav.length-8,4);wav.write('WAVEfmt ',8);wav.writeUInt32LE(16,16);wav.writeUInt16LE(1,20);wav.writeUInt16LE(1,22);wav.writeUInt32LE(8000,24);wav.writeUInt32LE(16000,28);wav.writeUInt16LE(2,32);wav.writeUInt16LE(16,34);wav.write('data',36);wav.writeUInt32LE(32000,40)
  const metrics=join(profile,'metrics.json'),guard=join(profile,'main.cjs')
  await writeFile(guard,`
const {app,BrowserWindow,session,ipcMain}=require('electron'),fs=require('node:fs');
app.setAppPath(${JSON.stringify(root)});
const metrics={faults:0,media:0,blocked:0};const save=()=>fs.writeFileSync(${JSON.stringify(metrics)},JSON.stringify(metrics));save();
const original=globalThis.fetch;globalThis.fetch=async(raw,options)=>{const url=new URL(typeof raw==='string'||raw instanceof URL?String(raw):raw.url);
if(url.hostname==='music.163.com'&&url.pathname==='/api/v1/artist/songs'){metrics.faults++;save();return new Response('controlled unavailable',{status:503});}
if(url.hostname==='music.163.com'&&/^\\/or8-fixture-[AB]\\.wav$/.test(url.pathname)){metrics.media++;save();return new Response(Buffer.from(${JSON.stringify(wav.toString('base64'))},'base64'),{headers:{'Content-Type':'audio/wav','Content-Length':${JSON.stringify(String(wav.length))}}});}
if(!['127.0.0.1','localhost','[::1]'].includes(url.hostname)){metrics.blocked++;save();throw Error('Controlled probe blocked external request');}return original(raw,options);};
const handle=ipcMain.handle.bind(ipcMain);ipcMain.handle=(channel,listener)=>handle(channel,channel==='sources:verify-platform'?async()=>({status:'unknown',checkedAt:Date.now(),message:'Controlled fixture skips automatic platform probes'}):listener);
BrowserWindow.prototype.show=function(){};app.on('browser-window-created',(_event,window)=>{window.webContents.setAudioMuted(true);window.webContents.setBackgroundThrottling(false);});
app.whenReady().then(()=>session.defaultSession.webRequest.onBeforeRequest({urls:['http://*/*','https://*/*']},(details,callback)=>callback({cancel:!['127.0.0.1','localhost','[::1]'].includes(new URL(details.url).hostname)})));
import(${JSON.stringify(pathToFileURL(join(root,'out/main/index.js')).href)}).catch(()=>app.exit(1));
`)
  const port=await new Promise((done,reject)=>{const server=createServer();server.once('error',reject);server.listen(0,'127.0.0.1',()=>{const p=server.address().port;server.close(()=>done(p))})})
  child=spawn(join(root,'node_modules/electron/dist/electron.exe'),[guard,`--user-data-dir=${profile}`],{cwd:root,windowsHide:true,stdio:'ignore',env:{...process.env,ELECTRON_RUN_AS_NODE:undefined,NODE_OPTIONS:undefined,JJ_ALLOW_DEBUG_PORT:'1',JJ_DEBUG_PORT:String(port)}})
  let target
  for(let n=0;n<120;n++){if(child.exitCode!==null)throw Error('Owned Electron exited');try{target=(await(await fetch(`http://127.0.0.1:${port}/json/list`,{signal:AbortSignal.timeout(1000)})).json()).find(t=>t.type==='page'&&!t.url.includes('desktop-lyrics'))}catch{}if(target?.webSocketDebuggerUrl)break;await pause(250)}
  assert.ok(target?.webSocketDebuggerUrl,'owned renderer ready');ws=new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((done,reject)=>{ws.addEventListener('open',done,{once:true});ws.addEventListener('error',reject,{once:true})})
  const pending=new Map();let seq=0
  ws.addEventListener('message',event=>{const msg=JSON.parse(event.data),job=pending.get(msg.id);if(!job)return;pending.delete(msg.id);clearTimeout(job.timer);msg.error?job.reject(Error('CDP rejected')):job.done(msg.result)})
  ws.addEventListener('close',()=>{for(const job of pending.values()){clearTimeout(job.timer);job.reject(Error('CDP closed'))}pending.clear()})
  evaluate=async expression=>{const result=await new Promise((done,reject)=>{const id=++seq,timer=setTimeout(()=>{pending.delete(id);reject(Error('CDP timeout'))},20_000);pending.set(id,{done,reject,timer});ws.send(JSON.stringify({id,method:'Runtime.evaluate',params:{expression:`(async()=>(${expression}))()`,awaitPromise:true,returnByValue:true,userGesture:true}}))});if(result.exceptionDetails)throw Error(result.exceptionDetails.exception?.description??'Renderer evaluation failed');return result.result?.value}
  const wait=async(expression,label)=>{for(let n=0;n<120;n++){if(await evaluate(expression))return;await pause(100)}throw Error(`Timed out: ${label}`)}
  const stores='document.querySelector("#app").__vue_app__.config.globalProperties.$pinia._s'
  await wait('!!window.jj && !!document.querySelector("#app").__vue_app__','preload')
  check('owned profile selected',resolve((await evaluate('window.jj.data.location()')).dir)===profile)
  await evaluate('location.hash="/online/artist/wy/7"')
  await wait('document.body.innerText.includes("资料较旧，已保留上次成功结果")','stale cache feedback')
  check('503 preserves visible cached title and track',await evaluate('document.body.innerText.includes("OR8缓存艺术家") && document.body.innerText.includes("OR8保留曲目")'))
  const stale=await evaluate('window.jj.onlineDetails.artistPage("wy","7",1)')
  check('IPC identifies stale data and service failure',stale.reliability.cacheState==='stale'&&!!stale.reliability.error)
  check('cached items are unchanged',JSON.stringify(stale.tracks)===JSON.stringify(cached.tracks))
  const imported=[]
  for(const label of ['A','B']){
    const script=`/*!\n * @name OR8生成绑定夹具${label}\n * @version 1.0.0\n */\nconst {on,send,EVENT_NAMES}=lx;on(EVENT_NAMES.request,()=>Promise.resolve('https://music.163.com/or8-fixture-${label}.wav'));send(EVENT_NAMES.inited,{status:true,sources:{wy:{name:'wy',type:'music',actions:['musicUrl'],qualitys:['128k']}}});`
    const api=await evaluate(`window.jj.sources.import(${JSON.stringify(script)},${JSON.stringify(`or8-${label}.js`)})`)
    const enabled=await evaluate(`window.jj.sources.toggle(${JSON.stringify(api.id)},true)`);check(`generated source ${label} starts`,enabled.started===true)
    imported.push(api)
  }
  const track=(api,id)=>({id:`wy_${id}`,source:'wy',name:'OR8绑定曲目',singer:'OR8合成',interval:'00:02',providerId:api.stableId??api.id,meta:{songmid:String(id),qualitys:[{type:'128k'}]}})
  const first=track(imported[0],101),second=track(imported[1],102)
  for(const [label,row]of[['A',first],['B',second]]){const result=await evaluate(`window.jj.music.url('wy',${JSON.stringify(row)},'128k',true)`);check(`requested provider ${label} retained`,result.providerId===row.providerId)}
  await evaluate(`(()=>{const p=(${stores}).get('player');p.setVolume(0);p.setQuality('128k');p.setTransitionsEnabled(false);void p.playQueue(${JSON.stringify([first,second])},0);return true})()`)
  await wait(`(${stores}).get('player').playing && (${stores}).get('player').resolvedResource?.providerId===${JSON.stringify(first.providerId)}`,'provider A playback')
  await evaluate(`(()=>{const next=document.querySelector('.playbar button[aria-label="下一首"]'),previous=document.querySelector('.playbar button[aria-label="上一首"]');next.click();previous.click();next.click();return true})()`)
  await wait(`(${stores}).get('player').currentTrack?.id===${JSON.stringify(second.id)} && (${stores}).get('player').resolvedResource?.providerId===${JSON.stringify(second.providerId)} && (${stores}).get('player').playing`,'rapid selection retains B')
  check('rapid DOM controls retain final track and bound provider',true)
  const rebound={...first,providerId:second.providerId}
  await evaluate(`(()=>{void (${stores}).get('player').playQueue(${JSON.stringify([rebound])},0);return true})()`)
  await wait(`(${stores}).get('player').currentTrack?.id===${JSON.stringify(first.id)} && (${stores}).get('player').resolvedResource?.providerId===${JSON.stringify(second.providerId)} && (${stores}).get('player').playing`,'same identity rebound to B')
  check('same song with explicit provider change does not reuse A lease',true)
  await evaluate(`window.jj.sources.toggle(${JSON.stringify(imported[0].id)},false)`)
  const refused=await evaluate(`window.jj.music.url('wy',${JSON.stringify(first)},'128k',true).then(()=>false,()=>true)`)
  check('disabled bound A fails while B remains available',refused&&(await evaluate(`window.jj.music.url('wy',${JSON.stringify(second)},'128k',true)`)).providerId===second.providerId)
  report.bindingUi='Provider bindings exercised through production entry metadata and IPC/store; no per-provider selector exists. Rapid transport uses real DOM buttons.'
  for(const api of imported)await evaluate(`window.jj.sources.toggle(${JSON.stringify(api.id)},false)`)
  const observed=JSON.parse(await readFile(metrics,'utf8'));check('controlled fault actually reached upstream boundary',observed.faults>0);check('generated media actually loaded',observed.media>0);check('no unexpected Node upstream request',observed.blocked===0);report.metrics=observed
  report.status='passed'
} catch(error){report.status='failed';report.error=error.message;process.exitCode=1}
finally{
  if(child&&child.exitCode===null){const exited=new Promise(done=>child.once('exit',done));try{await evaluate?.('window.jj.window.close()')}catch{}await Promise.race([exited,pause(20_000)]);report.normalExit=child.exitCode===0;if(child.exitCode===null){report.cleanupBlocked=true;process.exitCode=1}}
  ws?.close()
  if(!child||child.exitCode!==null){const actual=await realpath(profile),parent=await realpath(output);assert.equal(dirname(actual),parent);assert.ok(actual.includes('profile-'));await rm(actual,{recursive:true,force:false});report.profileRemoved=true}
  await save();console.log(JSON.stringify(report))
}
