/** Production playlist management acceptance in an owned Electron profile; only HTTP responses are synthetic. */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { cp, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { openSync, closeSync } from 'node:fs'
import { createServer } from 'node:net'
import { dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..'), output = join(root, '.cache/playlist-management-ui')
const runId = randomUUID(), owned = join(output, runId), profile = join(owned, 'profile'), appDir = join(owned, 'app')
const guard = join(owned, 'probe.cjs'), control = join(owned, 'control.json')
const report = { runId, status: 'running', scope: 'production DOM/preload/main/stores/files; generated WAV only; native picker fixture, actual atomic writes with controlled rename delay, synthetic search HTTP; no real sources/listening', checks: [], profileRemoved: false }
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
const folder=join(owned,'moved'),barrier=join(owned,'barrier.txt')
const id=path=>createHash('sha1').update(path.toLowerCase()).digest('hex').slice(0,16)
const olds=Array.from({length:6},(_,i)=>{const path=join(owned,'missing','song'+i+'.wav');return{id:id(path),path,name:'Old song '+i,singer:'Generated',duration:1}})
const nexts=olds.map((_,i)=>join(folder,'song'+i+'.wav'))
const mouseClick=async expression=>{
 const p=await evaluate(`const el=${expression};if(!el)throw Error('mouse target missing');el.scrollIntoView({block:'center'});const r=el.getBoundingClientRect(),x=r.x+r.width/2,y=r.y+r.height/2;return{x,y,hit:document.elementFromPoint(x,y)===el||el.contains(document.elementFromPoint(x,y))}`)
 check('stop control receives real pointer events',p.hit)
 await send('Input.dispatchMouseEvent',{type:'mousePressed',x:p.x,y:p.y,button:'left',clickCount:1});await send('Input.dispatchMouseEvent',{type:'mouseReleased',x:p.x,y:p.y,button:'left',clickCount:1})
}
async function enterBatch(indices){
 await evaluate('location.hash="#/playlist/favorites"');await wait(()=>evaluate('return document.querySelectorAll(".track-row").length>=6'),'favorite rows')
 await evaluate(`const rows=[...document.querySelectorAll('.track-row')];const targets=${JSON.stringify(indices.map(i=>'Old song '+i))};for(const name of targets){const row=rows.find(r=>r.textContent.includes(name));if(!row)throw Error('row missing');row.dispatchEvent(new MouseEvent('click',{bubbles:true,ctrlKey:true}))}rows.find(r=>r.textContent.includes(targets[0])).dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,clientX:400,clientY:300}))`)
 await evaluate('const b=[...document.querySelectorAll("[role=menuitem]")].find(b=>b.textContent.startsWith("文件"));if(!b)throw Error("file menu missing");b.click()')
 await evaluate('const b=[...document.querySelectorAll("[role=menuitem]")].find(b=>b.textContent.includes("批量重新定位文件"));if(!b)throw Error("batch menu missing");b.click()')
 await wait(()=>evaluate('return !!document.querySelector(".batch-relink")'),'batch route')
 await click('选择候选目录');await wait(()=>evaluate('return document.querySelectorAll(".batch-rows select").length===2'),'candidates')
 check('candidates require manual choice',await evaluate('return [...document.querySelectorAll(".batch-rows select")].every(s=>s.selectedIndex===0)'))
 await evaluate('for(const s of document.querySelectorAll(".batch-rows select")){s.selectedIndex=1;s.dispatchEvent(new Event("change",{bubbles:true}))}')
 await click('预览已选映射（2）');await wait(()=>evaluate('return document.querySelectorAll(".batch-previews article").length===2'),'metadata preview')
 if(!report.batchScreenshot){const shot=await send('Page.captureScreenshot',{format:'png'});report.batchScreenshot=join(output,runId+'-batch.png');await writeFile(report.batchScreenshot,Buffer.from(shot.data,'base64'))}
 check('metadata preview does not alter favorites',(await evaluate('return await window.jj.playlists.items("favorites")')).filter(t=>t.path?.includes('missing')).length>=2)
}
try{
 await mkdir(join(profile,'library'),{recursive:true});await mkdir(folder,{recursive:true});await cp(join(root,'out'),appDir,{recursive:true})
 const wav=Buffer.alloc(16044);wav.write('RIFF');wav.writeUInt32LE(16036,4);wav.write('WAVEfmt ',8);wav.writeUInt32LE(16,16);wav.writeUInt16LE(1,20);wav.writeUInt16LE(1,22);wav.writeUInt32LE(8000,24);wav.writeUInt32LE(16000,28);wav.writeUInt16LE(2,32);wav.writeUInt16LE(16,34);wav.write('data',36);wav.writeUInt32LE(16000,40)
 for(const path of nexts)await writeFile(path,wav)
 await writeFile(join(profile,'library/index.json'),JSON.stringify({version:5,folders:[],tracks:olds}))
 await writeFile(join(profile,'playlists.json'),JSON.stringify({version:1,playlists:[{id:'favorites',name:'我喜欢的',createdAt:1,updatedAt:1,trackCount:6},{id:'default',name:'默认列表',createdAt:1,updatedAt:1,trackCount:0},{id:'focus-a',name:'Ｆｏｃｕｓ 夜晚',createdAt:1,updatedAt:1,trackCount:0},{id:'focus-b',name:'Focus 夜晚',createdAt:1,updatedAt:1,trackCount:0}],items:{favorites:olds,default:[],'focus-a':[],'focus-b':[]}}))
 await writeFile(join(profile,'settings.json'),JSON.stringify({libraryFolders:[],onlineLyricSource:'off',onlineLyricFallback:false,showSearchHotWords:false,minimizeToTray:false,playlistOrder:['focus-b','focus-a']}))
 await writeFile(control,JSON.stringify({mode:'normal'}))
 await writeFile(guard,`const {app,BrowserWindow,dialog,session,ipcMain}=require('electron');const fs=require('node:fs');const fsp=require('node:fs/promises');const {syncBuiltinESMExports}=require('node:module');const rename=fsp.rename;fsp.rename=async(a,b)=>{if(String(b).endsWith('local-relink.pending.json')){fs.writeFileSync(${JSON.stringify(barrier)},'pending');await new Promise(r=>setTimeout(r,1000))}return rename(a,b)};syncBuiltinESMExports();const register=ipcMain.handle.bind(ipcMain);ipcMain.handle=(channel,fn)=>register(channel,async(...args)=>{const result=await fn(...args);if(channel==='library:tracks'&&JSON.parse(fs.readFileSync(${JSON.stringify(control)},'utf8')).mode==='refresh-failure'&&fs.existsSync(${JSON.stringify(barrier)})){fs.writeFileSync(${JSON.stringify(control)},JSON.stringify({mode:'normal'}));return {ok:false,error:'模拟界面刷新失败'}}return result});BrowserWindow.prototype.show=function(){};dialog.showOpenDialog=async()=>({canceled:false,filePaths:[${JSON.stringify(folder)}]});app.on('browser-window-created',(_,w)=>w.webContents.setBackgroundThrottling(false));
globalThis.fetch=async(raw,init)=>{init?.signal?.throwIfAborted();const u=new URL(raw),mode=JSON.parse(fs.readFileSync(${JSON.stringify(control)},'utf8')).mode;if(mode==='slow')await new Promise(r=>setTimeout(r,1200));if(u.hostname==='music.163.com'&&u.pathname==='/api/search/get/web'&&u.searchParams.get('type')==='1000'){if(mode==='failure')return new Response('{}',{status:503});return new Response(JSON.stringify({code:200,result:{playlistCount:100,playlists:Array.from({length:20},(_,i)=>({id:Number(u.searchParams.get('offset'))+i+1,name:'Generated list '+i,trackCount:1}))}}))}throw Error('Unexpected HTTP: '+u.href)};
app.whenReady().then(()=>session.defaultSession.webRequest.onBeforeRequest({urls:['http://*/*','https://*/*']},(_,cb)=>cb({cancel:true})));
import(${JSON.stringify(pathToFileURL(join(appDir,'main/index.js')).href)}).catch(e=>{console.error(e);app.exit(1)});`)
 await launch();await send('Runtime.enable');check('owned profile',resolve((await evaluate('return await window.jj.data.location()')).dir).toLowerCase()===profile.toLowerCase());check('no sources executed',(await evaluate('return await window.jj.sources.list()')).length===0)
 await enterBatch([0,1]);await click('确认并重新定位 2 首');await wait(()=>evaluate('return !!document.querySelector("[role=dialog]")'),'confirmation')
 await click('取消');check('confirmation cancellation keeps original identities',(await evaluate('return await window.jj.playlists.items("favorites")'))[0].id===olds[0].id)
 await click('预览已选映射（2）');await wait(()=>evaluate('return document.querySelectorAll(".batch-previews article").length===2'),'preview after cancel')
 await click('确认并重新定位 2 首');await wait(()=>evaluate('return !!document.querySelector("[role=dialog]")'),'confirm stop');await click('确认')
 await wait(()=>evaluate('return !!document.querySelector(".relink-busy")'),'maintenance')
 await mouseClick(`document.querySelector('[data-batch-stop]')||[...document.querySelectorAll('.batch-actions button')].find(b=>b.textContent.includes('停止后续处理'))`)
 await wait(()=>evaluate('return !document.querySelector(".relink-busy")&&document.body.innerText.includes("已完成 1 / 2")'),'stopped after current')
 let rows=await evaluate('return await window.jj.playlists.items("favorites")');check('stop preserves one completed and one untouched',rows[0].path===nexts[0]&&rows[1].id===olds[1].id)
 await enterBatch([2,3]);await click('确认并重新定位 2 首');await wait(()=>evaluate('return !!document.querySelector("[role=dialog]")'),'confirm full');await click('确认');await wait(()=>evaluate('return !document.querySelector(".relink-busy")&&document.body.innerText.includes("已完成 2 / 2")'),'two completed')
 rows=await evaluate('return await window.jj.playlists.items("favorites")');check('full batch keeps favorite positions and identities',rows[2].path===nexts[2]&&rows[3].path===nexts[3]);check('generated audio unchanged',(await readFile(nexts[2])).equals(wav))
 await enterBatch([4,5]);await writeFile(nexts[5],Buffer.concat([wav,Buffer.from('changed')]))
 await click('确认并重新定位 2 首');await wait(()=>evaluate('return !!document.querySelector("[role=dialog]")'),'confirm changed');await click('确认');await wait(()=>evaluate('return !document.querySelector(".relink-busy")&&document.body.innerText.includes("已停止后续处理")'),'failed second')
 rows=await evaluate('return await window.jj.playlists.items("favorites")');check('changed second candidate stops after durable first',rows[4].path===nexts[4]&&rows[5].id===olds[5].id)
 check('failed application identifies the exact old path',await evaluate(`return document.querySelector('[data-batch-result]').textContent.includes(${JSON.stringify(olds[5].path)})`))
 await enterBatch([1,5]);await writeFile(control,JSON.stringify({mode:'refresh-failure'}));await click('确认并重新定位 2 首');await wait(()=>evaluate('return !!document.querySelector("[role=dialog]")'),'confirm renderer refresh failure');await click('确认')
 await wait(()=>evaluate('return !document.querySelector(".relink-busy")&&document.body.innerText.includes("模拟界面刷新失败")'),'renderer refresh failed after commit')
 rows=await evaluate('return await window.jj.playlists.items("favorites")');check('committed first item survives renderer refresh failure',rows[1].path===nexts[1]&&rows[5].id===olds[5].id)
 check('committed association is distinguished from unfinished relocation',await evaluate('const text=document.querySelector("[data-batch-result]").textContent;return text.includes("关联已更新")&&text.includes("界面同步失败")&&!text.includes("未完成“")'))
 check('no automatic playback',await evaluate('return navigator.mediaSession.playbackState!=="playing"'))
 report.savedLists=await evaluate('return await window.jj.playlists.list()');
 await evaluate('location.hash="#/playlists"');await wait(()=>evaluate('return !!document.querySelector("[aria-label=筛选已保存歌单]")'),'saved lists')
 await evaluate('const el=document.querySelector("[aria-label=筛选已保存歌单]");el.value="focus 夜";el.dispatchEvent(new Event("input",{bubbles:true}))')
 await wait(()=>evaluate('return document.querySelectorAll(".plcard").length===2'),'filtered')
 check('saved filter preserves explicit order',await evaluate('return [...document.querySelectorAll(".plcard__name")].map(x=>x.textContent).join("|")==="Focus 夜晚|Ｆｏｃｕｓ 夜晚"'))
 await evaluate('document.querySelector(".plcard__body").click()');await wait(()=>evaluate('return location.hash.includes("playlist/focus-b")&&!document.querySelector(".playlist-filter")&&!document.querySelector(".fade-leave-active")'),'saved detail');report.savedLists=await evaluate('return await window.jj.playlists.list()');
 await evaluate('location.hash="#/playlists"');await wait(()=>evaluate('return document.querySelectorAll(".plcard").length===2&&!document.querySelector(".fade-enter-active,.fade-leave-active")'),'filter retained')
 check('saved filter survives route return',await evaluate('return document.querySelector("[aria-label=筛选已保存歌单]").value==="focus 夜"'))
 await click('清空筛选');await sleep(100);report.afterClear=await evaluate('return {count:document.querySelectorAll(".plcard").length,input:document.querySelector("[aria-label=筛选已保存歌单]").value,text:document.body.innerText.slice(-1500)}');check('clear saved filter restores original identities',report.afterClear.count===report.savedLists.length&&report.afterClear.input==='')
 await evaluate('location.hash="#/search?kind=playlists&q=Generated&p=wy"');await wait(()=>evaluate('return document.querySelectorAll(".playlist-card").length===20'),'online search');await click('加载更多歌单');await wait(()=>evaluate('return document.querySelectorAll(".playlist-card").length===40'),'second page')
 await writeFile(control,JSON.stringify({mode:'failure'}));await click('刷新结果');await wait(()=>evaluate('return document.body.innerText.includes("重试未完成页")'),'stale fallback')
 check('failed refresh retains all loaded pages',await evaluate('return document.querySelectorAll(".playlist-card").length===40'))
 await writeFile(control,JSON.stringify({mode:'normal'}));await click('重试未完成页');await wait(()=>evaluate('return document.querySelectorAll(".playlist-card").length===20'),'retry refresh')
 await evaluate('const el=document.querySelector("[aria-label=歌单关键词]");el.value="Changed";el.dispatchEvent(new Event("input",{bubbles:true}))');await wait(()=>evaluate('return document.body.innerText.includes("关键词已修改")'),'draft hint')
 check('draft never relabels old results',await evaluate('return document.body.innerText.includes("当前显示“Generated”的结果")'))
 await writeFile(control,JSON.stringify({mode:'slow'}));await click('搜索歌单');await wait(()=>evaluate('return document.body.innerText.includes("取消搜索")'),'slow search');await click('清空搜索');await sleep(1600)
 check('clear cannot be undone by late response',await evaluate('return document.querySelectorAll(".playlist-card").length===0&&document.querySelector("[aria-label=歌单关键词]").value===""'))
 const shot=await send('Page.captureScreenshot',{format:'png'});report.screenshot=join(output,runId+'.png');await writeFile(report.screenshot,Buffer.from(shot.data,'base64'));report.rendererErrors=rendererErrors;check('no renderer errors',rendererErrors.length===0)
 await close();report.status='passed'
} catch (error) { report.status = 'failed'; report.error = error.stack || String(error); process.exitCode = 1 }
finally {
  socket?.close()
  for (const p of pending.values()) { clearTimeout(p.timer); p.no(Error('probe closed')) }
  if (child && child.exitCode === null) { child.kill(); await sleep(300) }
  assert.ok(resolve(owned).startsWith(resolve(output) + sep) && dirname(owned) === output)
  await rm(owned, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); report.profileRemoved = true
  await writeFile(join(output, 'report.json'), JSON.stringify(report, null, 2))
  console.log(JSON.stringify(report))
}