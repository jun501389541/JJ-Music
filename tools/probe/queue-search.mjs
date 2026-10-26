/** Production playlist management acceptance in an owned Electron profile; only HTTP responses are synthetic. */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { cp, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { openSync, closeSync } from 'node:fs'
import { createServer } from 'node:net'
import { dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..'), output = join(root, '.cache/queue-search-ui')
const runId = randomUUID(), owned = join(output, runId), profile = join(owned, 'profile'), appDir = join(owned, 'app')
const guard = join(owned, 'probe.cjs'), control = join(owned, 'control.json')
const report = { runId, status: 'running', scope: 'production queue-search DOM/preload/player; generated WAV only; external HTTP blocked; no real sources/listening', checks: [], profileRemoved: false }
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
  try { child = spawn(join(process.env.JJ_CROSSFADE_ELECTRON_DIST ?? join(root, 'node_modules/electron/dist'), 'electron.exe'), [guard, `--user-data-dir=${profile}`, '--disable-background-networking'], { cwd: root, windowsHide: true, stdio: ['ignore', log, log], env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined, NODE_OPTIONS: undefined, JJ_ALLOW_DEBUG_PORT: '1', JJ_DEBUG_PORT: String(port) } }) }
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
const rows=Array.from({length:3},(_,i)=>({id:'a'+i,path:join(owned,'a'+i+'.wav'),name:['Alpha','Ｆｏｃｕｓ','Gamma'][i],singer:i===1?'Artist':'North',albumName:'Night',duration:180}))
const second=[rows[1],{id:'b1',path:join(owned,'b1.wav'),name:'Beta',singer:'South',albumName:'Day',duration:180}]
const navigate=async path=>{await evaluate(`location.hash=${JSON.stringify('#'+path)}`);await wait(()=>evaluate('return !document.querySelector(".fade-enter-active,.fade-leave-active")'),'route transition');await sleep(100)}
const query=async value=>{await evaluate(`const e=document.querySelector('[aria-label=在播放列表内搜索]');e.value=${JSON.stringify(value)};e.dispatchEvent(new Event('input',{bubbles:true}))`);await sleep(100)}
const panelRows=()=>evaluate('return document.querySelectorAll(".np-panel .track-row").length')
const labelClick=label=>evaluate(`const e=document.querySelector('[aria-label="'+${JSON.stringify(label)}+'"]');if(!e||e.disabled)throw Error('unavailable '+${JSON.stringify(label)});e.click()`)
const menuClick=text=>evaluate(`const e=[...document.querySelectorAll('[role=menuitem]')].find(e=>e.textContent.trim()===${JSON.stringify(text)});if(!e||e.disabled)throw Error('menu unavailable '+${JSON.stringify(text)});e.click()` )
const playbackSubmenu=async text=>{await labelClick('播放更多选项');await sleep(70);await menuClick(text);await sleep(70)}
const panelClick=text=>evaluate(`const e=[...document.querySelectorAll('.np-panel button')].find(e=>e.textContent.trim()===${JSON.stringify(text)});if(!e||e.disabled)throw Error('panel button unavailable '+${JSON.stringify(text)});e.click()`)
const open=async()=>{await labelClick('播放队列');await wait(()=>evaluate('return !!document.querySelector(".np-panel")'),'queue panel')}
try{
 await mkdir(join(profile,'library'),{recursive:true});await cp(join(root,'out'),appDir,{recursive:true})
 const wav=Buffer.alloc(2880044);wav.write('RIFF');wav.writeUInt32LE(wav.length-8,4);wav.write('WAVEfmt ',8);wav.writeUInt32LE(16,16);wav.writeUInt16LE(1,20);wav.writeUInt16LE(1,22);wav.writeUInt32LE(8000,24);wav.writeUInt32LE(16000,28);wav.writeUInt16LE(2,32);wav.writeUInt16LE(16,34);wav.write('data',36);wav.writeUInt32LE(wav.length-44,40)
 for(const row of [...rows,second[1]])await writeFile(row.path,wav)
 await writeFile(join(profile,'library/index.json'),JSON.stringify({version:5,folders:[],tracks:[...rows,second[1]]}))
 const lists=[{id:'default',name:'默认列表',source:'local',position:0},{id:'favorites',name:'我喜欢的',source:'local',position:1},{id:'a',name:'Queue A',source:'local',position:2},{id:'b',name:'Queue B',source:'local',position:3}]
 await writeFile(join(profile,'playlists.json'),JSON.stringify({version:1,playlists:lists,items:{default:[],favorites:[],a:rows,b:second}}))
 await writeFile(join(profile,'settings.json'),JSON.stringify({libraryFolders:[],onlineLyricSource:'off',onlineLyricFallback:false,showSearchHotWords:false,minimizeToTray:false,manualCrossfadeDurationMs:3000}))
 await writeFile(guard,`const {app,BrowserWindow,session}=require('electron');BrowserWindow.prototype.show=function(){};app.on('browser-window-created',(_,w)=>w.webContents.setBackgroundThrottling(false));globalThis.fetch=async()=>{throw Error('External HTTP blocked')};app.whenReady().then(()=>session.defaultSession.webRequest.onBeforeRequest({urls:['http://*/*','https://*/*']},(_,cb)=>cb({cancel:true})));import(${JSON.stringify(pathToFileURL(join(appDir,'main/index.js')).href)}).catch(e=>{console.error(e);app.exit(1)});`)
 await launch();await send('Runtime.enable');await navigate('/playlist/a');await wait(()=>evaluate('return document.querySelectorAll(".playlist-view .track-row").length===3'),'playlist A')
 await evaluate('window.__manualDecks=[];const OriginalAudio=window.Audio;window.Audio=new Proxy(OriginalAudio,{construct(t,args){const a=new t(...args);window.__manualDecks.push(a);return a}})')
 await evaluate('document.querySelectorAll(".playlist-view .track-row")[0].dispatchEvent(new MouseEvent("dblclick",{bubbles:true}))')
 await wait(()=>evaluate('return navigator.mediaSession.playbackState==="playing"'),'generated playing')
 await labelClick('播放更多选项');await sleep(100)
 check('AB loop controls exist in production playback menu',await evaluate('return [...document.querySelectorAll("[role=menuitem]")].some(e=>e.textContent.trim()==="A–B 片段循环")'))
 await evaluate('document.querySelector(".menu-layer").dispatchEvent(new PointerEvent("pointerdown",{bubbles:true}))')
 await evaluate('window.__manualDecks.find(a=>!a.paused).currentTime=10');await sleep(350)
 await playbackSubmenu('A–B 片段循环');await menuClick('设置 A 点（当前进度）')
 await evaluate('window.__manualDecks.find(a=>!a.paused).currentTime=12');await sleep(350)
 await playbackSubmenu('A–B 片段循环');await menuClick('设置 B 点（当前进度）');await sleep(350)
 check('AB menu sets endpoints and production media loops back',await evaluate('return document.querySelector(".mini-lyric").textContent.includes("A–B")&&window.__manualDecks.find(a=>!a.paused).currentTime<12'))
 await playbackSubmenu('A–B 片段循环');await menuClick('清除 A–B');await sleep(100)
 check('AB menu clear removes loop status',await evaluate('return !document.querySelector(".mini-lyric").textContent.includes("A–B")'))
 await playbackSubmenu('睡眠定时');await menuClick('到点播完当前曲再停止')
 await playbackSubmenu('睡眠定时');await menuClick('15 分钟后停止');await sleep(100)
 report.sleepCountdown=await evaluate('return document.querySelector(".mini-lyric").textContent');
 check('sleep menu starts a visible countdown',await evaluate('return document.querySelector(".mini-lyric").textContent.includes("睡眠定时 15 分钟")'))
 await playbackSubmenu('睡眠定时');await menuClick('关闭定时');await sleep(100)
 check('sleep cancellation removes countdown',await evaluate('return !document.querySelector(".mini-lyric").textContent.includes("睡眠定时")'))
 await open()
 check('search input exists in production panel',await evaluate('return !!document.querySelector("[aria-label=在播放列表内搜索]")'))
 check('unfiltered full queue visible',(await panelRows())===3)
 await evaluate('window.__manualHints=[];new MutationObserver(()=>{window.__manualHints.push(document.querySelector(".mini-lyric")?.textContent||"")}).observe(document.body,{subtree:true,childList:true,characterData:true})')
 await query('focus artist night');check('normalized metadata multi-term filter',(await panelRows())===1)
 check('match count retains complete total',await evaluate('return document.querySelector(".queue-search").textContent.includes("1 / 3")'))
 check('filtered drag disabled',await evaluate('return [...document.querySelectorAll(".np-panel .track-row")].every(e=>!e.draggable)'))
 await evaluate('document.querySelector(".np-panel .track-row").dispatchEvent(new MouseEvent("dblclick",{bubbles:true}))')
 await wait(()=>evaluate('return document.querySelector(".np-panel__count b").textContent==="2"'),'original full-list index')
 check('filtered click uses original index',true)
 check('manual current-queue click overlaps two production media decks',await evaluate('return window.__manualDecks.filter(a=>!a.paused&&a.currentSrc).length===2'))
 check('pending target feedback uses existing player status',await evaluate('return window.__manualHints.some(t=>t.includes("正在准备切换至"))'))
 await panelClick('清空搜索');await wait(async()=> (await panelRows())===3,'clear filter full queue')
 check('clear restores complete queue and dragging',await evaluate('return [...document.querySelectorAll(".np-panel .track-row")].every(e=>e.draggable)'))
 await query('missing');check('empty filter is explicit',await evaluate('return document.querySelector(".np-panel").textContent.includes("没有匹配的歌曲")'))
 await panelClick('当前播放');await wait(async()=> (await panelRows())===3,'locate clears filter')
 check('locate clears query and selects current original row',await evaluate('return document.querySelector("[aria-label=在播放列表内搜索]").value===""&&document.querySelector(".np-panel .track-row.selected").textContent.includes("Ｆｏｃｕｓ")'))
 await query('Focus');await evaluate('document.querySelector("[aria-label=在播放列表内搜索]").dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",bubbles:true,cancelable:true}))');await sleep(100)
 check('first Escape clears query and keeps panel',await evaluate('return !!document.querySelector(".np-panel")&&document.querySelector("[aria-label=在播放列表内搜索]").value===""'))
 await query('Focus');await labelClick('关闭播放面板');await open()
 check('reopening panel clears query',await evaluate('return document.querySelector("[aria-label=在播放列表内搜索]").value===""'))
 await query('Gamma');await evaluate('document.querySelector(".np-panel .row-remove").click()')
 await panelClick('清空搜索');await wait(async()=> (await panelRows())===2,'remove filtered only')
 check('filtered remove keeps hidden order',await evaluate('return [...document.querySelectorAll(".np-panel .track-row")].map(e=>e.textContent).join("|").includes("Alpha")&&!document.querySelector(".np-panel").textContent.includes("Gamma")'))
 check('queue removal leaves saved playlist intact',(await evaluate('return await window.jj.playlists.items("a")')).length===3)
 await labelClick('关闭播放面板');await navigate('/playlist/b');await wait(()=>evaluate('return document.querySelectorAll(".playlist-view .track-row").length===2'),'playlist B')
 await evaluate('document.querySelectorAll(".playlist-view .track-row")[1].dispatchEvent(new MouseEvent("dblclick",{bubbles:true}))');await wait(()=>evaluate('return document.querySelector(".mini-meta strong").textContent==="Beta"'),'new queue commit');check('playlist new queue uses protected overlap',await evaluate('return window.__manualDecks.filter(a=>!a.paused&&a.currentSrc).length===2'));await open()
 await query('Beta');await labelClick('更早的列表');await wait(()=>evaluate('return document.querySelector("[aria-label=在播放列表内搜索]").value===""'),'history query reset')
 check('history page shows saved full range',(await panelRows())===2)
 check('history drag and row remove disabled',await evaluate('return !document.querySelector(".np-panel .row-remove")&&[...document.querySelectorAll(".np-panel .track-row")].every(e=>!e.draggable)'))
 await query('Focus');await evaluate('document.querySelector(".np-panel .track-row").dispatchEvent(new MouseEvent("contextmenu",{bubbles:true,clientX:500,clientY:350}))');await sleep(100)
 check('history menu cannot remove live collision',await evaluate('return ![...document.querySelectorAll("[role=menuitem]")].some(e=>e.textContent.includes("从播放列表移除"))'))
 await evaluate('document.querySelector(".menu-layer").dispatchEvent(new PointerEvent("pointerdown",{bubbles:true}))')
 await wait(()=>evaluate('return !document.querySelector(".menu-layer")'),'menu dismissed')
 await labelClick('更新的列表');await wait(()=>evaluate('return document.querySelector("[aria-label=在播放列表内搜索]").value===""'),'current page query reset')
 check('browsing history did not replace live queue',await evaluate('return document.querySelector(".np-panel").textContent.includes("Beta")&&document.querySelectorAll(".np-panel .track-row").length===2'))
 await labelClick('更早的列表');await query('Focus')
 const shot=await send('Page.captureScreenshot',{format:'png'});report.screenshot=join(output,runId+'-history.png');await writeFile(report.screenshot,Buffer.from(shot.data,'base64'))
 await evaluate('document.querySelector(".np-panel .track-row").dispatchEvent(new MouseEvent("dblclick",{bubbles:true}))')
 await wait(()=>evaluate('return document.querySelector(".np-panel__count b").textContent==="2"&&document.querySelector("[aria-label=在播放列表内搜索]").value===""'),'filtered history playback')
 check('history restore uses legacy single-deck playback',await evaluate('return window.__manualDecks.filter(a=>!a.paused&&a.currentSrc).length===1'))
 check('history filtered play restores complete snapshot',await evaluate('return document.querySelectorAll(".np-panel .track-row").length===2&&document.querySelector(".np-panel").textContent.includes("Alpha")&&!document.querySelector(".np-panel").textContent.includes("Beta")'))
 await evaluate('document.querySelector("[aria-label=在播放列表内搜索]").dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",bubbles:true,cancelable:true}))');await wait(()=>evaluate('return !document.querySelector(".np-panel")'),'empty search Escape closes')
 check('empty-query Escape closes panel',true)
 await close();const session=JSON.parse(await readFile(join(profile,'settings.json'),'utf8')).lastSession
 check('final session preserves full snapshot and original index',session?.queue?.length===2&&session.index===1&&session.track.id==='a1'&&session.queue[0].id==='a0')
 report.rendererErrors=rendererErrors;check('no renderer errors',rendererErrors.length===0);report.status='passed'
}catch(error){report.status='failed';report.error=error.stack||String(error);process.exitCode=1}
finally{
 socket?.close();for(const p of pending.values()){clearTimeout(p.timer);p.no(Error('probe closed'))}
 if(child&&child.exitCode===null){child.kill();await sleep(300)}
 assert.ok(resolve(owned).startsWith(resolve(output)+sep)&&dirname(owned)===output)
 await rm(owned,{recursive:true,force:true,maxRetries:5,retryDelay:100});report.profileRemoved=true
 await writeFile(join(output,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report))
}
