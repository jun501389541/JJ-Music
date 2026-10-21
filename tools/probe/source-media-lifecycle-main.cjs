/** Main-process half of source-media-lifecycle.mjs; synthetic streams only. */
const {app,protocol,BrowserWindow,session}=require('electron')
const assert=require('node:assert/strict')
const {join}=require('node:path')
const {pathToFileURL}=require('node:url')
const {writeFileSync}=require('node:fs')
if(!process.env.JJ_NATIVE_PROFILE||!process.env.JJ_NATIVE_OUTPUT)throw new Error('Use the isolated lifecycle launcher')
app.setPath('userData',process.env.JJ_NATIVE_PROFILE)
app.commandLine.appendSwitch('disable-background-networking')
protocol.registerSchemesAsPrivileged([{scheme:'jjstream',privileges:{standard:true,secure:true,supportFetchAPI:true,stream:true,corsEnabled:true,bypassCSP:false}}])
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms))
async function wait(predicate,label){for(let i=0;i<150;i++){if(await predicate())return;await sleep(20)}throw new Error(`Timed out: ${label}`)}
function wavPrefix(){
  const sampleRate=8000,dataBytes=sampleRate*2*5,header=Buffer.alloc(44)
  header.write('RIFF',0);header.writeUInt32LE(36+dataBytes,4);header.write('WAVE',8)
  header.write('fmt ',12);header.writeUInt32LE(16,16);header.writeUInt16LE(1,20);header.writeUInt16LE(1,22)
  header.writeUInt32LE(sampleRate,24);header.writeUInt32LE(sampleRate*2,28);header.writeUInt16LE(2,32);header.writeUInt16LE(16,34)
  header.write('data',36);header.writeUInt32LE(dataBytes,40)
  return {bytes:new Uint8Array(Buffer.concat([header,Buffer.alloc(64*1024)])),length:44+dataBytes}
}
const reports=[],states=new Map()
let blocked=0,window,proxy
const report=(status,error)=>writeFileSync(process.env.JJ_NATIVE_OUTPUT,JSON.stringify({runId:process.env.JJ_NATIVE_RUN_ID,status,electron:process.versions.electron,blockedExternalRequests:blocked,reports,...(error?{error}: {})},null,2)+'\n')
report('running')
const watchdog=setTimeout(()=>{report('failed','Native lifecycle watchdog exceeded 30 seconds');app.exit(2)},30000)
app.whenReady().then(async()=>{
  const root=process.cwd()
  const {SourceMediaProxy}=await import(pathToFileURL(join(root,'out/test/online/source-media-proxy.js')).href)
  const {registerSourceMediaProtocol}=await import(pathToFileURL(join(root,'out/test/online/source-media-protocol.js')).href)
  globalThis.fetch=()=>{throw new Error('External fetch forbidden in synthetic probe')}
  session.defaultSession.webRequest.onBeforeRequest({urls:['http://*/*','https://*/*']},(_details,callback)=>{blocked++;callback({cancel:true})})
  proxy=new SourceMediaProxy({headerTimeoutMs:10000,streamIdleTimeoutMs:10000,fetchResponse:(url,options)=>{
    const key=new URL(url).pathname+':'+(options.init.headers.Range??'')
    const state=states.get(key)??states.get(new URL(url).pathname+':media');assert.ok(state,`Unexpected upstream ${key}`)
    assert.equal(state.signal,undefined,'each fixture fetched once');state.signal=options.init.signal
    const response=new Response(new ReadableStream({start(controller){state.body=controller;if(!state.pending)controller.enqueue(state.firstChunk??new Uint8Array([1,2,3]))},pull(){state.pulls=(state.pulls??0)+1},cancel(){state.cancelled++}}),{headers:{'Content-Type':state.contentType??'audio/mpeg',...(state.contentLength?{'Content-Length':String(state.contentLength)}:{})}})
    if(!state.pending)return Promise.resolve(response)
    return new Promise(resolve=>{state.release=()=>resolve(response)})
  }})
  registerSourceMediaProtocol(protocol,session.defaultSession.webRequest,proxy)
  window=new BrowserWindow({show:false,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false}})
  await window.loadURL('data:text/html,<title>Offline source media lifecycle</title>')
  const js=source=>window.webContents.executeJavaScript(source)
  async function start(name,url,range,method='GET'){
    await js(`globalThis.jobs??={};jobs[${JSON.stringify(name)}]={control:new AbortController(),received:0,result:'pending'};{const job=jobs[${JSON.stringify(name)}];fetch(${JSON.stringify(url)},{method:${JSON.stringify(method)},signal:job.control.signal,headers:${JSON.stringify(range?{Range:range}:{})}}).then(async response=>{job.status=response.status;if(response.body){const reader=response.body.getReader();for(;;){const item=await reader.read();if(item.done)break;job.received+=item.value.length}}job.result='done'}).catch(error=>{job.result=error.name})}void 0`)
  }
  async function result(name){return js(`(({received,result,status})=>({received,result,status}))(jobs[${JSON.stringify(name)}])`)}
  function fixture(name,pending,range=''){
    const state={pending,cancelled:0};states.set('/'+name+':'+range,state);return state
  }
  function token(name){return proxy.audioUrl('https://fixture.invalid/'+name,{providerId:name,providerVersion:'1',sourceId:'wy'})}
  for(const pending of [true,false]){
    const name=pending?'cancel-headers':'cancel-body',state=fixture(name,pending)
    await start(name,token(name));await wait(()=>state.signal,'upstream entered')
    if(!pending)await wait(async()=>(await result(name)).received===3,'body delivered')
    await js(`jobs[${JSON.stringify(name)}].control.abort();void 0`)
    await wait(()=>state.signal.aborted,'upstream aborted after Chromium cancellation')
    state.release?.();await wait(()=>state.cancelled===1,'late or established body cancelled')
    await wait(async()=>(await result(name)).result==='AbortError','renderer cancelled')
    assert.equal(proxy.active.size,0)
    reports.push({case:name,upstreamAborted:true,bodyCancelled:state.cancelled,renderer:await result(name)})
  }
  // Same-token concurrent requests must have separate cancellation identities.
  {
    const name='range-isolation',first=fixture(name,true,'bytes=0-2'),second=fixture(name,true,'bytes=3-5'),url=token(name)
    await start('range-a',url,'bytes=0-2');await wait(()=>first.signal,'first Range entered')
    await start('range-b',url,'bytes=3-5');await wait(()=>second.signal,'second Range entered')
    await js("jobs['range-a'].control.abort();void 0");await wait(()=>first.signal.aborted,'first Range aborted')
    assert.equal(second.signal.aborted,false)
    first.release();second.release();second.body.enqueue(new Uint8Array([4,5,6]));second.body.close()
    await wait(()=>first.cancelled===1,'first Range late body cancelled')
    await wait(async()=>(await result('range-b')).result==='done','other Range completed')
    assert.equal((await result('range-b')).received,3);assert.equal(second.signal.aborted,false)
    reports.push({case:name,cancelledFirst:true,otherCompleted:true})
  }
  for(const pending of [true,false]){
    const name=pending?'revoke-headers':'revoke-body',state=fixture(name,pending)
    await start(name,token(name));await wait(()=>state.signal,'revoke upstream entered')
    if(!pending)await wait(async()=>(await result(name)).received===3,'revoke body delivered')
    proxy.revokeProvider(name);assert.equal(state.signal.aborted,true)
    state.release?.();await wait(()=>state.cancelled===1,'revoked body cancelled')
    await wait(async()=>(await result(name)).result!=='pending','revoked renderer settled')
    const rendered=await result(name)
    if(pending)assert.equal(rendered.status,410)
    else assert.equal(rendered.result,'TypeError')
    assert.equal(proxy.active.size,0)
    reports.push({case:name,upstreamAborted:true,bodyCancelled:state.cancelled,renderer:rendered})
  }
  // Exercise the player's actual HTMLAudioElement transport, before headers.
  {
    const name='audio-element-cancel',state=fixture(name,true,'media'),url=token(name)
    await js(`globalThis.audio=new Audio();audio.muted=true;audio.preload='auto';audio.crossOrigin='anonymous';audio.src=${JSON.stringify(url)};audio.load();void 0`)
    await wait(()=>state.signal,'audio element entered upstream')
    await js("audio.removeAttribute('src');audio.load();void 0")
    await wait(()=>state.signal.aborted,'audio element released pending request')
    state.release();await wait(()=>state.cancelled===1,'audio late body cancelled')
    assert.equal(proxy.active.size,0)
    reports.push({case:name,upstreamAborted:true,bodyCancelled:state.cancelled})
  }
  // A progress event plus upstream reads establish body loading, even while WAV metadata awaits more data.
  {
    const name='audio-element-body-cancel',state=fixture(name,false,'media'),url=token(name),wav=wavPrefix()
    state.contentType='audio/wav';state.contentLength=wav.length;state.firstChunk=wav.bytes
    await js(`globalThis.audioProbe={progress:0,error:null};globalThis.audio=new Audio();audio.muted=true;audio.preload='auto';audio.crossOrigin='anonymous';audio.addEventListener('progress',()=>{audioProbe.progress++});audio.addEventListener('error',()=>{audioProbe.error=audio.error?.code??'unknown'});audio.src=${JSON.stringify(url)};audio.load();void 0`)
    await wait(()=>state.signal,'audio body entered upstream')
    await wait(async()=>state.pulls>=2&&(await js('audioProbe.progress>0')),'audio body read and progress')
    const media=await js('({progress:audioProbe.progress,error:audioProbe.error,readyState:audio.readyState,networkState:audio.networkState})')
    assert.equal(media.error,null)
    assert.equal(media.networkState,2,'the media element must still be loading')
    assert.equal(state.signal.aborted,false,'the request must still be active before removing src')
    assert.equal(state.cancelled,0)
    await js('audio.pause();audio.removeAttribute("src");audio.load();void 0')
    await wait(()=>state.signal.aborted,'audio element cancelled established body')
    await wait(()=>state.cancelled===1,'audio established body cancelled once')
    await wait(()=>proxy.active.size===0,'audio established request released')
    reports.push({case:name,progressEvents:media.progress,upstreamPulls:state.pulls,readyState:media.readyState,networkState:media.networkState,upstreamAborted:true,bodyCancelled:state.cancelled})
  }
  for(const method of ['HEAD','OPTIONS']){
    const name=method.toLowerCase(),state=fixture(name,false)
    await start(name,token(name),undefined,method)
    await wait(async()=>(await result(name)).result==='done',`${method} completed`)
    const rendered=await result(name)
    assert.equal(rendered.status,method==='HEAD'?200:204)
    assert.equal(rendered.received,0)
    if(method==='HEAD'){assert.equal(state.signal.aborted,true);assert.equal(state.cancelled,1)}
    else assert.equal(state.signal,undefined,'OPTIONS must not fetch upstream')
    reports.push({case:method,renderer:rendered})
  }
  assert.equal(blocked,0);report('passed');console.log(`PASS: ${reports.length} native Electron lifecycle cases; zero external requests`)
  window.destroy();clearTimeout(watchdog);app.exit(0)
}).catch(error=>{console.error(error);report('failed',error.stack??String(error));window?.destroy();clearTimeout(watchdog);app.exit(1)})
