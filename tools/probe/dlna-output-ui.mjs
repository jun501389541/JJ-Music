/**
 * Packaged Electron smoke, owned empty profile only. Never clicks Discover.
 * Usage: node tools/probe/dlna-output-ui.mjs --app=.cache/dlna-release/win-unpacked
 * Browser initialization failed with EPERM in this task; explicit native Electron
 * CDP fallback was authorized. No production APIs are replaced or mocked.
 */
import assert from 'node:assert/strict'
import {spawn,spawnSync} from 'node:child_process'
import {createServer} from 'node:net'
import {cpSync,existsSync,mkdirSync,mkdtempSync,rmSync,writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {dirname,join,relative,resolve,sep} from 'node:path'
import {fileURLToPath} from 'node:url'

const root=resolve(dirname(fileURLToPath(import.meta.url)),'../..')
const argument=process.argv.find(a=>a.startsWith('--app='))?.slice(6)
if(!argument)throw new Error('Explicit --app=PACKAGED_DIRECTORY is required; no default release is used')
const source=resolve(root,argument)
assert(existsSync(join(source,'JJ Music.exe')),'Missing explicitly selected packaged executable')
const owned=mkdtempSync(join(tmpdir(),'jj-dlna-output-smoke-'))
const copied=join(owned,'app'),profile=join(owned,'empty-profile')
const artifacts=mkdtempSync((mkdirSync(join(root,'.cache','dlna-ui-smoke'),{recursive:true}),join(root,'.cache','dlna-ui-smoke','run-')))
const exe=join(copied,'JJ Music.exe')
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms))
let child,ws,spawnError,discoveryCalls=0,sequence=0,stopConfirmed=false
const pending=new Map(),consoleErrors=[]
const result={fallback:'Browser initialization EPERM; authorized native Electron CDP fallback',source,artifacts,checks:[],discoveryCalls:0}
function ownedPath(path){const r=relative(owned,path);assert(r&&!r.startsWith(`..${sep}`)&&r!=='..'&&!r.includes(':'))}
function check(condition,label){assert(condition,label);result.checks.push(label);console.log(`PASS ${label}`)}
async function send(method,params={}){
  if(!ws||ws.readyState!==WebSocket.OPEN)throw new Error('CDP socket unavailable')
  const id=++sequence
  return new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>{pending.delete(id);reject(new Error(`CDP timeout ${method}`))},10000)
    pending.set(id,{resolve:value=>{clearTimeout(timer);resolve(value)},reject:error=>{clearTimeout(timer);reject(error)}})
    ws.send(JSON.stringify({id,method,params}))
  })
}
async function evaluate(expression,returnByValue=true){
  const response=await send('Runtime.evaluate',{expression,returnByValue,awaitPromise:true})
  if(response.exceptionDetails)throw new Error(response.exceptionDetails.exception?.description??response.exceptionDetails.text)
  return returnByValue?response.result.value:response.result
}
async function waitFor(expression){
  const deadline=Date.now()+15000
  while(Date.now()<deadline){if(await evaluate(expression))return;await wait(100)}
  throw new Error(`UI condition timed out: ${expression}`)
}
try{
  ownedPath(copied);ownedPath(profile)
  cpSync(source,copied,{recursive:true});mkdirSync(profile)
  // Isolate data-location pointers as well as Chromium preferences.
  for(const name of ['data-location.json','data-location.pointer.json'])if(existsSync(join(copied,name)))throw new Error(`Packaged copy contains unexpected data pointer ${name}`)
  const port=await new Promise((resolve,reject)=>{const server=createServer();server.on('error',reject);server.listen(0,'127.0.0.1',()=>{const port=server.address().port;server.close(()=>resolve(port))})})
  child=spawn(exe,[`--user-data-dir=${profile}`],{cwd:copied,stdio:'ignore',windowsHide:true,env:{...process.env,JJ_DEBUG_PORT:String(port),JJ_ALLOW_DEBUG_PORT:'1',ELECTRON_RUN_AS_NODE:undefined}})
  child.on('error',error=>{spawnError=error})
  let target
  const deadline=Date.now()+45000
  while(Date.now()<deadline){
    if(spawnError)throw spawnError
    try{const response=await fetch(`http://127.0.0.1:${port}/json/list`,{signal:AbortSignal.timeout(1000)});target=(await response.json()).find(t=>t.type==='page'&&t.webSocketDebuggerUrl&&t.url.startsWith('file:'));if(target)break}catch{}
    if(child.exitCode!==null)throw new Error(`Owned app exited ${child.exitCode}`)
    await wait(250)
  }
  assert(target,'No packaged renderer CDP target')
  ws=new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((resolve,reject)=>{ws.addEventListener('open',resolve,{once:true});ws.addEventListener('error',reject,{once:true})})
  ws.addEventListener('message',event=>{
    const message=JSON.parse(event.data)
    if(message.id){const request=pending.get(message.id);if(request){pending.delete(message.id);message.error?request.reject(new Error(message.error.message)):request.resolve(message.result)}}
    if(message.method==='Runtime.exceptionThrown')consoleErrors.push(message.params.exceptionDetails.text)
    if(message.method==='Runtime.consoleAPICalled'&&message.params.type==='error')consoleErrors.push(message.params.args.map(a=>a.value??a.description??'').join(' '))
    if(message.method==='Debugger.paused'){
      // A call breakpoint observes the real preload method without replacing it.
      // Stop unexpected calls before they can perform real network discovery.
      discoveryCalls++;void send('Runtime.terminateExecution').catch(()=>{});void send('Debugger.resume').catch(()=>{})
    }
  })
  await send('Runtime.enable');await send('Debugger.enable')
  await waitFor('typeof window.jj?.dlna?.discover === "function" && !!document.querySelector(".output-trigger")')
  const callable=await evaluate('window.jj.dlna.discover',false)
  assert(callable.objectId,'Real DLNA discovery bridge function missing')
  await send('Debugger.setBreakpointOnFunctionCall',{objectId:callable.objectId})
  check(await evaluate('document.title.includes("JJ") && document.body.innerText.length > 30'),'packaged app identity and nonblank screen')
  check(await evaluate('!document.querySelector(".output-panel")'),'output panel initially closed')
  await evaluate('document.querySelector(".output-trigger").focus()')
  await send('Input.dispatchKeyEvent',{type:'keyDown',key:' ',code:'Space',windowsVirtualKeyCode:32,nativeVirtualKeyCode:32})
  await send('Input.dispatchKeyEvent',{type:'keyUp',key:' ',code:'Space',windowsVirtualKeyCode:32,nativeVirtualKeyCode:32})
  await wait(150)
  check(await evaluate('!!document.querySelector(".output-panel")'),'Space activates the focused output button')
  await waitFor('!!document.querySelector(".output-panel select")')
  await send('Input.dispatchKeyEvent',{type:'keyDown',key:'Tab',code:'Tab',windowsVirtualKeyCode:9,nativeVirtualKeyCode:9})
  await send('Input.dispatchKeyEvent',{type:'keyUp',key:'Tab',code:'Tab',windowsVirtualKeyCode:9,nativeVirtualKeyCode:9})
  check(await evaluate('document.activeElement===document.querySelector(".output-panel select")'),'Tab reaches the interface selector from the output trigger')
  await send('Input.dispatchKeyEvent',{type:'keyDown',key:'Escape',code:'Escape',windowsVirtualKeyCode:27,nativeVirtualKeyCode:27})
  await send('Input.dispatchKeyEvent',{type:'keyUp',key:'Escape',code:'Escape',windowsVirtualKeyCode:27,nativeVirtualKeyCode:27})
  await wait(150)
  check(await evaluate('!document.querySelector(".output-panel")'),'Escape dismisses the output panel')
  check(await evaluate('document.activeElement===document.querySelector(".output-trigger")'),'Escape restores focus to the output trigger')
  // Enter carries a carriage-return character; key metadata alone omits activation.
  await send('Input.dispatchKeyEvent',{type:'keyDown',key:'Enter',code:'Enter',text:'\r',unmodifiedText:'\r',windowsVirtualKeyCode:13,nativeVirtualKeyCode:13})
  await send('Input.dispatchKeyEvent',{type:'keyUp',key:'Enter',code:'Enter',windowsVirtualKeyCode:13,nativeVirtualKeyCode:13})
  await waitFor('!!document.querySelector(".output-panel")')
  check(await evaluate('document.querySelector(".output-trigger").getAttribute("aria-expanded")==="true"'),'Enter opens the focused output trigger')
  await send('Input.dispatchKeyEvent',{type:'keyDown',key:'Enter',code:'Enter',text:'\r',unmodifiedText:'\r',windowsVirtualKeyCode:13,nativeVirtualKeyCode:13})
  await send('Input.dispatchKeyEvent',{type:'keyUp',key:'Enter',code:'Enter',windowsVirtualKeyCode:13,nativeVirtualKeyCode:13})
  await waitFor('!document.querySelector(".output-panel")')
  check(await evaluate('document.querySelector(".output-trigger").getAttribute("aria-expanded")==="false"'),'Enter closes the focused output trigger')
  await evaluate('document.querySelector(".output-trigger").click()')
  await waitFor('!!document.querySelector(".output-panel select")')
  const panel=await evaluate(`(()=>{const p=document.querySelector('.output-panel');const s=p.querySelector('select');const b=[...p.querySelectorAll('button')].find(b=>b.textContent.includes('搜索设备'));return {text:p.innerText,label:s.getAttribute('aria-label'),selected:s.value,searchDisabled:b?.disabled,options:s.options.length,expanded:document.querySelector('.output-trigger').getAttribute('aria-expanded')}})()`)
  check(panel.text.includes('本地及在线 MP3')&&panel.text.includes('点击搜索后才发现设备'),'supported formats and explicit-discovery explanation rendered')
  check(panel.label==='局域网网卡'&&panel.selected===''&&panel.options>=1,'network interface selector starts unselected')
  check(panel.searchDisabled===true,'search disabled until interface selection')
  check(panel.expanded==='true','output trigger expanded state')
  await wait(500)
  check(discoveryCalls===0,'opening panel does not invoke discovery (real bridge call breakpoint)')
  const image=await send('Page.captureScreenshot',{format:'png'})
  writeFileSync(join(artifacts,'output-panel.png'),Buffer.from(image.data,'base64'))
  await evaluate('document.querySelector(".output-trigger").click()')
  await waitFor('!document.querySelector(".output-panel")')
  check(await evaluate('document.querySelector(".output-trigger").getAttribute("aria-expanded")==="false"'),'panel closes and expanded state resets')
  await evaluate('document.querySelector(".output-trigger").click()')
  await waitFor('!!document.querySelector(".output-panel select")')
  check(await evaluate(`(()=>{const p=document.querySelector('.output-panel'),s=p.querySelector('select'),b=[...p.querySelectorAll('button')].find(b=>b.textContent.includes('搜索设备'));return s.value===''&&b?.disabled===true})()`),'reopened panel retains unselected interface and disabled search')
  await wait(100)
  check(discoveryCalls===0,'reopening panel does not invoke discovery')
  await evaluate('document.querySelector(".output-trigger").click()')
  await waitFor('!document.querySelector(".output-panel")')
  check(discoveryCalls===0,'no search, device control, or real-source operation requested')
  check(consoleErrors.length===0,`renderer console has no errors (${consoleErrors.length})`)
  result.ok=true
}catch(error){result.ok=false;result.error=error.message;console.error(error.stack);process.exitCode=1}
finally{
  result.discoveryCalls=discoveryCalls;result.consoleErrors=consoleErrors
  ws?.close()
  // Exact executable path under the owned copy, never image-name matching.
  ownedPath(exe)
  if(process.platform==='win32'&&child){
    const script='$target=$env:JJ_DLNA_SMOKE_EXE; $matches=Get-Process -ErrorAction SilentlyContinue | Where-Object {$_.Path -ieq $target}; foreach($item in $matches){& taskkill.exe /PID $item.Id /T /F | Out-Null}; $remaining=Get-Process -ErrorAction SilentlyContinue | Where-Object {$_.Path -ieq $target}; if($remaining){exit 1}'
    const stopped=spawnSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',script],{env:{...process.env,JJ_DLNA_SMOKE_EXE:exe},windowsHide:true,timeout:15000,encoding:'utf8'})
    stopConfirmed=!stopped.error&&stopped.status===0
  }else if(child){child.kill();await wait(500);stopConfirmed=child.exitCode!==null||child.signalCode!==null}
  else stopConfirmed=true
  result.cleanupStopped=stopConfirmed
  if(stopConfirmed){await wait(300);try{rmSync(owned,{recursive:true,force:true,maxRetries:10,retryDelay:300})}catch(error){result.cleanupError=error.message;process.exitCode=1}}
  else{result.cleanupError='Could not confirm owned copied application stopped; retained disposable directory';result.retainedOwnedDirectory=owned;process.exitCode=1}
  writeFileSync(join(artifacts,'result.json'),JSON.stringify(result,null,2))
  console.log(`DLNA UI evidence: ${artifacts}`)
}
