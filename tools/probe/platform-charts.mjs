/** Production charts acceptance in an owned Electron profile; only HTTP responses are synthetic. */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { cp, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { openSync, closeSync } from 'node:fs'
import { createServer } from 'node:net'
import { dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..'), output = join(root, '.cache/platform-charts-ui')
const runId = randomUUID(), owned = join(output, runId), profile = join(owned, 'profile'), appDir = join(owned, 'app')
const guard = join(owned, 'probe.cjs'), control = join(owned, 'control.json')
const report = { runId, status: 'running', scope: 'production DOM/preload/main/adapter/cache; synthetic HTTP only; no real sources or listening', checks: [], profileRemoved: false }
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
const count = n => evaluate(`return document.querySelector('.charts__actions')?.innerText.includes('已加载 ${n} 首')`)
try {
  await cp(join(root, 'out'), appDir, { recursive: true })
  await writeFile(join(profile, 'settings.json'), JSON.stringify({ libraryFolders: [], onlineLyricSource: 'off', onlineLyricFallback: false, showSearchHotWords: false, minimizeToTray: false }))
  await writeFile(control, JSON.stringify({ mode: 'normal' }))
  await writeFile(guard, `const {app,BrowserWindow,session}=require('electron');const fs=require('node:fs');
BrowserWindow.prototype.show=function(){};app.on('browser-window-created',(_,w)=>w.webContents.setBackgroundThrottling(false));
const wy=i=>({id:i,name:'WY song '+i,ar:[{id:1,name:'Generated artist'}],al:{id:1,name:'Generated album'},dt:180000});
const tx=i=>({id:i,mid:'mid'+i,title:'QQ song '+i,singer:[{id:1,name:'Generated artist'}],album:{id:1,name:'Generated album'},interval:180});
globalThis.fetch=async(raw,init)=>{init?.signal?.throwIfAborted();const u=new URL(raw),mode=JSON.parse(fs.readFileSync(${JSON.stringify(control)},'utf8')).mode;let value;
if(['p1.music.126.net','y.gtimg.cn'].includes(u.hostname))return new Response(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aGN8AAAAASUVORK5CYII=','base64'),{headers:{'content-type':'image/png'}});
if(u.hostname==='music.163.com'&&u.pathname==='/api/toplist/detail')value={code:200,list:[{id:1,name:'Generated WY chart',coverImgUrl:'https://p1.music.126.net/generated.png',trackCount:60,updateTime:1000},{id:2,name:'Second WY chart',trackCount:60,updateTime:1000}]};
else if(u.hostname==='music.163.com'&&u.pathname==='/api/v6/playlist/detail')value={code:200,playlist:{id:Number(u.searchParams.get('id')),trackCount:60,updateTime:1000,tracks:Array.from({length:20},(_,i)=>wy(i+1)),trackIds:Array.from({length:60},(_,i)=>({id:i+1}))}};
else if(u.hostname==='music.163.com'&&u.pathname==='/api/song/detail')value={code:200,songs:JSON.parse(u.searchParams.get('ids')).map(Number).reverse().map(wy)};
else if(u.hostname==='c.y.qq.com'&&u.pathname==='/v8/fcg-bin/fcg_myqq_toplist.fcg')value={code:0,data:{topList:[{id:1,topTitle:'Generated QQ chart',picUrl:'https://y.gtimg.cn/generated.png'},{id:2,topTitle:'Second QQ chart'}]}};
else if(u.hostname==='m.kugou.com'&&u.pathname==='/rank/list')value={rank:{list:[{rankid:1,rankname:'Generated KG chart'}]}};
else if(u.hostname==='m.kugou.com'&&u.pathname.startsWith('/rank/info/')){const n=Number(u.searchParams.get('page'));value={info:{rankid:1,rank_id_publish_date:'2026-10-23',issue:1},songs:{page:n,pagesize:30,total:60,list:Array.from({length:30},(_,i)=>({hash:((n-1)*30+i+1).toString(16).padStart(32,'0'),songname:'KG song '+((n-1)*30+i+1),filename:'Generated artist - KG song '+((n-1)*30+i+1),audio_id:(n-1)*30+i+1,duration:180}))}};}
else if(u.hostname==='wapi.kuwo.cn'&&u.pathname==='/api/pc/bang/list')value={child:[{source:'2',sourceid:'16',name:'Generated KW chart',child:[]}]};
else if(u.hostname==='kbangserver.kuwo.cn'&&u.pathname==='/ksong.s'){const n=Number(u.searchParams.get('pn'));value={pub:mode==='unversioned'?'':'2026-10-23',timestamp:mode==='unversioned'?'':'1000',num:'60',musiclist:Array.from({length:20},(_,i)=>({id:String(n*20+i+1),name:'KW song '+(n*20+i+1),artist:'Generated artist',song_duration:'180'}))};}
else if(u.hostname==='app.u.nf.migu.cn'&&u.pathname==='/pc/bmw/rank/rank-index/v1.0')value={code:'000000',data:{contents:[{view:'ZJ-RANK-NORMAL',contents:[{rankId:'27553319',rankName:'Generated MG chart'}]}]}};
else if(u.hostname==='app.u.nf.migu.cn'&&u.pathname==='/pc/bmw/rank/rank-info/v1.0'){let rows=Array.from({length:60},(_,i)=>{const copyrightId=i===0?'6005754QZEE':String(60000000000+i);return {songId:String(1000+i),copyrightId,songData:JSON.stringify({songId:String(1000+i),copyrightId,songName:'MG song '+i,singerList:[{name:'Generated artist'}],duration:180})}});if(mode==='mg-reordered')rows.reverse();value={code:'000000',data:{columnId:'27553319',hasNextPage:false,totalCount:60,contents:rows,updateTime:'2026-10-24'}};}
else if(u.hostname==='u.y.qq.com'&&u.pathname==='/cgi-bin/musicu.fcg'){const p=JSON.parse(u.searchParams.get('data')).detail.param;if(mode==='failure'&&p.offset===20)return new Response(JSON.stringify({code:1}),{status:200,headers:{'content-type':'application/json'}});value={code:0,detail:{code:0,data:{data:{topId:p.topId,totalNum:60,period:mode==='period'?'v2':'v1'},songInfoList:Array.from({length:mode==='partial'&&p.offset===0?1:20},(_,i)=>tx(p.offset+i+1))}}};}
else throw Error('Unexpected HTTP in isolated charts probe: '+u.origin+u.pathname);
return new Response(JSON.stringify(value),{status:200,headers:{'content-type':'application/json'}})};
app.whenReady().then(()=>session.defaultSession.webRequest.onBeforeRequest({urls:['http://*/*','https://*/*']},(_,cb)=>cb({cancel:true})));
import(${JSON.stringify(pathToFileURL(join(appDir, 'main/index.js')).href)}).catch(e=>{console.error(e);app.exit(1)});`)
  await launch(); await send('Runtime.enable')
  check('owned profile', resolve((await evaluate('return await window.jj.data.location()')).dir).toLowerCase() === profile.toLowerCase())
  check('no sources executed', (await evaluate('return await window.jj.sources.list()')).length === 0)
  await evaluate('location.hash="#/charts"')
  await wait(() => evaluate('return document.querySelectorAll(".charts__board").length===2'), 'WY list')
  await click('Generated WY chart'); await wait(() => count(20), 'WY first page')
  await wait(() => evaluate('return !!document.querySelector(".charts__summary img" )?.complete'), 'WY artwork')
  check('standard platform tracks rendered', await evaluate('return !![...document.querySelectorAll(".charts .track-row")].find(r=>r.textContent.includes("WY song 1"))'))
  await click('加载更多曲目'); await wait(() => count(40), 'WY second page')
  check('manual load more shows 40', await count(40))
  await click('播放已加载的 40 首')
  await wait(() => evaluate('return document.body.innerText.includes("播放请先在设置中启用音源")'), 'no-source guidance')
  check('no automatic playback without a source', await evaluate('return navigator.mediaSession.playbackState!=="playing"'))
  await click('QQ 音乐'); await wait(() => evaluate('return [...document.querySelectorAll(".charts__board")].some(b=>b.textContent.includes("Generated QQ chart"))'), 'QQ list')
  await click('Generated QQ chart'); await wait(() => count(20), 'QQ first page')
  await evaluate('document.querySelector(".charts .track-row").dispatchEvent(new MouseEvent("contextmenu",{bubbles:true,clientX:600,clientY:350}))')
  await evaluate('const b=[...document.querySelectorAll("[role=menuitem]")].find(b=>b.textContent.trim()==="喜爱");if(!b)throw Error("favorite unavailable");b.click()')
  await wait(async () => (await evaluate('return await window.jj.playlists.items("favorites")')).some(t=>t.id==='tx_mid1'&&t.source==='tx'), 'favorite saved')
  check('standard favorite retains platform song identity', (await evaluate('return await window.jj.playlists.items("favorites")')).some(t=>t.id==='tx_mid1'&&t.source==='tx'))
  check('same chart ID is isolated by platform', await evaluate('return document.querySelector(".charts__summary h2").textContent==="Generated QQ chart" && document.querySelector(".charts .track-row").textContent.includes("QQ song")'))
  await click('网易云音乐'); await wait(() => count(40), 'WY restored')
  check('switching preserves loaded pages', await count(40))
  await click('QQ 音乐'); await wait(() => count(20), 'QQ restored')
  await writeFile(control, JSON.stringify({ mode: 'failure' }))
  await click('加载更多曲目')
  await wait(() => evaluate('return [...document.querySelectorAll(".charts button")].some(b=>b.textContent.trim()==="重试未完成页"&&!b.disabled)'), 'failed page retry')
  check('failed page preserves existing 20', await count(20))
  await writeFile(control, JSON.stringify({ mode: 'normal' }))
  await click('重试未完成页'); await wait(() => count(40), 'retry append')
  check('retry appends the failed page', await count(40))
  await writeFile(control, JSON.stringify({ mode: 'period' }))
  await click('加载更多曲目')
  await wait(() => evaluate('return document.body.innerText.includes("榜单周期已变化")'), 'period change')
  check('period change keeps old rows until explicit refresh', await count(40))
  await click('刷新重新加载'); await wait(() => count(20), 'refresh new period')
  check('new period replaces the old snapshot', await evaluate('return document.querySelector(".charts__summary").innerText.includes("v2")'))
  await writeFile(control, JSON.stringify({ mode: 'partial' }))
  await click('刷新榜单'); await wait(() => count(1), 'partial first page')
  await click('加载更多曲目'); await wait(() => count(21), 'partial followed by complete page')
  check('earlier partial page keeps a visible retry', await evaluate('return [...document.querySelectorAll(".charts button")].some(b=>b.textContent.trim()==="重试未完成页")'))
  await writeFile(control, JSON.stringify({ mode: 'normal' }))
  await click('重试未完成页'); await wait(() => count(40), 'partial page repaired')
  check('retry first partial page preserves second page', await count(40))
  await wait(() => evaluate('const img=document.querySelector(".charts__summary img");return !!img && img.complete && img.naturalWidth>0'), 'QQ artwork')
  check('QQ chart artwork uses the guarded main IPC', await evaluate('return document.querySelector(".charts__summary img").src.startsWith("data:image/png;base64,")'))
  await click('酷狗音乐'); await wait(() => evaluate('return document.querySelector(".charts__boards").innerText.includes("Generated KG chart")'), 'KG list')
  await click('Generated KG chart'); await wait(() => count(20), 'KG first page')
  await click('加载更多曲目'); await wait(() => count(40), 'KG second page across native boundary')
  check('KG 30-row upstream pages produce 40 loaded tracks', await count(40))
  await evaluate('document.querySelector(".charts .track-row").dispatchEvent(new MouseEvent("contextmenu",{bubbles:true,clientX:600,clientY:350}))')
  await evaluate('const b=[...document.querySelectorAll("[role=menuitem]")].find(b=>b.textContent.trim()==="喜爱");if(!b)throw Error("KG favorite unavailable");b.click()')
  await wait(async () => (await evaluate('return await window.jj.playlists.items("favorites")')).some(t=>t.source==='kg'&&t.id==='kg_00000000000000000000000000000001'&&t.meta.hash==='00000000000000000000000000000001'), 'KG favorite hash')
  check('KG favorite preserves hash identity', true)
  await click('酷我音乐'); await wait(() => evaluate('return document.querySelector(".charts__boards").innerText.includes("Generated KW chart")'), 'KW list')
  await click('Generated KW chart'); await wait(() => count(20), 'KW first page')
  await click('加载更多曲目'); await wait(() => count(40), 'KW second page')
  check('KW native pages load manually', await count(40))
  await writeFile(control, JSON.stringify({ mode: 'unversioned' }))
  await click('刷新榜单'); await wait(() => count(20), 'KW unversioned refresh')
  check('missing version explains and stops further pagination', await evaluate('return document.body.innerText.includes("平台未提供稳定榜单版本") && !document.querySelector(".charts__more")'))
  await click('咪咕音乐'); await wait(() => evaluate('return document.querySelector(".charts__boards").innerText.includes("Generated MG chart")'), 'MG list')
  await click('Generated MG chart'); await wait(() => count(20), 'MG first page')
  await click('加载更多曲目'); await wait(() => count(40), 'MG second page')
  check('MG ordered snapshot pages load 20 then 40', await count(40))
  await evaluate('document.querySelector(".charts .track-row").dispatchEvent(new MouseEvent("contextmenu",{bubbles:true,clientX:600,clientY:350}))')
  await evaluate('const b=[...document.querySelectorAll("[role=menuitem]")].find(b=>b.textContent.trim()==="喜爱");if(!b)throw Error("MG favorite unavailable");b.click()')
  await wait(async () => (await evaluate('return await window.jj.playlists.items("favorites")')).some(t=>t.id==='mg_1000'&&t.meta.copyrightId==='6005754QZEE'), 'MG native favorite')
  check('MG favorite preserves songId and alphanumeric copyrightId', true)
  await writeFile(control, JSON.stringify({ mode: 'mg-reordered' }))
  await click('加载更多曲目'); await wait(() => evaluate('return document.body.innerText.includes("榜单周期已变化")'), 'MG snapshot change')
  check('MG same-date reordered snapshot preserves old rows until refresh', await count(40))
  await click('刷新重新加载'); await wait(() => count(20), 'MG refresh snapshot')
  check('MG explicit refresh replaces the old order', await evaluate('return document.querySelector(".charts .track-row").textContent.includes("MG song 59")'))
  const miguShot=await send('Page.captureScreenshot',{format:'png'})
  report.miguScreenshot=join(output,`${runId}-migu.png`)
  await writeFile(report.miguScreenshot,Buffer.from(miguShot.data,'base64'))
  await click('酷狗音乐'); await wait(() => count(40), 'KG restored')
  check('five platforms keep independent state', await count(40))
  check('five platform tabs render', await evaluate('return document.querySelectorAll(".charts [role=tab]").length===5'))
  const shot = await send('Page.captureScreenshot', { format: 'png' })
  report.screenshot = join(output, `${runId}.png`)
  await writeFile(report.screenshot, Buffer.from(shot.data, 'base64'))
  check('no framework overlay', await evaluate('return !document.querySelector("vite-error-overlay")'))
  check('no renderer exceptions or console errors', rendererErrors.length === 0)
  await close(); report.status = 'passed'
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