/** Production playlist search acceptance in an owned Electron profile; only HTTP responses are synthetic. */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { cp, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { openSync, closeSync } from 'node:fs'
import { createServer } from 'node:net'
import { dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..'), output = join(root, '.cache/playlist-search-ui')
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
const count=n=>evaluate(`return document.querySelectorAll('.playlist-card').length===${n}`)
const setQuery=q=>evaluate(`const el=document.querySelector('[aria-label="歌单关键词"]');el.value=${JSON.stringify(q)};el.dispatchEvent(new Event('input',{bubbles:true}));document.querySelector('.playlist-search__form').dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}))`)
const lists=()=>evaluate('return await window.jj.playlists.list()')
try{
 await cp(join(root,'out'),appDir,{recursive:true})
 await writeFile(join(profile,'settings.json'),JSON.stringify({libraryFolders:[],onlineLyricSource:'off',onlineLyricFallback:false,showSearchHotWords:false,minimizeToTray:false}))
 await writeFile(control,JSON.stringify({mode:'normal'}))
 await writeFile(guard,`const {app,BrowserWindow,session}=require('electron');const fs=require('node:fs');
BrowserWindow.prototype.show=function(){};app.on('browser-window-created',(_,w)=>w.webContents.setBackgroundThrottling(false));
const wy=i=>({id:i,name:'Generated song '+i,ar:[{id:1,name:'Generated artist'}],al:{id:1,name:'Generated album'},dt:180000});
globalThis.fetch=async(raw,init)=>{init?.signal?.throwIfAborted();const u=new URL(raw),mode=JSON.parse(fs.readFileSync(${JSON.stringify(control)},'utf8')).mode;let value;if(mode==='slow')await new Promise(r=>setTimeout(r,1200));fs.appendFileSync(${JSON.stringify(join(owned,'http.log'))},u.pathname+'\\n');
if(u.hostname==='music.163.com'&&u.pathname==='/api/search/get/web'&&u.searchParams.get('type')==='1')value={code:200,result:{songCount:3,songs:[wy(1),wy(2),wy(3)]}};
else if(u.hostname==='music.163.com'&&u.pathname==='/api/search/get/web'){if(mode==='failure'&&Number(u.searchParams.get('offset'))===40||mode==='refresh-failure'&&Number(u.searchParams.get('offset'))===0)return new Response('{}',{status:503});value={code:200,result:{playlistCount:300,playlists:Array.from({length:20},(_,i)=>({id:Number(u.searchParams.get('offset'))+i+1,name:'Generated WY list '+(Number(u.searchParams.get('offset'))+i+1),trackCount:3,creator:{nickname:'Generated curator'}}))}};}
else if(u.hostname==='msearch.kugou.com'){value={status:1,data:{total:20,info:Array.from({length:20},(_,i)=>({specialid:i+1,specialname:'Generated KG list '+(i+1),songcount:3}))}};}
else if(u.hostname==='search.kuwo.cn'){value={TOTAL:'20',abslist:Array.from({length:20},(_,i)=>({playlistid:String(i+1),name:'Generated KW list '+(i+1),songnum:'3'}))};}
else if(u.hostname==='app.u.nf.migu.cn'){value={code:'000000',songListResultData:{totalCount:'20',result:Array.from({length:20},(_,i)=>({id:String(i+1),name:'Generated MG list '+(i+1),musicNum:'3'}))}};}
else if(u.hostname==='music.163.com'&&u.pathname==='/api/v6/playlist/detail')value={code:200,playlist:{name:'Generated preview',trackCount:3,tracks:[wy(1),wy(2),wy(3)],trackIds:[{id:1},{id:2},{id:3}]}};
else throw Error('Unexpected HTTP in isolated playlist search probe: '+u.origin+u.pathname);
return new Response(JSON.stringify(value),{headers:{'content-type':'application/json'}})};
app.whenReady().then(()=>session.defaultSession.webRequest.onBeforeRequest({urls:['http://*/*','https://*/*']},(_,cb)=>cb({cancel:true})));
import(${JSON.stringify(pathToFileURL(join(appDir,'main/index.js')).href)}).catch(e=>{console.error(e);app.exit(1)});`)
 await launch();await send('Runtime.enable')
 check('owned profile',resolve((await evaluate('return await window.jj.data.location()')).dir).toLowerCase()===profile.toLowerCase())
 check('no sources executed',(await evaluate('return await window.jj.sources.list()')).length===0)
 const initial=(await lists()).length
 await evaluate('location.hash="#/search?kind=playlists"')
 await wait(()=>evaluate('return !!document.querySelector(".playlist-search")'),'playlist search')
 check('five individual platforms',await evaluate('return document.querySelectorAll(".playlist-search__tabs button").length===5'))
 await setQuery('Generated');await wait(()=>count(20),'first search')
 check('20 summaries from real adapter',await evaluate('return document.querySelector(".playlist-card strong").textContent==="Generated WY list 1"'))
 await click('加载更多歌单');await wait(()=>count(40),'more')
 check('explicit more appends results',await count(40))
 await writeFile(control,JSON.stringify({mode:'failure'}));await click('加载更多歌单')
 await wait(()=>evaluate('return document.body.innerText.includes("重试未完成页")'),'failed page')
 check('failure retains old results',await count(40))
 await writeFile(control,JSON.stringify({mode:'normal'}));await click('重试未完成页');await wait(()=>count(60),'retry')
 check('retry appends failed page',await count(60))
 for(const [name,prefix]of [['酷狗音乐','KG'],['酷我音乐','KW'],['咪咕音乐','MG']]){
  await click(name);await setQuery('Generated');await wait(()=>count(20),name)
  check(name+' summaries keep platform identity',await evaluate(`return document.querySelector('.playlist-card strong').textContent==='Generated ${prefix} list 1'`))
 }
 await click('QQ 音乐');await wait(()=>evaluate('return document.body.innerText.includes("QQ 歌单搜索暂未接通")'),'QQ pending')
 check('QQ pending differs from zero matches',await evaluate('return !document.body.innerText.includes("未找到公开歌单")'))
 await click('网易云音乐');await wait(()=>count(60),'restored')
 await click('酷狗音乐');await wait(()=>count(20),'KG before clearing')
 await click('清空搜索');await wait(()=>count(0),'KG cleared')
 await click('网易云音乐');await wait(()=>count(60),'WY after KG clear')
 await click('酷狗音乐');await wait(()=>count(0),'KG still cleared')
 check('cleared platform does not inherit another platform draft on return',await evaluate('return document.querySelector("[aria-label=歌单关键词]").value===""'))
 await click('网易云音乐');await wait(()=>count(60),'WY still independent')
 await evaluate('const el=document.querySelector(".playlist-search__results");el.scrollTop=300;el.dispatchEvent(new Event("scroll"))')
 await writeFile(control,JSON.stringify({mode:'refresh-failure'}));await click('刷新结果');await wait(()=>evaluate('return document.body.innerText.includes("重试未完成页")'),'failed refresh')
 check('failed refresh keeps loaded results and scroll offset',await count(60)&&await evaluate('return document.querySelector(".playlist-search__results").scrollTop>=290'))
 await writeFile(control,JSON.stringify({mode:'normal'}));await click('重试未完成页');await wait(()=>count(20),'refresh retry')
 check('successful first-page retry resets actual DOM scroll',await evaluate('return document.querySelector(".playlist-search__results").scrollTop===0'))
 await click('加载更多歌单');await wait(()=>count(40),'restore second page');await click('加载更多歌单');await wait(()=>count(60),'restore third page')
 await evaluate('const el=document.querySelector(".playlist-search__results");el.scrollTop=150;el.dispatchEvent(new Event("scroll"));document.querySelector(".playlist-card").click()')
 await wait(()=>evaluate('return document.querySelectorAll(".online-playlist .track-row").length===3'),'preview')
 check('readonly detail uses standard tracks',(await lists()).length===initial)
 await click('播放已读取的 3 首');await wait(()=>evaluate('return document.body.innerText.includes("播放请先在设置中启用音源")'),'play guidance')
 check('no automatic playback',await evaluate('return navigator.mediaSession.playbackState!=="playing"'))
 await click('导入为本地歌单');await wait(()=>evaluate('return !!document.querySelector("[role=dialog]")'),'confirm')
 check('confirmation names the preview and count',await evaluate('return document.querySelector("[role=dialog]").textContent.includes("Generated preview")&&document.querySelector("[role=dialog]").textContent.includes("3 首")'))
 await click('取消');check('cancel does not save',(await lists()).length===initial)
 await click('返回歌单搜索');await wait(()=>count(60),'back')
 check('back restores summaries and scroll',await evaluate('return document.querySelector(".playlist-search__results").scrollTop>=140'))
 await evaluate('document.querySelector(".playlist-card").click()');await wait(()=>evaluate('return document.querySelectorAll(".online-playlist .track-row").length===3'),'preview again')
 await click('导入为本地歌单');await wait(()=>evaluate('return !!document.querySelector("[role=dialog]")'),'confirm again')
 await evaluate('const form=document.querySelector("[role=dialog]");form.dispatchEvent(new Event("submit",{bubbles:true,cancelable:true}));form.dispatchEvent(new Event("submit",{bubbles:true,cancelable:true}))')
 await wait(async()=>(await lists()).length===initial+1,'saved')
 await wait(()=>evaluate('return location.hash.startsWith("#/playlist/")'),'saved route')
 const saved=(await lists()).find(p=>p.name==='Generated preview')
 check('confirmed save creates exactly one playlist',(await lists()).length===initial+1&&!!saved)
 check('saved track order stays native',(await evaluate(`return await window.jj.playlists.items(${JSON.stringify(saved.id)})`)).map(t=>t.id).join(',')==='wy_1,wy_2,wy_3')
 const held=await evaluate('return await window.jj.playlistImport.preview("wy","1")')
 await evaluate(`await window.jj.playlistImport.discard(${JSON.stringify(held.token)});`)
 check('discarded token cannot save',await evaluate(`try{await window.jj.playlistImport.save(${JSON.stringify(held.token)},['wy_1']);return false}catch{return true}`))
 const once=await evaluate('return await window.jj.playlistImport.preview("wy","1")')
 check('token consumption prevents concurrent duplicate saves',await evaluate(`const r=await Promise.allSettled([window.jj.playlistImport.save(${JSON.stringify(once.token)},['wy_1']),window.jj.playlistImport.save(${JSON.stringify(once.token)},['wy_1'])]);return r.filter(x=>x.status==='fulfilled').length===1`))
 await evaluate('location.hash="#/search?kind=playlists"');await wait(()=>count(60),'final search')
 await click('歌曲');await wait(()=>evaluate('return document.querySelector(".song-search").style.display!=="none"'),'songs')
 check('songs keep independent empty keyword',await evaluate('return document.querySelector(".searchbar input").value===""'))
 await click('歌单');await wait(()=>count(60),'playlist restored')
 const http=await readFile(join(owned,'http.log'),'utf8')
 check('playlist browsing never issues song search',!http.split('\n').some(p=>['/api/search/get','/api/cloudsearch/pc','/api/search/pc'].includes(p)))
  await click('歌曲');await wait(()=>evaluate('return document.querySelector(".song-search").style.display!=="none"'),'songs setup')
 await evaluate('const b=[...document.querySelectorAll(".platform")].find(b=>b.textContent.includes("网易"));if(!b)throw Error("WY song platform missing");b.click()')
 await click('歌单');await wait(()=>count(60),'before external song search')
 await evaluate('location.hash="#/search?q=DifferentSong"')
 await wait(()=>evaluate('return document.querySelectorAll(".song-search .track-row").length===3'),'song search from playlist category')
 check('new song search survives category change',await evaluate('return document.querySelector(".searchbar input").value==="DifferentSong"'))
 await click('歌单');await wait(()=>count(60),'final retained playlists')
   const owners=[]
 for(let i=0;i<9;i++)owners.push(await evaluate('return await window.jj.playlistImport.preview("wy","1")'))
 await evaluate('location.hash="#/online-playlist/wy/1"');await wait(()=>evaluate('return document.querySelectorAll(".online-playlist .track-row").length===3'),'cleanup detail')
 await click('返回歌单搜索');await wait(()=>evaluate('return !!document.querySelector(".playlist-search")'),'cleanup back')
 const extra=await evaluate('return await window.jj.playlistImport.preview("wy","1")')
 check('leaving detail releases only its own preview token',await evaluate(`try{await window.jj.playlistImport.save(${JSON.stringify(owners[0].token)},['wy_1']);return true}catch{return false}`))
 for(const p of [...owners,...[extra]])await evaluate(`await window.jj.playlistImport.discard(${JSON.stringify(p.token)})`)
 await writeFile(control,JSON.stringify({mode:'slow'}))
 await setQuery('SlowQuery')
 await evaluate('location.hash="#/downloads"')
 await wait(()=>evaluate('return location.hash==="#/downloads"'),'left search')
 await sleep(1800)
 check('late search cannot navigate back after leaving',await evaluate('return location.hash==="#/downloads"'))
 await writeFile(control,JSON.stringify({mode:'normal'}))
 await evaluate('location.hash="#/search?kind=playlists&q=Generated&p=wy"');await wait(()=>count(20),'final preview')
 const shot=await send('Page.captureScreenshot',{format:'png'});report.screenshot=join(output,runId+'.png');await writeFile(report.screenshot,Buffer.from(shot.data,'base64'))
 check('no framework overlay',await evaluate('return !document.querySelector("vite-error-overlay")'))
 report.rendererErrors=rendererErrors;check('no renderer exceptions or console errors',rendererErrors.length===0)
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