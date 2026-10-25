/** Production playlist management acceptance in an owned Electron profile; only HTTP responses are synthetic. */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { cp, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { openSync, closeSync } from 'node:fs'
import { createServer } from 'node:net'
import { dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..'), output = join(root, '.cache/playlist-restore-ui')
const runId = randomUUID(), owned = join(output, runId), profile = join(owned, 'profile'), appDir = join(owned, 'app')
const guard = join(owned, 'probe.cjs'), control = join(owned, 'control.json')
const report = { runId, status: 'running', scope: 'production restore DOM/preload/main/stores/files; generated WAV/JSON, controlled native picker and write failure; external HTTP blocked; no personal music or real sources', checks: [], profileRemoved: false }
const check = (label, value) => { assert.ok(value, label); report.checks.push(label) }
await mkdir(profile, { recursive: true })
const sleep = ms => new Promise(done => setTimeout(done, ms))
let child, socket, nextId = 0
const pending = new Map(), rendererErrors = []
const wait = async (condition, label) => {
  const deadline = Date.now() + 20000
  while (Date.now() < deadline) { if (await condition()) return; if (child?.exitCode !== null && child?.exitCode !== undefined) throw Error(`App exited: ${label}`); await sleep(80) }
  throw Error(`Timeout: ${label}`)
}
const send = (method, params = {}) => new Promise((yes, no) => {
  const callId = ++nextId, timer = setTimeout(() => { pending.delete(callId); no(Error(`CDP timeout ${method}`)) }, 15000)
  pending.set(callId, { yes, no, timer }); socket.send(JSON.stringify({ id: callId, method, params }))
})
const evaluate = async expression => {
  const r = await send('Runtime.evaluate', { expression: `(async()=>{${expression}})()`, awaitPromise: true, returnByValue: true })
  if (r.exceptionDetails) throw Error(r.exceptionDetails.exception?.description || 'Renderer evaluation failed')
  return r.result.value
}
async function launch() {
  const port = await new Promise(yes => { const server = createServer(); server.listen(0, '127.0.0.1', () => { const port = server.address().port; server.close(() => yes(port)) }) })
  const log = openSync(join(output, `${runId}-main.log`), 'a')
  try { child = spawn(join(root, 'node_modules/electron/dist/electron.exe'), [guard, `--user-data-dir=${profile}`, '--disable-background-networking'], { cwd: root, windowsHide: true, stdio: ['ignore', log, log], env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined, NODE_OPTIONS: undefined, JJ_ALLOW_DEBUG_PORT: '1', JJ_DEBUG_PORT: String(port) } }) }
  finally { closeSync(log) }
  let target
  await wait(async () => { try { target = (await (await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(1000) })).json()).find(t => t.type === 'page'); return !!target } catch { return false } }, 'renderer')
  socket = new WebSocket(target.webSocketDebuggerUrl)
  socket.addEventListener('message', event => { const r = JSON.parse(event.data), p = pending.get(r.id); if(r.method==='Runtime.exceptionThrown'||r.method==='Runtime.consoleAPICalled'&&r.params?.type==='error')rendererErrors.push(r.params); if (p) { clearTimeout(p.timer); pending.delete(r.id); r.error ? p.no(Error(r.error.message)) : p.yes(r.result) } })
  await new Promise((yes, no) => { socket.addEventListener('open', yes, { once: true }); socket.addEventListener('error', no, { once: true }) })
  await wait(() => evaluate('return !!window.jj && !!document.querySelector("h1")'), 'page ready')
}
async function close() {
  await evaluate('await window.jj.window.close()')
  await wait(() => Promise.resolve(child.exitCode !== null), 'normal exit')
  assert.equal(child.exitCode, 0)
  socket?.close(); socket = undefined; child = undefined
}

const click = text => evaluate(`const b=[...document.querySelectorAll('button')].find(b=>b.textContent.trim()===${JSON.stringify(text)});if(!b||b.disabled)throw Error('button unavailable: '+${JSON.stringify(text)});b.click()`)
const backupPath=join(owned,'backup.json'),badPath=join(owned,'bad.json'),lastToken=join(owned,'last-token.txt')
const rows=Array.from({length:3},(_,i)=>({id:'local-'+i,path:join(owned,'track-'+i+'.wav'),name:'Generated '+i,singer:'Fixture',duration:180}))
const online={id:'local-0',source:'wy',name:'Online collision',singer:'Fixture',meta:{songmid:'123',qualitys:[{type:'128k'}]},providerData:{token:'PRIVATE'}}
const backup={kind:'jj-music-playlists',version:1,createdAt:'2026-10-24T00:00:00.000Z',scope:'all',playlists:[{id:'favorites',name:'我喜欢的',source:'local',position:1,tracks:[...rows.map(r=>({...r,kind:'local'})),{...online,kind:'online'}]},{id:'remote',name:'我喜欢的',source:'wy',sourceListId:'123',position:2,tracks:[{...online,id:'wy_456',meta:{songmid:'456'},kind:'online'}]},{id:'empty',name:'空歌单',source:'local',position:3,tracks:[]}]}
const backupBytes=Buffer.from(JSON.stringify(backup))
const list=()=>evaluate('return await window.jj.playlists.list()')
const navigate=async path=>{await evaluate(`location.hash=${JSON.stringify('#'+path)}`);await wait(()=>evaluate('return !document.querySelector(".fade-enter-active,.fade-leave-active")'),'route transition');await sleep(150)}
async function choose(){await click('从 JSON 恢复');await wait(()=>evaluate('return !!document.querySelector(".restore-preview")'),'restore preview')}
async function apply(){await click('确认恢复为新歌单');await wait(()=>evaluate('return !document.querySelector(".restore-preview")&&!document.body.innerText.includes("正在处理备份")'),'restore result')}
try{
 await mkdir(join(profile,'library'),{recursive:true});await cp(join(root,'out'),appDir,{recursive:true})
 const wav=Buffer.alloc(2880044);wav.write('RIFF');wav.writeUInt32LE(wav.length-8,4);wav.write('WAVEfmt ',8);wav.writeUInt32LE(16,16);wav.writeUInt16LE(1,20);wav.writeUInt16LE(1,22);wav.writeUInt32LE(8000,24);wav.writeUInt32LE(16000,28);wav.writeUInt16LE(2,32);wav.writeUInt16LE(16,34);wav.write('data',36);wav.writeUInt32LE(wav.length-44,40)
 for(const row of rows)await writeFile(row.path,wav)
 await writeFile(join(profile,'library/index.json'),JSON.stringify({version:5,folders:[],tracks:rows}))
 const lists=[{id:'default',name:'默认列表',source:'local',position:0},{id:'favorites',name:'我喜欢的',source:'local',position:1},{id:'test',name:'原始歌单',source:'local',position:2}]
 await writeFile(join(profile,'playlists.json'),JSON.stringify({version:1,playlists:lists,items:{default:[],favorites:[rows[0]],test:rows}}))
 await writeFile(join(profile,'settings.json'),JSON.stringify({libraryFolders:[],onlineLyricSource:'off',onlineLyricFallback:false,showSearchHotWords:false,minimizeToTray:false}))
 await writeFile(backupPath,backupBytes);await writeFile(badPath,'{"kind":"jj-music-playlists","version":2}')
 await writeFile(control,JSON.stringify({path:backupPath}))
 await writeFile(guard,`const {app,BrowserWindow,dialog,session,ipcMain}=require('electron');const fs=require('node:fs'),fsp=require('node:fs/promises');const {syncBuiltinESMExports}=require('node:module');const control=${JSON.stringify(control)},tokenFile=${JSON.stringify(lastToken)};const read=()=>JSON.parse(fs.readFileSync(control,'utf8'));const rename=fsp.rename;fsp.rename=async(a,b)=>{if(String(b)===${JSON.stringify(join(profile,'playlists.json'))}&&read().fail)throw Error('Synthetic restore disk failure');return rename(a,b)};syncBuiltinESMExports();const register=ipcMain.handle.bind(ipcMain);ipcMain.handle=(channel,fn)=>register(channel,async(...args)=>{const result=await fn(...args);if(channel==='playlist:restore-preview'&&result?.data?.token)fs.writeFileSync(tokenFile,result.data.token);if(channel==='playlist:list'&&read().refreshFail){const c=read();delete c.refreshFail;fs.writeFileSync(control,JSON.stringify(c));return{ok:false,error:'Synthetic list refresh failure'}}return result});BrowserWindow.prototype.show=function(){};dialog.showOpenDialog=async()=>{const c=read();if(c.delay)await new Promise(r=>setTimeout(r,c.delay));return{canceled:!!c.cancel,filePaths:c.path?[c.path]:[]}};app.on('browser-window-created',(_,w)=>w.webContents.setBackgroundThrottling(false));globalThis.fetch=async()=>{throw Error('External HTTP blocked by fixture')};app.whenReady().then(()=>session.defaultSession.webRequest.onBeforeRequest({urls:['http://*/*','https://*/*']},(_,cb)=>cb({cancel:true})));import(${JSON.stringify(pathToFileURL(join(appDir,'main/index.js')).href)}).catch(e=>{console.error(e);app.exit(1)});`)
 await launch();await send('Runtime.enable')
 check('owned profile',resolve((await evaluate('return await window.jj.data.location()')).dir).toLowerCase()===profile.toLowerCase())
 check('no real sources',(await evaluate('return await window.jj.sources.list()')).length===0)
 await navigate('/playlist/test');await wait(()=>evaluate('return document.querySelectorAll(".track-row").length===3'),'original rows')
 await evaluate('document.querySelectorAll(".track-row")[1].dispatchEvent(new MouseEvent("dblclick",{bubbles:true}))')
 await wait(()=>evaluate('return navigator.mediaSession.playbackState==="playing"'),'generated audio')
 await navigate('/playlists');await wait(()=>evaluate('return !!document.querySelector(".playlist-restore")'),'restore entry')
 const original=await readFile(join(profile,'playlists.json'),'utf8')
 await writeFile(control,JSON.stringify({cancel:true}));await click('从 JSON 恢复');await sleep(200)
 check('picker cancel has no writes',await readFile(join(profile,'playlists.json'),'utf8')===original)
 await writeFile(control,JSON.stringify({path:backupPath}));await choose()
 check('preview shows complete names and counts',await evaluate('return document.querySelector(".restore-preview").textContent.includes("3 个歌单")&&document.querySelector(".restore-preview").textContent.includes("5 首曲目")&&document.querySelectorAll(".restore-preview li").length===3'))
 check('preview is read only',await readFile(join(profile,'playlists.json'),'utf8')===original)
 const shot=await send('Page.captureScreenshot',{format:'png'});report.screenshot=join(output,runId+'-preview.png');await writeFile(report.screenshot,Buffer.from(shot.data,'base64'))
 await click('取消恢复');check('preview cancel preserves lists',(await list()).length===3)
 await choose();const token=await readFile(lastToken,'utf8')
 await writeFile(backupPath,'{"version":999}')
 await apply();await wait(async()=> (await list()).length===6,'three restored lists')
 let saved=await list(),newLists=saved.filter(p=>!['default','favorites','test'].includes(p.id))
 check('new IDs retain separate same-name and empty lists',newLists.length===3&&newLists.filter(p=>p.name==='我喜欢的（恢复）').length===2)
 const restored=newLists[0].id,items=await evaluate(`return await window.jj.playlists.items(${JSON.stringify(restored)})`)
 check('authoritative preview survives source file changes',items.length===4&&items[0].path===rows[0].path&&items[3].source==='wy')
 check('unknown fields stripped before persistence',!JSON.stringify(items).includes('PRIVATE'))
 check('original favorites unchanged',JSON.stringify(await evaluate('return await window.jj.playlists.items("favorites")'))===JSON.stringify([rows[0]]))
 check('token cannot be consumed twice',await evaluate(`try{await window.jj.playlists.restoreApply(${JSON.stringify(token)});return false}catch{return true}`))
 await navigate('/playlist/'+restored);await wait(()=>evaluate('return document.querySelectorAll(".track-row").length===4'),'restored collision rows')
 await evaluate('const r=document.querySelectorAll(".track-row");r[3].dispatchEvent(new MouseEvent("click",{bubbles:true}))')
 check('same raw ID rows select independently',await evaluate('return document.querySelectorAll(".track-row.selected").length===1&&document.querySelector(".track-row.selected").textContent.includes("Online collision")'))
 await evaluate('const r=document.querySelectorAll(".track-row"),t=new DataTransfer();r[3].dispatchEvent(new DragEvent("dragstart",{bubbles:true,dataTransfer:t}));const box=r[0].getBoundingClientRect();r[0].dispatchEvent(new DragEvent("dragover",{bubbles:true,dataTransfer:t,clientY:box.top+1}));r[0].dispatchEvent(new DragEvent("drop",{bubbles:true,dataTransfer:t}));r[3].dispatchEvent(new DragEvent("dragend",{bubbles:true,dataTransfer:t}))')
 await wait(async()=> (await evaluate(`return await window.jj.playlists.items(${JSON.stringify(restored)})`))[0]?.source==='wy','compound identity reorder')
 check('drag reorder retains every identity',(await evaluate(`return await window.jj.playlists.items(${JSON.stringify(restored)})`)).length===4)
 await evaluate('document.querySelector(".track-row").dispatchEvent(new MouseEvent("contextmenu",{bubbles:true,clientX:450,clientY:350}))')
 check('online favorite state does not alias local favorite',await evaluate('return [...document.querySelectorAll("[role=menuitem]")].some(e=>e.textContent.trim()==="喜爱")'))
 await evaluate('const e=[...document.querySelectorAll("[role=menuitem]")].find(e=>e.textContent.trim()==="喜爱");e.click()')
 await wait(async()=> (await evaluate('return await window.jj.playlists.items("favorites")')).length===2,'independent favorite add');await wait(()=>evaluate('return document.querySelectorAll(".track-row").length===4'),'rows after favorite add')
 await wait(()=>evaluate('const row=[...document.querySelectorAll(".track-row")].find(e=>e.textContent.includes("Online collision"));if(!row)return false;row.dispatchEvent(new MouseEvent("contextmenu",{bubbles:true,clientX:450,clientY:350}));return [...document.querySelectorAll("[role=menuitem]")].some(e=>e.textContent.trim()==="取消喜爱")'),'favorite state rendered')
 await evaluate('[...document.querySelectorAll("[role=menuitem]")].find(e=>e.textContent.trim()==="取消喜爱").click()')
 await wait(async()=> (await evaluate('return await window.jj.playlists.items("favorites")')).length===1,'independent favorite remove');await wait(()=>evaluate('return document.querySelectorAll(".track-row").length===4'),'rows after favorite removal')
 check('toggle leaves original local favorite',JSON.stringify(await evaluate('return await window.jj.playlists.items("favorites")'))===JSON.stringify([rows[0]]))
 await evaluate('const row=[...document.querySelectorAll(".track-row")].find(e=>e.textContent.includes("Online collision"));row.dispatchEvent(new MouseEvent("contextmenu",{bubbles:true,clientX:450,clientY:350}))')
 await wait(()=>evaluate('return [...document.querySelectorAll("[role=menuitem]")].some(e=>e.textContent.trim()==="从歌单移除")'),'remove menu rendered')
 await evaluate('[...document.querySelectorAll("[role=menuitem]")].find(e=>e.textContent.trim()==="从歌单移除").click()')
 await wait(async()=> (await evaluate(`return await window.jj.playlists.items(${JSON.stringify(restored)})`)).length===3,'single remove')
 check('remove online collision retains all local rows',(await evaluate(`return await window.jj.playlists.items(${JSON.stringify(restored)})`)).every(r=>!!r.path))
 await navigate('/playlists');await wait(()=>evaluate('return !!document.querySelector(".playlist-restore")'),'management return')
 await writeFile(control,JSON.stringify({path:badPath}));await click('从 JSON 恢复');await wait(()=>evaluate('return !!document.querySelector(".restore-error")'),'invalid file feedback')
 check('malformed file creates no lists',(await list()).length===6)
 await writeFile(backupPath,backupBytes);await writeFile(control,JSON.stringify({path:backupPath,fail:true}));await choose();await apply()
 check('failed batch creates no partial lists',(await list()).length===6)
 check('failed batch requests a fresh preview',await evaluate('return document.querySelector(".restore-error").textContent.includes("重新选择备份")'))
 await writeFile(control,JSON.stringify({path:backupPath}));await choose();await apply()
 check('fresh preview retries successfully',(await list()).length===9)
 await choose();await writeFile(control,JSON.stringify({path:backupPath,refreshFail:true}));await apply()
 check('committed restore distinguished from refresh failure',await evaluate('return document.querySelector(".restore-error").textContent.includes("已恢复 3 个新歌单")&&document.querySelector(".restore-error").textContent.includes("无需重复恢复")'))
 check('refresh failure retains full committed batch',(await list()).length===12)
 await choose();const abandoned=await readFile(lastToken,'utf8');await navigate('/playlist/test');await wait(()=>evaluate('return !!document.querySelector("[aria-label=在歌单内搜索]")'),'leave preview')
 check('route leave releases accepted token',await evaluate(`try{await window.jj.playlists.restoreApply(${JSON.stringify(abandoned)});return false}catch{return true}`))
 await navigate('/playlists');await wait(()=>evaluate('return !!document.querySelector(".playlist-restore")'),'late picker route')
 await writeFile(control,JSON.stringify({path:backupPath,delay:500}));await click('从 JSON 恢复');await navigate('/playlist/test')
 await wait(async()=>{try{return(await readFile(lastToken,'utf8'))!==abandoned}catch{return false}},'late token');await sleep(200)
 const late=await readFile(lastToken,'utf8')
 check('late picker after unmount releases its own token',await evaluate(`try{await window.jj.playlists.restoreApply(${JSON.stringify(late)});return false}catch{return true}`))
 check('cleanup creates no unintended playlists',(await list()).length===12)
 await close()
 const session=JSON.parse(await readFile(join(profile,'settings.json'),'utf8')).lastSession
 check('restoration and editing do not replace current queue',session?.queue?.length===3&&session.index===1&&session.track.id==='local-1')
 report.rendererErrors=rendererErrors;check('zero renderer errors',rendererErrors.length===0);report.status='passed'
}catch(error){report.status='failed';report.error=error.stack||String(error);process.exitCode=1}
finally{
 socket?.close();for(const p of pending.values()){clearTimeout(p.timer);p.no(Error('probe closed'))}
 if(child&&child.exitCode===null){child.kill();await sleep(300)}
 assert.ok(resolve(owned).startsWith(resolve(output)+sep)&&dirname(owned)===output)
 await rm(owned,{recursive:true,force:true,maxRetries:5,retryDelay:100});report.profileRemoved=true
 await writeFile(join(output,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report))
}
