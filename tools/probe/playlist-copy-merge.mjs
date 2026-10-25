/** Production playlist management acceptance in an owned Electron profile; only HTTP responses are synthetic. */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { cp, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { openSync, closeSync } from 'node:fs'
import { createServer } from 'node:net'
import { dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..'), output = join(root, '.cache/playlist-copy-merge-ui')
const runId = randomUUID(), owned = join(output, runId), profile = join(owned, 'profile'), appDir = join(owned, 'app')
const guard = join(owned, 'probe.cjs'), control = join(owned, 'control.json')
const report = { runId, status: 'running', scope: 'production playlist copy/merge DOM/preload/main/store/fs; owned generated WAV/JSON; synthetic write delay/failure only; no personal music or source scripts', checks: [], profileRemoved: false }
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
const navigate=async path=>{await evaluate('location.hash='+JSON.stringify('#'+path));await wait(()=>evaluate('return !document.querySelector(".fade-enter-active,.fade-leave-active")'),'route');await sleep(100);if(path==='/playlists')await wait(()=>evaluate('return !!document.querySelector(".playlist-filter")'),'management ready')}
const list=()=>evaluate('return await window.jj.playlists.list()')
const items=id=>evaluate(`return await window.jj.playlists.items(${JSON.stringify(id)})`)
const select=name=>evaluate(`const e=[...document.querySelectorAll('.bulk-checkbox input')].find(e=>e.getAttribute('aria-label')===${JSON.stringify('选择歌单 '+name)});if(!e||e.disabled)throw Error('selection unavailable');e.click()`)
const ready=()=>wait(()=>evaluate('return !!document.querySelector(".derive-preview")'),'derived preview')
const present={id:'present',path:join(owned,'present.wav'),name:'Playable generated',singer:'Fixture',duration:180}
const online=(source,id)=>({id,source,name:source+' '+id,singer:'Fixture',meta:{songmid:id,retained:'native'}})
const initialItems={default:[],favorites:[present],a:[present,online('wy','same')],b:[{...present,name:'Later local title'},online('tx','same'),online('wy','other')],empty:[]}
try{
 await cp(join(root,'out'),appDir,{recursive:true})
 const wav=Buffer.alloc(2880044);wav.write('RIFF');wav.writeUInt32LE(wav.length-8,4);wav.write('WAVEfmt ',8);wav.writeUInt32LE(16,16);wav.writeUInt16LE(1,20);wav.writeUInt16LE(1,22);wav.writeUInt32LE(8000,24);wav.writeUInt32LE(16000,28);wav.writeUInt16LE(2,32);wav.writeUInt16LE(16,34);wav.write('data',36);wav.writeUInt32LE(wav.length-44,40);await writeFile(present.path,wav)
 await mkdir(join(profile,'library'),{recursive:true});await writeFile(join(profile,'library/index.json'),JSON.stringify({version:5,folders:[],tracks:[present]}))
 const initialLists=[{id:'default',name:'默认列表',source:'local',position:0},{id:'favorites',name:'我喜欢的',source:'local',position:1},{id:'a',name:'Source A',source:'wy',sourceListId:'123',position:2},{id:'b',name:'Source B',source:'local',position:3},{id:'empty',name:'Empty',source:'local',position:4}]
 await writeFile(join(profile,'playlists.json'),JSON.stringify({version:1,playlists:initialLists,items:initialItems}))
 await writeFile(join(profile,'settings.json'),JSON.stringify({libraryFolders:[],onlineLyricSource:'off',onlineLyricFallback:false,showSearchHotWords:false,minimizeToTray:false,playlistOrder:['b','a','empty']}))
 await writeFile(control,'{}')
 const guardLines=[
 "const {app,BrowserWindow,session,ipcMain}=require('electron');const fs=require('node:fs'),fsp=require('node:fs/promises');const {syncBuiltinESMExports}=require('node:module');",
 "const control="+JSON.stringify(control)+";const read=()=>JSON.parse(fs.readFileSync(control,'utf8'));let armRefresh=false;",
 "const rename=fsp.rename;fsp.rename=async(a,b)=>{if(String(b)==="+JSON.stringify(join(profile,'playlists.json'))+"&&read().fail)throw Error('Synthetic disk full');return rename(a,b)};syncBuiltinESMExports();",
 "const register=ipcMain.handle.bind(ipcMain);ipcMain.handle=(channel,fn)=>register(channel,async(...args)=>{if(channel==='playlist:derive-preview'&&read().slow)await new Promise(r=>setTimeout(r,1200));const result=await fn(...args);if(channel==='playlist:derive-apply'&&result?.ok&&read().refreshFail)armRefresh=true;if(channel==='playlist:list'&&armRefresh){armRefresh=false;return{ok:false,error:'Synthetic refresh failure'}}return result});",
 "BrowserWindow.prototype.show=function(){};app.on('browser-window-created',(_,w)=>w.webContents.setBackgroundThrottling(false));globalThis.fetch=async()=>{throw Error('External HTTP blocked')};app.whenReady().then(()=>session.defaultSession.webRequest.onBeforeRequest({urls:['http://*/*','https://*/*']},(_,cb)=>cb({cancel:true})));",
 "import("+JSON.stringify(pathToFileURL(join(appDir,'main/index.js')).href)+").catch(e=>{console.error(e);app.exit(1)})"
 ];await writeFile(guard,guardLines.join('\n'))
 await launch();await send('Runtime.enable')
 check('owned profile',resolve((await evaluate('return await window.jj.data.location()')).dir).toLowerCase()===profile.toLowerCase())
 check('no source scripts',(await evaluate('return await window.jj.sources.list()')).length===0)
 await navigate('/playlist/favorites');await wait(()=>evaluate('return !!document.querySelector(".playlist-view .track-row")'),'generated track')
 await evaluate('document.querySelector(".playlist-view .track-row").dispatchEvent(new MouseEvent("dblclick",{bubbles:true}))');await wait(()=>evaluate('return navigator.mediaSession.playbackState==="playing"'),'generated audio')
 await navigate('/playlists');await click('批量管理')
 check('system lists remain protected',await evaluate('return [...document.querySelectorAll(".bulk-checkbox input")].filter(e=>e.disabled).length===2'))
 check('merge requires at least two selected',await evaluate('return [...document.querySelectorAll("button")].find(e=>e.textContent.trim()==="合并选中歌单").disabled'))
 await select('Source A');await click('复制选中歌单');await ready()
 check('preview never saves',(await list()).length===5)
 await click('取消复制或合并');check('cancel never saves',(await list()).length===5)
 await select('Source B');await click('复制选中歌单');await ready()
 check('copy uses displayed order rather than checkbox order',await evaluate('return document.querySelector("[aria-label=新歌单] li").textContent.startsWith("Source B（副本）")'))
 await click('确认创建副本');await wait(()=>evaluate('return !document.querySelector(".bulk-actions")'),'copied')
 const copied=await list(),copyA=copied.find(p=>p.name==='Source A（副本）')
 check('batch creates two distinct copies',copied.length===7&&!!copyA&&copyA.id!=='a')
 check('copy preserves remote origin and native rows',copyA.source==='wy'&&copyA.sourceListId==='123'&&JSON.stringify(await items(copyA.id))===JSON.stringify(initialItems.a))
 await click('批量管理');await select('Source A');await select('Source B');await click('合并选中歌单');await ready()
 check('merge previews identity dedupe',await evaluate('return document.querySelector(".derive-preview").textContent.includes("去重 1 首")'))
 await evaluate('const e=document.querySelector("[aria-label=合并歌单名称]");e.value="Combined";e.dispatchEvent(new Event("input",{bubbles:true}))')
 await wait(()=>evaluate('return !document.querySelector(".derive-preview")'),'name invalidation')
 check('editing name requires a new preview',(await list()).length===7)
 await click('更新合并预览');await ready();await click('确认创建合并歌单')
 await wait(()=>evaluate('return location.hash.startsWith("#/playlist/")'),'merged route')
 const merged=(await list()).find(p=>p.name==='Combined'),mergedItems=await items(merged.id)
 check('merge creates a new independent local list',merged.source==='local'&&!merged.sourceListId&&mergedItems.length===4)
 check('merge preserves first metadata and platform identity',mergedItems[0].name==='Later local title'&&mergedItems.map(t=>t.path?'local':t.source).join(',')==='local,tx,wy,wy')
 const stale=await evaluate('return await window.jj.playlists.derivePreview("copy",["a"],"")')
 await evaluate('await window.jj.playlists.rename("a","Edited source")')
 check('source edit rejects stale preview',await evaluate(`try{await window.jj.playlists.deriveApply(${JSON.stringify(stale.token)});return false}catch{return true}`))
 await evaluate('await window.jj.playlists.rename("a","Source A")')
 const once=await evaluate('return await window.jj.playlists.derivePreview("copy",["empty"],"")')
 check('duplicate apply creates only once',await evaluate(`const r=await Promise.allSettled([window.jj.playlists.deriveApply(${JSON.stringify(once.token)}),window.jj.playlists.deriveApply(${JSON.stringify(once.token)})]);return r.filter(x=>x.status==='fulfilled').length===1`))
 await navigate('/playlists');await click('批量管理');await select('Source A');await select('Source B');await click('复制选中歌单');await ready()
 const countBeforeFailure=(await list()).length;await writeFile(control,'{"fail":true}');await click('确认创建副本')
 await wait(()=>evaluate('return document.querySelector(".derive-error")?.textContent.includes("Synthetic disk full")'),'atomic failure')
 check('failed copy saves no partial records',(await list()).length===countBeforeFailure)
 await writeFile(control,'{}');await click('复制选中歌单');await ready();await click('确认创建副本');await wait(()=>evaluate('return !document.querySelector(".bulk-actions")'),'copy retry')
 check('new preview can retry failed batch',(await list()).length===countBeforeFailure+2)
 await click('批量管理');await select('Source A');await click('复制选中歌单');await ready();await writeFile(control,'{"refreshFail":true}');await click('确认创建副本')
 await wait(()=>evaluate('return document.querySelector(".bulk-message")?.textContent.includes("无需重复操作")'),'committed refresh failure')
 check('refresh failure is distinguished from save failure',(await list()).length===countBeforeFailure+3)
 await writeFile(control,'{}');await click('批量管理');await select('Source A');await click('复制选中歌单');await ready();await select('Source B')
 check('selection change discards preview',await evaluate('return !document.querySelector(".derive-preview")'))
 await click('复制选中歌单');await ready()
 await evaluate('const e=document.querySelector("[aria-label=筛选已保存歌单]");e.value="Source A";e.dispatchEvent(new Event("input",{bubbles:true}))')
 await wait(()=>evaluate('return !document.querySelector(".derive-preview")'),'filter invalidation')
 check('filter change clears selection',await evaluate('return document.querySelector(".bulk-actions").textContent.includes("已选择 0")'))
 await evaluate('const e=document.querySelector("[aria-label=筛选已保存歌单]");e.value="";e.dispatchEvent(new Event("input",{bubbles:true}))');await sleep(100)
 await select('Source A');await writeFile(control,'{"slow":true}');await click('复制选中歌单');await navigate('/downloads');await sleep(1600)
 check('leaving slow preview never saves or navigates back',await evaluate('return location.hash==="#/downloads"')&&(await list()).length===countBeforeFailure+3)
 await writeFile(control,'{}');await navigate('/playlists');await click('批量管理');await select('Source A');await select('Source B');await click('合并选中歌单');await ready()
 const shot=await send('Page.captureScreenshot',{format:'png'});report.screenshot=join(output,runId+'.png');await writeFile(report.screenshot,Buffer.from(shot.data,'base64'));await click('取消复制或合并')
 check('original lists, favorites and default preserve content',JSON.stringify(await items('a'))===JSON.stringify(initialItems.a)&&JSON.stringify(await items('b'))===JSON.stringify(initialItems.b)&&JSON.stringify(await items('favorites'))===JSON.stringify(initialItems.favorites)&&(await items('default')).length===0)
 check('existing custom sidebar order stays intact',JSON.stringify((await evaluate('return await window.jj.settings.get()')).playlistOrder)===JSON.stringify(['b','a','empty']))
 await close();const session=JSON.parse(await readFile(join(profile,'settings.json'),'utf8')).lastSession
 check('copy and merge preserve the playback queue',session?.queue?.length===1&&session.index===0&&session.track.id==='present')
 check('generated audio original unchanged',(await readFile(present.path)).equals(wav))
 report.rendererErrors=rendererErrors;check('no renderer errors',rendererErrors.length===0);report.status='passed'
}catch(error){report.status='failed';report.error=error.stack||String(error);try{report.body=await evaluate('return document.body.innerText.slice(0,2000)')}catch{}process.exitCode=1}
finally{
 socket?.close();for(const p of pending.values()){clearTimeout(p.timer);p.no(Error('probe closed'))}
 if(child&&child.exitCode===null){child.kill();await sleep(300)}
 assert.ok(resolve(owned).startsWith(resolve(output)+sep)&&dirname(owned)===output)
 await rm(owned,{recursive:true,force:true,maxRetries:5,retryDelay:100});report.profileRemoved=true
 await writeFile(join(output,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report))
}
