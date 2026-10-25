/** Production playlist management acceptance in an owned Electron profile; only HTTP responses are synthetic. */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { cp, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { openSync, closeSync } from 'node:fs'
import { createServer } from 'node:net'
import { dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..'), output = join(root, '.cache/playlist-filter-backup-ui')
const runId = randomUUID(), owned = join(output, runId), profile = join(owned, 'profile'), appDir = join(owned, 'app')
const guard = join(owned, 'probe.cjs'), control = join(owned, 'control.json')
const report = { runId, status: 'running', scope: 'production DOM/preload/main/stores/files; generated WAV only; native picker fixture, actual atomic writes; all external HTTP blocked; no real sources/listening', checks: [], profileRemoved: false }
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
const exportFile=join(owned,'single.json'),allFile=join(owned,'all.json')
const rows=Array.from({length:3},(_,i)=>({id:'local-'+i,path:join(owned,'track-'+i+'.wav'),name:['Morning','Ｆｏｃｕｓ','Evening'][i],singer:i===1?'Artist':'Other',albumName:'Night',duration:60}))
const setQuery=async value=>{await evaluate(`const e=document.querySelector('[aria-label=在歌单内搜索]');e.value=${JSON.stringify(value)};e.dispatchEvent(new Event('input',{bubbles:true}))`);await sleep(120)}
const navigate=async path=>{await evaluate(`location.hash=${JSON.stringify('#'+path)}`);await wait(()=>evaluate('return !document.querySelector(".fade-enter-active,.fade-leave-active")'),'route transition');await sleep(120)}
const confirmExport=async text=>{await click(text);await wait(()=>evaluate('return !!document.querySelector("[role=dialog]")'),'export confirmation');await evaluate('document.querySelector("[role=dialog] form")?.requestSubmit();document.querySelector("form[role=dialog]")?.requestSubmit()')}
try{
 await mkdir(join(profile,'library'),{recursive:true});await cp(join(root,'out'),appDir,{recursive:true})
 const wav=Buffer.alloc(960044);wav.write('RIFF');wav.writeUInt32LE(wav.length-8,4);wav.write('WAVEfmt ',8);wav.writeUInt32LE(16,16);wav.writeUInt16LE(1,20);wav.writeUInt16LE(1,22);wav.writeUInt32LE(8000,24);wav.writeUInt32LE(16000,28);wav.writeUInt16LE(2,32);wav.writeUInt16LE(16,34);wav.write('data',36);wav.writeUInt32LE(wav.length-44,40)
 for(const row of rows)await writeFile(row.path,wav)
 const lists=[{id:'default',name:'默认列表',source:'local',position:0},{id:'favorites',name:'我喜欢的',source:'local',position:1},{id:'test',name:'测试歌单',source:'local',position:2},{id:'empty',name:'测试空歌单',source:'local',position:3}]
 await writeFile(join(profile,'library/index.json'),JSON.stringify({version:5,folders:[],tracks:rows}))
 await writeFile(join(profile,'playlists.json'),JSON.stringify({version:1,playlists:lists,items:{default:[],favorites:[],test:rows,empty:[]}}))
 await writeFile(join(profile,'settings.json'),JSON.stringify({libraryFolders:[],onlineLyricSource:'off',onlineLyricFallback:false,showSearchHotWords:false,minimizeToTray:false}))
 await writeFile(control,JSON.stringify({path:exportFile}))
 await writeFile(guard,`const {app,BrowserWindow,dialog,session}=require('electron');const fs=require('node:fs');BrowserWindow.prototype.show=function(){};dialog.showSaveDialog=async()=>{const c=JSON.parse(fs.readFileSync(${JSON.stringify(control)},'utf8'));return {canceled:!!c.cancel,filePath:c.path}};app.on('browser-window-created',(_,w)=>w.webContents.setBackgroundThrottling(false));globalThis.fetch=async()=>{throw Error('Unexpected network')};app.whenReady().then(()=>session.defaultSession.webRequest.onBeforeRequest({urls:['http://*/*','https://*/*']},(_,cb)=>cb({cancel:true})));import(${JSON.stringify(pathToFileURL(join(appDir,'main/index.js')).href)}).catch(e=>{console.error(e);app.exit(1)});`)
 await launch();await send('Runtime.enable');check('owned data profile',resolve((await evaluate('return await window.jj.data.location()')).dir).toLowerCase()===profile.toLowerCase())
 await navigate('/playlist/test');await wait(()=>evaluate('return document.querySelectorAll(".track-row").length===3'),'three tracks')
 check('unfiltered rows reorderable',await evaluate('return [...document.querySelectorAll(".track-row")].every(e=>e.draggable)'))
 await setQuery('focus artist night');await wait(()=>evaluate('return document.querySelectorAll(".track-row").length===1'),'normalized match')
 check('normalized all-term metadata search',await evaluate('return document.querySelector(".track-row").textContent.includes("Ｆｏｃｕｓ")'))
 check('filtered reorder disabled',await evaluate('return !document.querySelector(".track-row").draggable'))
 await evaluate('document.querySelector(".track-row").dispatchEvent(new MouseEvent("dblclick",{bubbles:true}))')
 await wait(()=>evaluate('return navigator.mediaSession.playbackState==="playing"'),'generated WAV playing')
 const filteredShot=await send('Page.captureScreenshot',{format:'png'});report.filteredScreenshot=join(output,runId+'-filtered.png');await writeFile(report.filteredScreenshot,Buffer.from(filteredShot.data,'base64'))
 await confirmExport('导出完整歌单')
 await wait(async()=>{try{return JSON.parse(await readFile(exportFile,'utf8')).playlists.length===1}catch{return false}},'single export written')
 let saved=JSON.parse(await readFile(exportFile,'utf8'));check('filtered export contains full saved list',saved.scope==='single'&&saved.playlists[0].tracks.length===3&&saved.playlists[0].tracks[1].id==='local-1')
 await writeFile(control,JSON.stringify({cancel:true}));await confirmExport('导出完整歌单');await sleep(200)
 check('picker cancel preserves file',JSON.parse(await readFile(exportFile,'utf8')).createdAt===saved.createdAt)
 await navigate('/playlist/empty');await wait(()=>evaluate('return document.body.innerText.includes("这个歌单还是空的")'),'empty list')
 check('queries independent between playlists',await evaluate('return document.querySelector("[aria-label=在歌单内搜索]").value===""'))
 await navigate('/playlist/test');await wait(()=>evaluate('return document.querySelectorAll(".track-row").length===1'),'query restored')
 check('query survives route return',await evaluate('return document.querySelector("[aria-label=在歌单内搜索]").value==="focus artist night"'))
 await setQuery('unmatched');check('no match feedback',await evaluate('return document.body.innerText.includes("没有匹配的歌曲")'))
 await click('清空查找');await wait(()=>evaluate('return document.querySelectorAll(".track-row").length===3'),'clear filter')
 check('clear restores all rows and reorder',await evaluate('return [...document.querySelectorAll(".track-row")].every(e=>e.draggable)'))
 await setQuery('focus');await evaluate('document.querySelector(".track-row").dispatchEvent(new MouseEvent("contextmenu",{bubbles:true,clientX:400,clientY:300}))')
 await evaluate('const m=[...document.querySelectorAll("[role=menuitem]")].find(e=>e.textContent.includes("从歌单移除"));if(!m)throw Error("remove menu missing");m.click()')
 await wait(async()=> (await evaluate('return await window.jj.playlists.items("test")')).length===2,'remove visible song')
 check('filtered remove preserves hidden order',(await evaluate('return await window.jj.playlists.items("test")')).map(r=>r.id).join('|')==='local-0|local-2')
 await navigate('/playlists');await wait(()=>evaluate('return !!document.querySelector("[aria-label=筛选已保存歌单]")'),'all playlists')
 await evaluate('const e=document.querySelector("[aria-label=筛选已保存歌单]");e.value="测试空";e.dispatchEvent(new Event("input",{bubbles:true}))');await sleep(150)
 check('management filter narrows cards',await evaluate('return document.querySelectorAll(".plcard").length===1'))
 await writeFile(control,JSON.stringify({path:allFile}));await confirmExport('备份全部歌单')
 await wait(async()=>{try{return JSON.parse(await readFile(allFile,'utf8')).playlists.length===4}catch{return false}},'all export')
 saved=JSON.parse(await readFile(allFile,'utf8'));check('all export ignores name filter and includes empty/system lists',saved.scope==='all'&&saved.playlists.length===4&&saved.playlists.find(p=>p.id==='empty').tracks.length===0)
 const blocked=join(owned,'blocked.json');await mkdir(blocked)
 await writeFile(control,JSON.stringify({path:blocked}));await confirmExport('备份全部歌单')
 await wait(()=>evaluate('return document.body.innerText.includes("EPERM")||document.body.innerText.includes("EISDIR")||document.body.innerText.includes("EACCES")'),'write error toast')
 await writeFile(control,JSON.stringify({path:join(owned,'retry.json')}));await confirmExport('备份全部歌单')
 await wait(async()=>{try{return JSON.parse(await readFile(join(owned,'retry.json'),'utf8')).playlists.length===4}catch{return false}},'retry after failed save')
 check('failed save releases busy state',true)
 await writeFile(control,JSON.stringify({path:join(profile,'settings.json')}));await confirmExport('备份全部歌单')
 await wait(()=>evaluate('return document.body.innerText.includes("应用资料目录以外")'),'data directory rejected')
 check('data directory protected',!(JSON.parse(await readFile(join(profile,'settings.json'),'utf8'))).kind)
 const shot=await send('Page.captureScreenshot',{format:'png'});report.screenshot=join(output,runId+'.png');await writeFile(report.screenshot,Buffer.from(shot.data,'base64'))
 await close()
 const session=JSON.parse(await readFile(join(profile,'settings.json'),'utf8')).lastSession
 check('filtered playback retained full queue and original index',session?.queue?.length===3&&session.index===1&&session.track.id==='local-1')
 report.rendererErrors=rendererErrors;check('no renderer errors',rendererErrors.length===0);report.status='passed'
}catch(error){report.status='failed';report.error=error.stack||String(error);process.exitCode=1}
finally{
 socket?.close();for(const p of pending.values()){clearTimeout(p.timer);p.no(Error('probe closed'))}
 if(child&&child.exitCode===null){child.kill();await sleep(300)}
 assert.ok(resolve(owned).startsWith(resolve(output)+sep)&&dirname(owned)===output)
 await rm(owned,{recursive:true,force:true,maxRetries:5,retryDelay:100});report.profileRemoved=true
 await writeFile(join(output,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report))
}