/** Production playlist management acceptance in an owned Electron profile; only HTTP responses are synthetic. */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { cp, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { openSync, closeSync } from 'node:fs'
import { createServer } from 'node:net'
import { dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..'), output = join(root, '.cache/bulk-missing-ui')
const runId = randomUUID(), owned = join(output, runId), profile = join(owned, 'profile'), appDir = join(owned, 'app')
const guard = join(owned, 'probe.cjs'), control = join(owned, 'control.json')
const report = { runId, status: 'running', scope: 'production bulk-playlist and missing-reference DOM/preload/main/store/fs; owned generated WAV/JSON; synthetic write delay/failure only; no personal music or source scripts', checks: [], profileRemoved: false }
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
const present={id:'present',path:join(owned,'present.wav'),name:'Playable generated',singer:'Fixture',duration:180}
const missing=Array.from({length:51},(_,i)=>({id:'gone'+i,path:join(owned,'gone','track'+i+'.wav'),name:'Missing '+i,singer:'Fixture'}))
const alternate={...missing[0],path:join(owned,'gone','alternate.wav'),name:'Alternate old path'}
const uncertain={id:'uncertain',path:'//fixture.invalid/share/unknown.wav',name:'Uncertain network',singer:'Fixture'}
const directory={id:'directory',path:join(owned,'directory'),name:'Directory reference',singer:'Fixture'}
const counter=join(owned,'stat-counter.txt')
const labelClick=label=>evaluate('const e=document.querySelector("[aria-label="+CSS.escape('+JSON.stringify(label)+')+"]");if(!e||e.disabled)throw Error("unavailable label");e.click()')
const navigate=async path=>{await evaluate('location.hash='+JSON.stringify('#'+path));await wait(()=>evaluate('return !document.querySelector(".fade-enter-active,.fade-leave-active")'),'route transition');await sleep(100)}
const filter=async value=>{await evaluate('const e=document.querySelector("[aria-label=筛选已保存歌单]");e.value='+JSON.stringify(value)+';e.dispatchEvent(new Event("input",{bubbles:true}))');await sleep(100)}
const list=()=>evaluate('return await window.jj.playlists.list()')
const confirm=async()=>{await wait(()=>evaluate('return !!document.querySelector("form[role=dialog]")'),'confirmation');await evaluate('document.querySelector("form[role=dialog]").requestSubmit()')}
const chooseMissing=()=>click('检查已保存引用')
try{
 await mkdir(join(profile,'library'),{recursive:true});await mkdir(directory.path);await cp(join(root,'out'),appDir,{recursive:true})
 const wav=Buffer.alloc(2880044);wav.write('RIFF');wav.writeUInt32LE(wav.length-8,4);wav.write('WAVEfmt ',8);wav.writeUInt32LE(16,16);wav.writeUInt16LE(1,20);wav.writeUInt16LE(1,22);wav.writeUInt32LE(8000,24);wav.writeUInt32LE(16000,28);wav.writeUInt16LE(2,32);wav.writeUInt16LE(16,34);wav.write('data',36);wav.writeUInt32LE(wav.length-44,40)
 await writeFile(present.path,wav)
 await writeFile(join(profile,'library/index.json'),JSON.stringify({version:5,folders:[],tracks:[present,...missing]}))
 const lists=[{id:'default',name:'默认列表',source:'local',position:0},{id:'favorites',name:'我喜欢的',source:'local',position:1},...['keep','delA','delB','failA','failB'].map((id,i)=>({id,name:({keep:'Keep',delA:'Delete A',delB:'Delete B',failA:'Fail A',failB:'Fail B'})[id],source:'local',position:i+2}))]
 await writeFile(join(profile,'playlists.json'),JSON.stringify({version:1,playlists:lists,items:{default:[],favorites:[present,...missing],keep:[missing[0],alternate,uncertain,directory],delA:[present],delB:[],failA:[],failB:[]}}))
 await writeFile(join(profile,'settings.json'),JSON.stringify({libraryFolders:[],onlineLyricSource:'off',onlineLyricFallback:false,showSearchHotWords:false,minimizeToTray:false,playlistOrder:['delB','keep','delA','failB','failA']}))
 await writeFile(control,JSON.stringify({}));await writeFile(counter,'0')
 const guardLines=[
 "const {app,BrowserWindow,session,ipcMain}=require('electron');const fs=require('node:fs'),fsp=require('node:fs/promises');const {syncBuiltinESMExports}=require('node:module');",
 "const control="+JSON.stringify(control)+",counter="+JSON.stringify(counter)+",prefix="+JSON.stringify(join(owned,'gone')+sep)+";const read=()=>JSON.parse(fs.readFileSync(control,'utf8'));let count=0,armRefresh=false;",
 "const rename=fsp.rename;fsp.rename=async(a,b)=>{if(String(b)==="+JSON.stringify(join(profile,'playlists.json'))+"&&read().fail)throw Error('Synthetic disk full');return rename(a,b)};",
 "const stat=fsp.stat;fsp.stat=async(path,...args)=>{if(String(path).startsWith(prefix)){fs.writeFileSync(counter,String(++count));if(read().slow)await new Promise(r=>setTimeout(r,800))}return stat(path,...args)};syncBuiltinESMExports();",
 "const register=ipcMain.handle.bind(ipcMain);ipcMain.handle=(channel,fn)=>register(channel,async(...args)=>{const result=await fn(...args);if(channel==='playlist:remove-many'&&result?.ok&&read().refreshFail)armRefresh=true;if(channel==='playlist:list'&&armRefresh){armRefresh=false;return{ok:false,error:'Synthetic list refresh failure'}}return result});",
 "BrowserWindow.prototype.show=function(){};app.on('browser-window-created',(_,w)=>w.webContents.setBackgroundThrottling(false));globalThis.fetch=async()=>{throw Error('External HTTP blocked')};app.whenReady().then(()=>session.defaultSession.webRequest.onBeforeRequest({urls:['http://*/*','https://*/*']},(_,cb)=>cb({cancel:true})));",
 "import("+JSON.stringify(pathToFileURL(join(appDir,'main/index.js')).href)+").catch(e=>{console.error(e);app.exit(1)})"
 ];await writeFile(guard,guardLines.join('\n'))
 await launch();await send('Runtime.enable');check('owned profile',resolve((await evaluate('return await window.jj.data.location()')).dir).toLowerCase()===profile.toLowerCase())
 await navigate('/playlist/favorites');await wait(()=>evaluate('return !!document.querySelector(".playlist-view .track-row")'),'favorites rows')
 await evaluate('document.querySelector(".playlist-view .track-row").dispatchEvent(new MouseEvent("dblclick",{bubbles:true}))');await wait(()=>evaluate('return navigator.mediaSession.playbackState==="playing"'),'generated audio')
 await navigate('/playlists');await wait(()=>evaluate('return !!document.querySelector(".playlist-filter")'),'management')
 await click('批量管理');check('system list checkboxes disabled',await evaluate('return [...document.querySelectorAll(".bulk-checkbox input")].filter(e=>e.disabled).length===2'))
 await labelClick('选择歌单 Delete A');check('selection does not navigate',await evaluate('return location.hash==="#/playlists"&&document.querySelector(".bulk-actions").textContent.includes("已选择 1")'))
 await filter('Delete');check('filter clears old selection',await evaluate('return document.querySelector(".bulk-actions").textContent.includes("已选择 0")'))
 await click('全选当前结果');check('select all only visible ordinary lists',await evaluate('return [...document.querySelectorAll(".bulk-checkbox input")].filter(e=>e.checked).length===2'))
 const bulkShot=await send('Page.captureScreenshot',{format:'png'});report.bulkScreenshot=join(output,runId+'-bulk.png');await writeFile(report.bulkScreenshot,Buffer.from(bulkShot.data,'base64'))
 await click('删除选中歌单');await wait(()=>evaluate('return !!document.querySelector("[role=dialog]")'),'bulk confirm');await click('取消');check('cancel preserves all playlists',(await list()).length===7)
 await writeFile(control,JSON.stringify({fail:true}));await click('删除选中歌单');await confirm()
 await wait(()=>evaluate('return document.querySelector(".bulk-message")?.textContent.includes("Synthetic disk full")'),'write failure')
 check('failed batch leaves both lists',(await list()).filter(p=>p.id==='delA'||p.id==='delB').length===2)
 await writeFile(control,'{}');await click('删除选中歌单');await confirm()
 await wait(()=>evaluate('return !document.querySelector(".bulk-actions")'),'bulk done')
 check('successful batch deletes precisely selected lists',(await list()).length===5&&!(await list()).some(p=>p.id==='delA'||p.id==='delB'))
 check('deletion cleans sidebar order',JSON.stringify((await evaluate('return await window.jj.settings.get()')).playlistOrder)===JSON.stringify(['keep','failB','failA']))
 check('system favorites and audio preserved',(await evaluate('return await window.jj.playlists.items("favorites")')).length===52&&(await readFile(present.path)).equals(wav))
 await filter('Fail');await click('批量管理');await click('全选当前结果');await writeFile(control,JSON.stringify({refreshFail:true}));await click('删除选中歌单');await confirm()
 await wait(()=>evaluate('return document.querySelector(".bulk-message")?.textContent.includes("无需重复删除")'),'committed refresh error')
 check('refresh failure distinguished from failed delete',(await list()).length===3)
 await writeFile(control,'{}');await click('缺失文件检查');await wait(()=>evaluate('return !!document.querySelector(".missing-files-view")'),'missing route')
 const beforeCount=await readFile(counter,'utf8');await sleep(150)
 check('missing check is manual with no automatic traversal',beforeCount===await readFile(counter,'utf8')&&await evaluate('return !document.querySelector(".missing-count")'))
 await chooseMissing();await wait(()=>evaluate('return !!document.querySelector(".missing-count")'),'scan result')
 check('deduplicated counts separate missing and unknown',await evaluate('const t=document.querySelector(".missing-count").textContent;return t.includes("55 / 55")&&t.includes("存在 1")&&t.includes("确认缺失 52")&&t.includes("无法确认 2")'))
 check('only confirmed missing references selectable',await evaluate('return document.querySelectorAll("[data-missing-status=unavailable] input:disabled").length===2&&document.querySelectorAll("[data-missing-status=missing]").length===52'))
 check('origins include saved playlist and library',await evaluate('return document.querySelector("[data-missing-status=missing]").textContent.includes("本地曲库")&&document.querySelector("[data-missing-status=missing]").textContent.includes("我喜欢的")'))
 const missingShot=await send('Page.captureScreenshot',{format:'png'});report.missingScreenshot=join(output,runId+'-missing.png');await writeFile(report.missingScreenshot,Buffer.from(missingShot.data,'base64'))
 await evaluate('for(const e of [...document.querySelectorAll("[data-missing-status=missing] input")].slice(0,51))e.click()');await sleep(100)
 check('max50 reject restores actual DOM checkbox state',await evaluate('return document.querySelectorAll(".missing-rows input:checked").length===50&&document.body.innerText.includes("一次最多选择50首")'))
 await evaluate('for(const e of document.querySelectorAll(".missing-rows input:checked"))e.click()')
 await evaluate('document.querySelector("[data-missing-status=missing] input").click();[...document.querySelectorAll(".missing-rows article")].find(e=>e.textContent.includes("Alternate old path")).querySelector("input").click()');await sleep(100)
 check('duplicate ID alternate path rejection stays visually unselected',await evaluate('return document.querySelectorAll(".missing-rows input:checked").length===1&&document.body.innerText.includes("多个原路径请分批")'))
 await click('重新定位选中 1 首');await wait(()=>evaluate('return !!document.querySelector(".batch-relink")'),'existing relink route')
 check('selected missing reference uses existing manual relink flow',await evaluate('return document.querySelector(".batch-relink").textContent.includes("已选 1 首")&&!document.querySelector(".batch-previews")'))
 await navigate('/missing-files');await wait(()=>evaluate('return !!document.querySelector(".missing-files-view")'),'missing return')
 await writeFile(control,JSON.stringify({slow:true}));await chooseMissing();await wait(()=>evaluate('return document.body.innerText.includes("取消检查")'),'slow check');await click('取消检查');await sleep(1000)
 check('cancel discards late checker result',await evaluate('return !document.querySelector(".missing-count")&&document.body.innerText.includes("已取消检查")'))
 await writeFile(control,'{}');await chooseMissing();await wait(()=>evaluate('return !!document.querySelector(".missing-count")'),'retry normal')
 check('cancelled check allows retry',await evaluate('return document.querySelector(".missing-count").textContent.includes("确认缺失 52")'))
 await writeFile(control,JSON.stringify({slow:true}));await click('重新检查');await navigate('/playlists');await sleep(1000);await navigate('/missing-files');await wait(()=>evaluate('return !!document.querySelector(".missing-files-view")'),'return after abandoned scan')
 check('route leave prevents abandoned result repaint',await evaluate('return !document.querySelector(".missing-count")'))
 await writeFile(control,'{}');await mkdir(join(owned,'gone'));await writeFile(missing[0].path,wav)
 await chooseMissing();await wait(()=>evaluate('return !!document.querySelector(".missing-count")'),'updated stat')
 check('recheck reflects created file without deleting references',await evaluate('const t=document.querySelector(".missing-count").textContent;return t.includes("存在 2")&&t.includes("确认缺失 51")'))
 check('check never changes stored local references',(await evaluate('return await window.jj.playlists.items("favorites")')).length===52)
 await close();const session=JSON.parse(await readFile(join(profile,'settings.json'),'utf8')).lastSession
 check('bulk deletion and missing scans preserve playback queue',session?.queue?.length===52&&session.index===0&&session.track.id==='present')
 report.rendererErrors=rendererErrors;check('no renderer errors',rendererErrors.length===0);report.status='passed'
}catch(error){report.status='failed';report.error=error.stack||String(error);process.exitCode=1}
finally{
 socket?.close();for(const p of pending.values()){clearTimeout(p.timer);p.no(Error('probe closed'))}
 if(child&&child.exitCode===null){child.kill();await sleep(300)}
 assert.ok(resolve(owned).startsWith(resolve(output)+sep)&&dirname(owned)===output)
 await rm(owned,{recursive:true,force:true,maxRetries:5,retryDelay:100});report.profileRemoved=true
 await writeFile(join(output,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report))
}
