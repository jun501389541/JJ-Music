/** Production playlist bulk-rename acceptance in an owned Electron profile; only HTTP responses are synthetic. */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { cp, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { openSync, closeSync } from 'node:fs'
import { createServer } from 'node:net'
import { dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..'), output = join(root, '.cache/playlist-bulk-rename-ui')
const runId = randomUUID(), owned = join(output, runId), profile = join(owned, 'profile'), appDir = join(owned, 'app')
const guard = join(owned, 'probe.cjs'), control = join(owned, 'control.json')
const report = { runId, status: 'running', scope: 'production bulk playlist rename DOM/preload/main/store/fs; owned generated WAV/JSON; synthetic write delay/failure only; no personal music or source scripts', checks: [], profileRemoved: false }
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
const setInput=(label,value)=>evaluate(`const e=[...document.querySelectorAll('input')].find(e=>e.getAttribute('aria-label')===${JSON.stringify(label)});if(!e)throw Error('input unavailable: '+${JSON.stringify(label)});e.value=${JSON.stringify(value)};e.dispatchEvent(new Event('input',{bubbles:true}))`)
const ready=()=>wait(()=>evaluate('return !!document.querySelector(".rename-preview")'),'bulk-rename preview')
const present={id:'present',path:join(owned,'present.wav'),name:'Playable generated',singer:'Fixture',duration:180}
const online=(source,id)=>({id,source,name:source+' '+id,singer:'Fixture',meta:{songmid:id,retained:'native'}})
const initialItems={default:[],favorites:[present],a:[present,online('wy','same')],b:[{...present,name:'Later local title'},online('tx','same'),online('wy','other')],empty:[]}
try{
 await cp(join(root,'out'),appDir,{recursive:true})
 const wav=Buffer.alloc(2880044);wav.write('RIFF');wav.writeUInt32LE(wav.length-8,4);wav.write('WAVEfmt ',8);wav.writeUInt32LE(16,16);wav.writeUInt16LE(1,20);wav.writeUInt16LE(1,22);wav.writeUInt32LE(8000,24);wav.writeUInt32LE(16000,28);wav.writeUInt16LE(2,32);wav.writeUInt16LE(16,34);wav.write('data',36);wav.writeUInt32LE(wav.length-44,40);await writeFile(present.path,wav)
 await mkdir(join(profile,'library'),{recursive:true});await writeFile(join(profile,'library/index.json'),JSON.stringify({version:5,folders:[],tracks:[present]}))
 const initialLists=[{id:'default',name:'默认列表',source:'local',position:0},{id:'favorites',name:'我喜欢的',source:'local',position:1},{id:'a',name:'Source A',source:'wy',sourceListId:'123',position:2},{id:'b',name:'Source B',source:'local',position:3},{id:'empty',name:'Empty',source:'local',position:4},{id:'repeat',name:'Source Source',source:'local',position:5}]
 initialItems.repeat=[]
 await writeFile(join(profile,'playlists.json'),JSON.stringify({version:1,playlists:initialLists,items:initialItems}))
 await writeFile(join(profile,'settings.json'),JSON.stringify({libraryFolders:[],onlineLyricSource:'off',onlineLyricFallback:false,showSearchHotWords:false,minimizeToTray:false,playlistOrder:['b','a','empty']}))
 await writeFile(control,'{}')
 const guardLines=[
 "const {app,BrowserWindow,session,ipcMain}=require('electron');const fs=require('node:fs'),fsp=require('node:fs/promises');const {syncBuiltinESMExports}=require('node:module');",
 "const control="+JSON.stringify(control)+";const read=()=>JSON.parse(fs.readFileSync(control,'utf8'));let armRefresh=false;",
 "const rename=fsp.rename;fsp.rename=async(a,b)=>{if(String(b)==="+JSON.stringify(join(profile,'playlists.json'))+"&&read().fail)throw Error('Synthetic disk full');return rename(a,b)};syncBuiltinESMExports();",
 "const register=ipcMain.handle.bind(ipcMain);ipcMain.handle=(channel,fn)=>register(channel,async(...args)=>{if(channel==='playlist:bulk-rename-preview'&&read().slow)await new Promise(r=>setTimeout(r,1200));const result=await fn(...args);if(channel==='playlist:bulk-rename-apply'&&result?.ok&&read().refreshFail)armRefresh=true;if(channel==='playlist:list'&&armRefresh){armRefresh=false;return{ok:false,error:'Synthetic refresh failure'}}return result});",
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
 check('bulk-rename tool is available',await evaluate('return !![...document.querySelectorAll("button")].find(e=>e.textContent.trim()==="批量改名")'))
 await click('批量改名');await select('Source A');await select('Source B');await select('Source Source')
 await setInput('歌单名称前缀','[Demo] ');await setInput('歌单名称后缀','!');await click('生成预览');await ready()
 check('affix preview uses current display order',await evaluate('return [...document.querySelectorAll(".rename-preview ol li")].map(e=>e.textContent).join("|").startsWith("Source B → [Demo] Source B!|Source A → [Demo] Source A!|Source Source → [Demo] Source Source!")'))
 check('preview does not save and counts changes',(await list()).find(p=>p.id==='a').name==='Source A'&&await evaluate('return document.querySelector(".rename-preview").textContent.includes("将改名 3 个")'))
 await click('复制与合并');check('switching tools unmounts rename preview',await evaluate('return !document.querySelector(".rename-preview")&&!!document.querySelector(".playlist-derive")'))
 await click('批量改名');check('returning to rename starts without a stale preview',await evaluate('return !document.querySelector(".rename-preview")'))
 await setInput('歌单名称前缀','[Demo] ');await setInput('歌单名称后缀','!');await click('生成预览');await ready()
 await evaluate('const b=[...document.querySelectorAll("button")].find(e=>e.textContent.trim()==="确认批量改名");b.click();b.click()')
 await wait(()=>evaluate('return !document.querySelector(".bulk-actions")'),'affix applied')
 const affixed=await list(),affixedA=affixed.find(p=>p.id==='a'),affixedB=affixed.find(p=>p.id==='b'),affixedRepeat=affixed.find(p=>p.id==='repeat')
 check('double confirmation changes each selected name once',affixedA?.name==='[Demo] Source A!'&&affixedB?.name==='[Demo] Source B!'&&affixedRepeat?.name==='[Demo] Source Source!')
 check('rename preserves IDs, origins, positions and source association',affixedA.id==='a'&&affixedA.source==='wy'&&affixedA.sourceListId==='123'&&affixedA.position===2&&affixedB.id==='b'&&affixedB.source==='local'&&affixedB.position===3)

 await click('批量管理');await select('[Demo] Source A!');await select('[Demo] Source B!');await select('[Demo] Source Source!');await click('批量改名');await click('查找替换')
 await setInput('歌单名称查找内容','Source');await setInput('歌单名称替换内容','$&');await click('生成预览');await ready()
 check('replacement treats $& literally and replaces every occurrence',await evaluate('const rows=[...document.querySelectorAll(".rename-preview ol li")].map(e=>e.textContent);return rows.some(x=>x.includes("[Demo] Source Source! → [Demo] $& $&!"))&&rows.every(x=>!x.includes("[Demo] $& Source!"))'))
 await click('取消预览');check('cancel leaves names unchanged',(await list()).find(p=>p.id==='a').name==='[Demo] Source A!')
 await setInput('歌单名称替换内容','Track');await click('生成预览');await ready();await click('确认批量改名');await wait(()=>evaluate('return !document.querySelector(".bulk-actions")'),'literal replacement applied')
 const replaced=await list()
 check('replacement applies all matches without changing playlist rows',replaced.find(p=>p.id==='repeat')?.name==='[Demo] Track Track!'&&JSON.stringify(await items('a'))===JSON.stringify(initialItems.a)&&JSON.stringify(await items('b'))===JSON.stringify(initialItems.b))

 await click('批量管理');await select('[Demo] Track A!');await click('批量改名');await click('查找替换');await setInput('歌单名称查找内容','not-present');await setInput('歌单名称替换内容','x');await click('生成预览');await ready()
 check('no-op preview disables confirmation',await evaluate('return document.querySelector(".rename-preview").textContent.includes("将改名 0 个")&&document.querySelector(".rename-preview .btn--primary").disabled'))
 await click('复制与合并');await click('批量改名')
 await click('查找替换');await setInput('筛选已保存歌单','[Demo] Track A!');await wait(()=>evaluate('return document.querySelector(".playlist-filter input").value==="[Demo] Track A!"'),'filter applied before slow request');await select('[Demo] Track A!')
 await setInput('歌单名称查找内容','not-present');await setInput('歌单名称替换内容','x');await writeFile(control,'{"slow":true}');await click('生成预览')
 await wait(()=>evaluate('return [...document.querySelectorAll("button")].find(e=>e.textContent.trim()==="正在生成预览…")'),'slow preview started')
 check('tool switching is disabled while preview is busy',await evaluate('return [...document.querySelectorAll("button")].find(e=>e.textContent.trim()==="复制与合并").disabled'))
 check('clear-filter control is disabled while preview is busy',await evaluate('const b=document.querySelector(".playlist-filter button");const q=document.querySelector(".playlist-filter input").value;b.click();return b.disabled&&document.querySelector(".playlist-filter input").value===q'))
 await click('取消预览');await wait(()=>evaluate('return ![...document.querySelectorAll("button")].find(e=>e.textContent.trim()==="复制与合并").disabled'),'cancel releases busy state')
 await click('复制与合并');await click('批量改名');await sleep(1500);await writeFile(control,'{}')
 check('late response after cancellation and tool switching is discarded',await evaluate('return !document.querySelector(".rename-preview")'))

 await setInput('筛选已保存歌单','');await sleep(100);await select('[Demo] Track B!');await select('[Demo] Track Track!');await setInput('歌单名称前缀','QA ');await click('生成预览');await ready();await select('[Demo] Track A!')
 check('selection change invalidates preview',await evaluate('return !document.querySelector(".rename-preview")'))
 await setInput('歌单名称前缀','QA ');await click('生成预览');await ready();await setInput('筛选已保存歌单','[Demo] Track A!')
 await wait(()=>evaluate('return !document.querySelector(".rename-preview")'),'filter invalidation')
 check('filter change clears selection and preview',await evaluate('return document.querySelector(".bulk-actions").textContent.includes("已选择 0")'))
 await setInput('筛选已保存歌单','');await sleep(100)

 await select('[Demo] Track A!');await select('[Demo] Track B!');await setInput('歌单名称前缀','QA ');await click('生成预览');await ready()
 const namesBeforeFailure=(await list()).map(p=>[p.id,p.name]);await writeFile(control,'{"fail":true}');await click('确认批量改名')
 await wait(()=>evaluate('return document.querySelector(".rename-error")?.textContent.includes("Synthetic disk full")'),'atomic failure')
 check('failed rename rolls back every selected name',JSON.stringify((await list()).map(p=>[p.id,p.name]))===JSON.stringify(namesBeforeFailure))
 await writeFile(control,'{}');await click('生成预览');await ready();await click('确认批量改名');await wait(()=>evaluate('return !document.querySelector(".bulk-actions")'),'rename retry')
 check('failed batch can be retried with a fresh preview',(await list()).find(p=>p.id==='a')?.name==='QA [Demo] Track A!')

 await click('批量管理');await select('QA [Demo] Track A!');await click('批量改名');await setInput('歌单名称前缀','Final ');await click('生成预览');await ready()
 await writeFile(control,'{"refreshFail":true}');await click('确认批量改名')
 await wait(()=>evaluate('return document.querySelector(".bulk-message")?.textContent.includes("无需重复操作")'),'committed refresh failure')
 check('save success and refresh failure are distinguished',(await list()).find(p=>p.id==='a')?.name==='Final QA [Demo] Track A!')

 await writeFile(control,'{}');await click('批量管理');await select('QA [Demo] Track A!');await click('批量改名');await setInput('歌单名称前缀','Slow ');await writeFile(control,'{"slow":true}');await click('生成预览');await navigate('/downloads');await sleep(1600)
 check('leaving an in-flight preview does not return or modify names',await evaluate('return location.hash==="#/downloads"')&&(await list()).find(p=>p.id==='a')?.name==='Final QA [Demo] Track A!')
 await writeFile(control,'{}');await navigate('/playlists');await click('批量管理');await click('批量改名');await select('QA [Demo] Track A!');await setInput('歌单名称前缀','');await setInput('歌单名称后缀','!');await click('生成预览');await ready()
 const shot=await send('Page.captureScreenshot',{format:'png'});report.screenshot=join(output,runId+'.png');await writeFile(report.screenshot,Buffer.from(shot.data,'base64'));await click('取消预览')
 check('original playlist rows, favorites, default and playback identities remain intact',JSON.stringify(await items('a'))===JSON.stringify(initialItems.a)&&JSON.stringify(await items('b'))===JSON.stringify(initialItems.b)&&JSON.stringify(await items('repeat'))===JSON.stringify(initialItems.repeat)&&JSON.stringify(await items('favorites'))===JSON.stringify(initialItems.favorites)&&(await items('default')).length===0)
 check('playlist sidebar order remains unchanged',JSON.stringify((await evaluate('return await window.jj.settings.get()')).playlistOrder)===JSON.stringify(['b','a','empty']))
 await close();const session=JSON.parse(await readFile(join(profile,'settings.json'),'utf8')).lastSession
 check('bulk rename preserves the playback queue',session?.queue?.length===1&&session.index===0&&session.track.id==='present')
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
