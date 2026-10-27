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
 lists.push({id:'duplicates',name:'Duplicate queue',source:'local',position:4})
 const duplicateRows=[rows[0],rows[1],{...rows[0],name:'Alpha duplicate'},rows[2],rows[1]]
 await writeFile(join(profile,'playlists.json'),JSON.stringify({version:1,playlists:lists,items:{default:[],favorites:[],a:rows,b:second,duplicates:duplicateRows}}))
 await writeFile(join(profile,'settings.json'),JSON.stringify({libraryFolders:[],onlineLyricSource:'off',onlineLyricFallback:false,showSearchHotWords:false,minimizeToTray:false,manualCrossfadeDurationMs:3000}))
 await writeFile(guard,`const {app,BrowserWindow,session}=require('electron');BrowserWindow.prototype.show=function(){};app.on('browser-window-created',(_,w)=>w.webContents.setBackgroundThrottling(false));globalThis.fetch=async()=>{throw Error('External HTTP blocked')};app.whenReady().then(()=>session.defaultSession.webRequest.onBeforeRequest({urls:['http://*/*','https://*/*']},(_,cb)=>cb({cancel:true})));import(${JSON.stringify(pathToFileURL(join(appDir,'main/index.js')).href)}).catch(e=>{console.error(e);app.exit(1)});`)
 await launch();await send('Runtime.enable');await navigate('/playlist/a');await wait(()=>evaluate('return document.querySelectorAll(".playlist-view .track-row").length===3'),'playlist A')
 await evaluate('window.__manualDecks=[];window.__manualPlayEvents=0;const OriginalAudio=window.Audio;window.Audio=new Proxy(OriginalAudio,{construct(t,args){const a=new t(...args);a.addEventListener("playing",()=>window.__manualPlayEvents++);window.__manualDecks.push(a);return a}})')
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
 await labelClick('暂停');await wait(()=>evaluate('return navigator.mediaSession.playbackState==="paused"'),'paused for input')
 await playbackSubmenu('A–B 片段循环');await menuClick('输入 A/B 时间…');await wait(()=>evaluate(`return !!document.querySelector('[aria-label="A 点时间"]')`),'loop time dialog')
 const fillRange=(a,b)=>evaluate(`for(const [label,value] of ${JSON.stringify([['A 点时间',a],['B 点时间',b]])}){const e=document.querySelector('[aria-label="'+label+'"]');e.value=value;e.dispatchEvent(new Event('input',{bubbles:true}))}document.querySelector('[aria-label="输入 A/B 时间"]').dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}))`)
 await fillRange('4','4.5');await sleep(80);check('loop time invalid range stays open with a useful error',await evaluate(`return document.querySelector('[aria-label="输入 A/B 时间"] [role=alert]')?.textContent.includes('至少1秒')`))
 await fillRange('0:12.125','0:14.375');await wait(()=>evaluate(`return !document.querySelector('[aria-label="输入 A/B 时间"]')`),'loop input applied')
 check('loop time input enables precise endpoints without resuming',await evaluate('return navigator.mediaSession.playbackState==="paused"&&window.__manualDecks.some(a=>Math.abs(a.currentTime-12.125)<0.1)&&document.querySelector(".mini-lyric").textContent.includes("A–B")'))
 await playbackSubmenu('A–B 片段循环');await menuClick('清除 A–B');await labelClick('播放');await wait(()=>evaluate('return navigator.mediaSession.playbackState==="playing"'),'resume after input')
 await playbackSubmenu('睡眠定时');await menuClick('结束前渐弱');await sleep(70);await menuClick('最后 10 秒渐弱')
 await playbackSubmenu('睡眠定时');await menuClick('结束前渐弱');await sleep(70)
 check('sleep fade choice is retained in the production menu',await evaluate('const item=[...document.querySelectorAll("[role=menuitem]")].find(e=>e.textContent.trim()==="最后 10 秒渐弱");return item?.querySelector("svg")?.style.opacity==="1"'))
 await evaluate('document.querySelector(".menu-layer").dispatchEvent(new PointerEvent("pointerdown",{bubbles:true}))')
 await playbackSubmenu('睡眠定时');await menuClick('到点播完当前曲再停止')
 await playbackSubmenu('睡眠定时');await menuClick('15 分钟后停止');await sleep(100)
 report.sleepCountdown=await evaluate('return document.querySelector(".mini-lyric").textContent');
 check('sleep menu starts a visible countdown',await evaluate('return document.querySelector(".mini-lyric").textContent.includes("睡眠定时 15 分钟")'))
 await playbackSubmenu('睡眠定时');await menuClick('关闭定时');await sleep(100)
 check('sleep cancellation removes countdown',await evaluate('return !document.querySelector(".mini-lyric").textContent.includes("睡眠定时")'))
 await open()
 check('queue dedup button exists and is disabled for unique current queue',await evaluate('const b=[...document.querySelectorAll(".np-panel button")].find(b=>b.textContent.trim()==="队列去重");return !!b&&b.disabled'))
 check('search input exists in production panel',await evaluate('return !!document.querySelector("[aria-label=在播放列表内搜索]")'))
 check('unfiltered full queue visible',(await panelRows())===3)
 await evaluate('window.__manualHints=[];new MutationObserver(()=>{window.__manualHints.push(document.querySelector(".mini-lyric")?.textContent||"")}).observe(document.body,{subtree:true,childList:true,characterData:true})')
 await query('focus artist night');check('normalized metadata multi-term filter',(await panelRows())===1)
 const savedBefore=await evaluate('return (await window.jj.playlists.list()).length')
 await panelClick('保存为新歌单');await wait(()=>evaluate('return !!document.querySelector("[role=dialog]")'),'queue save dialog')
 check('queue save dialog explains full filtered snapshot',await evaluate('return document.querySelector("[role=dialog]").textContent.includes("完整队列")&&document.querySelector("[role=dialog]").textContent.includes("3 首")'))
 await evaluate('document.querySelector("[role=dialog] button[type=button]").click()');check('queue save cancel writes nothing',(await evaluate('return (await window.jj.playlists.list()).length'))===savedBefore)
 await panelClick('保存为新歌单');await wait(()=>evaluate('return !!document.querySelector("[role=dialog] input")'),'queue save name')
 check('queue save disables another request while its dialog is open',await evaluate('return [...document.querySelectorAll(".np-panel button")].find(e=>e.textContent.trim()==="保存为新歌单")?.disabled===true'))
 await navigate('/playlist/b');await wait(()=>evaluate('return document.querySelectorAll(".playlist-view .track-row").length===2'),'replacement playlist during dialog')
 await evaluate('document.querySelectorAll(".playlist-view .track-row")[1].dispatchEvent(new MouseEvent("dblclick",{bubbles:true}))');await wait(()=>evaluate('return document.querySelector(".mini-meta strong").textContent==="Beta"'),'queue replaced while name dialog open')
 await evaluate('const input=document.querySelector("[role=dialog] input"),form=document.querySelector("[role=dialog]");input.value="Saved full queue";input.dispatchEvent(new Event("input",{bubbles:true}));form.dispatchEvent(new Event("submit",{bubbles:true,cancelable:true}));form.dispatchEvent(new Event("submit",{bubbles:true,cancelable:true}))')
 await wait(()=>evaluate('return (await window.jj.playlists.list()).some(p=>p.name==="Saved full queue")'),'saved queue durable')
 const saved=await evaluate('const p=(await window.jj.playlists.list()).find(p=>p.name==="Saved full queue");return await window.jj.playlists.items(p.id)')
 check('queue save preserves complete order despite search',saved.length===3&&saved.every((r,i)=>r.id===rows[i].id))
 check('queue replacement and duplicate submit still save exactly one original snapshot',(await evaluate('return (await window.jj.playlists.list()).length'))===savedBefore+1)
 await navigate('/playlist/a');await wait(()=>evaluate('return document.querySelectorAll(".playlist-view .track-row").length===3'),'return to initial playlist')
 await evaluate('document.querySelectorAll(".playlist-view .track-row")[0].dispatchEvent(new MouseEvent("dblclick",{bubbles:true}))');await wait(()=>evaluate('return document.querySelector(".mini-meta strong").textContent==="Alpha"'),'restore initial queue after save acceptance')
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
 check('historical page offers save without enabling queue editing',await evaluate('return [...document.querySelectorAll(".np-panel button")].some(b=>b.textContent.trim()==="保存为新歌单"&&!b.disabled)'))
 const originalHistoryNames=await evaluate('return [...document.querySelectorAll(".np-panel .track-label strong")].map(e=>e.textContent.trim())')
 const historySaveCount=await evaluate('return (await window.jj.playlists.list()).length'),historySaveStarts=await evaluate('return window.__manualPlayEvents')
 await query('Focus');await panelClick('保存为新歌单');await wait(()=>evaluate('return !!document.querySelector("[role=dialog] input")'),'history name dialog')
 check('history save dialog identifies full source and default name',await evaluate('return document.querySelector("[role=dialog]").textContent.includes("历史队列")&&document.querySelector("[role=dialog]").textContent.includes("2 首")&&document.querySelector("[role=dialog] input").value.startsWith("历史队列 ")'))
 await labelClick('更新的列表')
 await evaluate('const input=document.querySelector("[role=dialog] input"),form=document.querySelector("[role=dialog]");input.value="Saved historical queue";input.dispatchEvent(new Event("input",{bubbles:true}));form.dispatchEvent(new Event("submit",{bubbles:true,cancelable:true}));form.dispatchEvent(new Event("submit",{bubbles:true,cancelable:true}))')
 await wait(()=>evaluate('return (await window.jj.playlists.list()).some(p=>p.name==="Saved historical queue")'),'historical queue saved')
 const historySaved=await evaluate('const p=(await window.jj.playlists.list()).find(p=>p.name==="Saved historical queue");return await window.jj.playlists.items(p.id)')
 check('filtered historical save survives paging with original full order',JSON.stringify(historySaved.map(r=>`${r.singer} — ${r.name}`))===JSON.stringify(originalHistoryNames))
 check('historical save creates once and leaves current playback untouched',(await evaluate('return (await window.jj.playlists.list()).length'))===historySaveCount+1&&await evaluate(`return navigator.mediaSession.playbackState==='playing'&&document.querySelector('.mini-meta strong').textContent==='Beta'&&window.__manualPlayEvents===${historySaveStarts}`))
 await labelClick('更早的列表');await wait(()=>panelRows().then(n=>n===2),'return to original historical page')
 check('history drag and row remove disabled',await evaluate('return !document.querySelector(".np-panel .row-remove")&&[...document.querySelectorAll(".np-panel .track-row")].every(e=>!e.draggable)'))
 await query('Focus');await evaluate('document.querySelector(".np-panel .track-row").dispatchEvent(new MouseEvent("contextmenu",{bubbles:true,clientX:500,clientY:350}))');await sleep(100)
 check('history menu cannot remove live collision',await evaluate('return ![...document.querySelectorAll("[role=menuitem]")].some(e=>e.textContent.includes("从播放列表移除"))'))
 check('history menu excludes all new bulk editing actions',await evaluate('return ![...document.querySelectorAll("[role=menuitem]")].some(e=>/从队列移除|移到当前曲之后|移到队尾/.test(e.textContent))'))
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
 const selectQueueRows=async(indexes,shift=false)=>{await evaluate(`const rows=[...document.querySelectorAll('.np-panel .track-row')];for(const [i,index] of ${JSON.stringify(indexes)}.entries())rows[index].dispatchEvent(new MouseEvent('click',{bubbles:true,ctrlKey:i>0&&!${shift},shiftKey:i>0&&${shift}}))`);await sleep(80)}
 const queueToolbarMore=()=>evaluate('const b=[...document.querySelectorAll(".np-panel .selection-toolbar button")].find(e=>e.textContent.trim()==="更多");if(!b)throw Error("selection toolbar missing");b.click()')
 const cancelQueueDialog=()=>evaluate('document.querySelector("[role=dialog] button[type=button]").click()')
 const confirmQueueDialog=()=>evaluate('document.querySelector("[role=dialog]").dispatchEvent(new Event("submit",{bubbles:true,cancelable:true}))')
 await selectQueueRows([0,1]);await evaluate('document.querySelector(".np-panel .track-row").dispatchEvent(new MouseEvent("contextmenu",{bubbles:true,clientX:500,clientY:350}))');await sleep(80);await menuClick('从队列移除 2 首')
 await wait(()=>evaluate('return !!document.querySelector("[role=dialog]")'),'bulk current removal confirmation')
 check('bulk row menu warns before removing current',await evaluate('return document.querySelector("[role=dialog]").textContent.includes("停止播放")'))
 await cancelQueueDialog();check('cancelled bulk removal preserves queue and playback',(await panelRows())===2&&await evaluate('return navigator.mediaSession.playbackState==="playing"'))
 const stageFullQueueA=async()=>{
  await labelClick('关闭播放面板');await navigate('/playlist/a');await wait(()=>evaluate('return document.querySelectorAll(".playlist-view .track-row").length===3'),'full A for management')
  const previousStarts=await evaluate('return window.__manualPlayEvents')
  await evaluate('document.querySelectorAll(".playlist-view .track-row")[1].dispatchEvent(new MouseEvent("dblclick",{bubbles:true}))');await open();await query('')
  await wait(()=>evaluate(`const active=window.__manualDecks.filter(a=>!a.paused&&a.currentSrc);return window.__manualPlayEvents>${previousStarts}&&!document.querySelector('.transport__play .spinner')&&document.querySelectorAll('.np-panel .track-row').length===3&&document.querySelector('.np-panel__count b').textContent==='2'&&navigator.mediaSession.playbackState==='playing'&&active.length===1&&active[0].readyState>=3&&active[0].currentTime>0.05`),'full A current settled')
 }
 const queueNames=()=>evaluate('return [...document.querySelectorAll(".np-panel .track-label strong")].map(e=>e.textContent.trim())')
 const rowLabel=r=>`${r.singer} — ${r.name}`
 await stageFullQueueA();const beforeBulkTime=await evaluate('return window.__manualDecks.find(a=>!a.paused&&a.currentSrc).currentTime');report.bulkBefore=await evaluate('return {index:document.querySelector(".np-panel__count b").textContent,audio:window.__manualDecks.map(a=>({time:a.currentTime,paused:a.paused,src:a.currentSrc}))}')
 await selectQueueRows([0,2]);await queueToolbarMore();await sleep(70);await menuClick('移到当前曲之后');await sleep(100)
 check('toolbar moves noncontiguous selection in original order',JSON.stringify(await queueNames())===JSON.stringify([rows[1],rows[0],rows[2]].map(rowLabel)))
 report.bulkAfter=await evaluate('return {index:document.querySelector(".np-panel__count b").textContent,audio:window.__manualDecks.map(a=>({time:a.currentTime,paused:a.paused,src:a.currentSrc}))}')
 check('batch move preserves current media clock',await evaluate(`return document.querySelector('.np-panel__count b').textContent==='1'&&window.__manualDecks.find(a=>!a.paused&&a.currentSrc).currentTime>=${beforeBulkTime}`))
 await selectQueueRows([0,1]);await queueToolbarMore();await sleep(70);await menuClick('移到队尾');await sleep(100)
 check('batch move carries current row with selected block',JSON.stringify(await queueNames())===JSON.stringify([rows[2],rows[1],rows[0]].map(rowLabel))&&await evaluate('return document.querySelector(".np-panel__count b").textContent==="2"&&navigator.mediaSession.playbackState==="playing"'))
 await query('North');await selectQueueRows([0,1]);await queueToolbarMore();await sleep(70);await menuClick('从队列移除 2 首');await wait(()=>evaluate('return !!document.querySelector("[role=dialog]")'),'filtered remove confirmation')
 check('filtered bulk removal describes selected range without stop warning',await evaluate('return document.querySelector("[role=dialog]").textContent.includes("当前歌曲继续播放")'))
 await confirmQueueDialog();await query('');await wait(()=>panelRows().then(n=>n===1),'filtered selected rows removed')
 check('filtered bulk removal keeps hidden current row playing',await evaluate('return document.querySelector(".np-panel__count b").textContent==="1"&&navigator.mediaSession.playbackState==="playing"'))
 check('batch queue edits leave source playlist untouched',(await evaluate('return (await window.jj.playlists.items("a")).length'))===3)
 await stageFullQueueA();await selectQueueRows([0,2],true);await queueToolbarMore();await sleep(70);await menuClick('从队列移除 3 首');await wait(()=>evaluate('return !!document.querySelector("[role=dialog]")'),'shift selected all removal')
 check('Shift selection confirms all rows including current',await evaluate('return document.querySelector("[role=dialog]").textContent.includes("3 首")&&document.querySelector("[role=dialog]").textContent.includes("停止播放")'))
 await confirmQueueDialog();await wait(()=>evaluate('return document.querySelectorAll(".np-panel .track-row").length===0&&navigator.mediaSession.playbackState!=="playing"'),'bulk current removal stops')
 check('bulk current removal releases all media',await evaluate('return window.__manualDecks.every(a=>!a.src)&&document.querySelector(".np-panel__count b").textContent==="—"'))
 await stageFullQueueA();await query('Gamma');await selectQueueRows([0]);await evaluate('const b=[...document.querySelectorAll(".np-panel .selection-toolbar button")].find(e=>e.textContent.trim()==="播放");b.click()')
 await wait(()=>evaluate('return document.querySelector(".mini-meta strong").textContent==="Gamma"'),'unique queue for historical eviction')
 await labelClick('关闭播放面板');await navigate('/playlist/b');await wait(()=>evaluate('return document.querySelectorAll(".playlist-view .track-row").length===2'),'B before historical eviction')
 await evaluate('document.querySelectorAll(".playlist-view .track-row")[1].dispatchEvent(new MouseEvent("dblclick",{bubbles:true}))');await wait(()=>evaluate('return document.querySelector(".mini-meta strong").textContent==="Beta"'),'B current before history capture');await open();await labelClick('更早的列表')
 await wait(()=>evaluate('return document.querySelectorAll(".np-panel .track-row").length===1&&document.querySelector(".np-panel .track-label strong").textContent.includes("Gamma")'),'unique Gamma historical page')
 await panelClick('保存为新歌单');await wait(()=>evaluate('return !!document.querySelector("[role=dialog] input")'),'historical eviction name');await labelClick('更新的列表')
 await navigate('/playlist/a');await wait(()=>evaluate('return document.querySelectorAll(".playlist-view .track-row").length===3'),'A replaces history while naming');await evaluate('document.querySelectorAll(".playlist-view .track-row")[0].dispatchEvent(new MouseEvent("dblclick",{bubbles:true}))');await wait(()=>evaluate('return document.querySelector(".mini-meta strong").textContent==="Alpha"'),'A current evicts history step one')
 const beforeEvictionStart=await evaluate('return window.__manualPlayEvents')
 await evaluate('document.querySelectorAll(".playlist-view .track-row")[0].dispatchEvent(new MouseEvent("click",{bubbles:true}))');await sleep(70)
 await evaluate('const b=[...document.querySelectorAll(".playlist-view .selection-toolbar button")].find(e=>e.textContent.trim()==="播放");b.click()')
 await wait(()=>evaluate(`return window.__manualPlayEvents>${beforeEvictionStart}&&!document.querySelector('.transport__play .spinner')&&document.querySelectorAll('.np-panel .track-row').length===1&&document.querySelector('.mini-meta strong').textContent==='Alpha'&&navigator.mediaSession.playbackState==='playing'`),'third distinct Alpha-only queue evicts captured history')
 await labelClick('更早的列表');await wait(()=>panelRows().then(n=>n===3),'history now contains full A');await labelClick('更早的列表');await wait(()=>panelRows().then(n=>n===2),'history now contains full B')
 check('captured single-track history is evicted while naming',await evaluate('return document.querySelector(".np-panel__pager").textContent.includes("3 / 3")&&document.querySelectorAll(".np-panel .track-row").length===2'))
 await evaluate('const input=document.querySelector("[role=dialog] input");input.value="Saved evicted history";input.dispatchEvent(new Event("input",{bubbles:true}));document.querySelector("[role=dialog]").dispatchEvent(new Event("submit",{bubbles:true,cancelable:true}))')
 await wait(()=>evaluate('return (await window.jj.playlists.list()).some(p=>p.name==="Saved evicted history")'),'evicted history saved')
 const evictedSaved=await evaluate('const p=(await window.jj.playlists.list()).find(p=>p.name==="Saved evicted history");return await window.jj.playlists.items(p.id)')
 check('history save retains captured rows after eviction',evictedSaved.length===1&&evictedSaved[0].id==='a2')
 check('saving evicted history does not restore its playback',await evaluate('return document.querySelector(".mini-meta strong").textContent==="Alpha"&&navigator.mediaSession.playbackState==="playing"'))
 await labelClick('关闭播放面板');await navigate('/playlist/duplicates');await wait(()=>evaluate('return document.querySelectorAll(".playlist-view .track-row").length===5'),'duplicate source playlist')
 await evaluate('document.querySelectorAll(".playlist-view .track-row")[1].dispatchEvent(new MouseEvent("dblclick",{bubbles:true}))');await open()
 await wait(()=>evaluate('return document.querySelector(".np-panel__count b").textContent==="2"&&document.querySelectorAll(".np-panel .track-row").length===5&&window.__manualDecks.filter(a=>!a.paused&&a.currentSrc).length===1'),'duplicate queue settled')
 await query('Gamma');await panelClick('队列去重');await wait(()=>evaluate('return !!document.querySelector("[role=dialog]")'),'dedup confirmation')
 check('filtered dedup preview uses full queue and protects current row',await evaluate('const text=document.querySelector("[role=dialog]").textContent;return text.includes("共 5 首")&&text.includes("保留 3 首")&&text.includes("2 个重复条目")&&text.includes("播放进度")&&text.includes("搜索筛选不缩小范围")'))
 check('dedup dialog holds busy button against repeat clicks',await evaluate('return [...document.querySelectorAll(".np-panel button")].find(b=>b.textContent.trim()==="队列去重").disabled'))
 await cancelQueueDialog();await query('');check('dedup cancel leaves full queue playing',(await panelRows())===5&&await evaluate('return navigator.mediaSession.playbackState==="playing"'))
 await panelClick('队列去重');await evaluate('document.querySelectorAll(".playlist-view .track-row")[3].dispatchEvent(new MouseEvent("dblclick",{bubbles:true}))')
 await wait(()=>evaluate('return document.querySelector(".mini-meta strong").textContent==="Gamma"'),'switch during dedup confirmation')
 await confirmQueueDialog();await sleep(100)
 check('stale dedup confirmation refuses changed playback',(await panelRows())===5&&await evaluate('return document.body.textContent.includes("重新打开整理")'))
 await wait(()=>evaluate('return window.__manualDecks.filter(a=>!a.paused&&a.currentSrc).length===1'),'dedup handoff settles')
 const dedupTime=await evaluate('return window.__manualDecks.find(a=>!a.paused&&a.currentSrc).currentTime'),dedupStarts=await evaluate('return window.__manualPlayEvents')
 await query('Gamma');await panelClick('队列去重');await evaluate('const d=document.querySelector("[role=dialog]");d.dispatchEvent(new Event("submit",{bubbles:true,cancelable:true}));d.dispatchEvent(new Event("submit",{bubbles:true,cancelable:true}))')
 await wait(()=>evaluate('return !document.querySelector("[role=dialog]")'),'dedup submitted');await query('')
 check('dedup keeps first identity rows in full original relative order',JSON.stringify(await queueNames())===JSON.stringify(rows.map(rowLabel)))
 check('dedup preserves actual media clock and starts no new playback',await evaluate(`return navigator.mediaSession.playbackState==='playing'&&window.__manualPlayEvents===${dedupStarts}&&window.__manualDecks.find(a=>!a.paused&&a.currentSrc).currentTime>=${dedupTime}`))
 check('dedup leaves source duplicates intact',(await evaluate('return (await window.jj.playlists.items("duplicates")).length'))===5)
 await selectQueueRows([0,1]);await queueToolbarMore();await sleep(70)
 check('dedup restores batch menu availability',await evaluate('return [...document.querySelectorAll("[role=menuitem]")].some(e=>e.textContent.trim()==="移到队尾"&&!e.disabled)'))
 await evaluate('document.querySelector(".menu-layer").dispatchEvent(new PointerEvent("pointerdown",{bubbles:true}))');await labelClick('更早的列表')
 check('historical queue has no dedup entry',await evaluate('return ![...document.querySelectorAll(".np-panel button")].some(b=>b.textContent.trim()==="队列去重")'))
 await stageFullQueueA();await query('Gamma');await evaluate('document.querySelector(".np-panel .row-remove").click()');await query('');await wait(()=>panelRows().then(n=>n===2),'restore legacy final queue')
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
