/** Isolated production UI/IPC acceptance; only the native picker is deterministic. */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { cp, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { openSync, closeSync } from 'node:fs'
import { createServer } from 'node:net'
import { dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..'), output = join(root, '.cache/local-file-relink-ui')
const runId = randomUUID(), owned = join(output, runId), profile = join(owned, 'profile'), appDir = join(owned, 'app')
const picker = join(owned, 'picker.json'), guard = join(owned, 'probe.cjs')
await mkdir(join(profile, 'library'), { recursive: true })
const oldPath = join(owned, 'missing.wav'), nextPath = join(owned, 'moved.wav')
const id = path => createHash('sha1').update(path.toLowerCase()).digest('hex').slice(0, 16)
const old = { id: id(oldPath), path: oldPath, name: 'Relink original', singer: 'Generated', duration: 1 }
const online = { id: old.id, source: 'wy', name: 'Online same ID', singer: '', meta: { songmid: 'fixture' } }
const report = { runId, status: 'running', scope: 'production DOM/preload/main/stores; native picker result injected; no actual sources/listening', checks: [], profileRemoved: false }
const check = (label, value) => { assert.ok(value, label); report.checks.push(label) }
const sleep = ms => new Promise(done => setTimeout(done, ms))
let child, socket, nextId = 0
const pending = new Map()
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
  socket.addEventListener('message', event => { const r = JSON.parse(event.data), p = pending.get(r.id); if (p) { clearTimeout(p.timer); pending.delete(r.id); r.error ? p.no(Error(r.error.message)) : p.yes(r.result) } })
  await new Promise((yes, no) => { socket.addEventListener('open', yes, { once: true }); socket.addEventListener('error', no, { once: true }) })
  await wait(() => evaluate('return !!window.jj && !!document.querySelector("h1")'), 'page ready')
}
async function close() {
  await evaluate('await window.jj.window.close()')
  await wait(() => Promise.resolve(child.exitCode !== null), 'normal exit')
  assert.equal(child.exitCode, 0)
  socket?.close(); socket = undefined; child = undefined
}
async function openMenu() {
  check('DOM local track menu', await evaluate('const row=[...document.querySelectorAll(".track-row")].find(r=>r.textContent.includes("Relink original"));if(!row)return false;row.dispatchEvent(new MouseEvent("contextmenu",{bubbles:true,clientX:300,clientY:210}));return true'))
  await evaluate('const b=[...document.querySelectorAll("[role=menuitem]")].find(b=>b.textContent.trim()==="文件");if(!b)throw Error("no file menu");b.click()')
  await evaluate('const b=[...document.querySelectorAll("[role=menuitem]")].find(b=>b.textContent.includes("重新定位文件"));if(!b)throw Error("no relink menu");b.click()')
}
try {
  await cp(join(root, 'out'), appDir, { recursive: true })
  const b = Buffer.alloc(16044); b.write('RIFF'); b.writeUInt32LE(16036, 4); b.write('WAVEfmt ', 8); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(8000, 24); b.writeUInt32LE(16000, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(16000, 40)
  await writeFile(nextPath, b)
  await writeFile(join(profile, 'library/index.json'), JSON.stringify({ version: 5, folders: [], tracks: [old] }))
  await writeFile(join(profile, 'playlists.json'), JSON.stringify({ version: 1, playlists: [{ id: 'favorites', name: '我喜欢的', source: 'local', position: 1 }, { id: 'custom', name: 'Relink list', source: 'local', position: 2 }], items: { favorites: [old, online], custom: [online, old] } }))
  await writeFile(join(profile, 'settings.json'), JSON.stringify({ libraryFolders: [], recentPlayed: [old, online], lastSession: { track: old, queue: [online, old], index: 1, position: 0.25, at: Date.now() }, queueHistory: [{ id: 'history', queue: [old, online], index: 0, mode: 'single', label: 'Historical', at: Date.now() }], onlineLyricSource: 'off', onlineLyricFallback: false, showSearchHotWords: false, minimizeToTray: false }))
  await writeFile(join(profile, 'downloads.json'), JSON.stringify([{ id: 'download-history', status: 'completed', path: oldPath, localTrackId: old.id, track: online, quality: '128k', warnings: [], received: 0, createdAt: Date.now(), libraryStatus: 'imported' }]))
  await writeFile(picker, JSON.stringify({ canceled: true, filePaths: [] }))
  await writeFile(guard, `const {app,BrowserWindow,dialog,session}=require('electron');const fs=require('node:fs');dialog.showOpenDialog=async()=>JSON.parse(fs.readFileSync(${JSON.stringify(picker)},'utf8'));BrowserWindow.prototype.show=function(){};app.on('browser-window-created',(_,w)=>w.webContents.setBackgroundThrottling(false));globalThis.fetch=()=>Promise.reject(Error('Offline probe'));app.whenReady().then(()=>session.defaultSession.webRequest.onBeforeRequest({urls:['http://*/*','https://*/*']},(_,cb)=>cb({cancel:true})));import(${JSON.stringify(pathToFileURL(join(appDir, 'main/index.js')).href)}).catch(e=>{console.error(e);app.exit(1)});`)
  await launch()
  check('owned data directory', resolve((await evaluate('return await window.jj.data.location()')).dir).toLowerCase() === profile.toLowerCase())
  check('no actual sources', (await evaluate('return await window.jj.sources.list()')).length === 0)
  await evaluate('location.hash="#/library"')
  await wait(() => evaluate('return [...document.querySelectorAll(".track-row")].some(r=>r.textContent.includes("Relink original"))'), 'local row')
  report.sessionBefore = await evaluate('return (await window.jj.settings.get()).lastSession')
  await openMenu(); await sleep(200)
  check('picker cancel preserves old record', (await evaluate('return await window.jj.library.tracks()'))[0].id === old.id)
  await writeFile(picker, JSON.stringify({ canceled: false, filePaths: [nextPath] }))
  await openMenu()
  await wait(() => evaluate('return document.body.innerText.includes("确认重新定位文件")'), 'confirmation')
  check('preview shows old and new paths', await evaluate(`return document.body.innerText.includes(${JSON.stringify(oldPath)}) && document.body.innerText.includes(${JSON.stringify(nextPath)})`))
  await evaluate('const b=[...document.querySelectorAll("[role=dialog] button")].find(b=>b.textContent.trim()==="取消");if(!b)throw Error("cancel unavailable");b.click()')
  check('confirmation cancel preserves references', (await evaluate('return await window.jj.playlists.items("favorites")'))[0].id === old.id)
  await openMenu()
  await wait(() => evaluate('return document.body.innerText.includes("确认重新定位文件")'), 'second confirmation')
  await evaluate('const b=[...document.querySelectorAll("[role=dialog] button")].find(b=>b.textContent.trim()==="确认");if(!b)throw Error("confirm unavailable");b.click()')
  await wait(async () => { try { return await evaluate(`return window.jj.library.tracks().then(rows=>rows.some(t=>t.id===${JSON.stringify(id(nextPath))}))`) } catch (error) { if (String(error).includes('正在修复')) return false; throw error } }, 'relinked index')
  await wait(() => evaluate('return document.body.innerText.includes("已重新定位文件")'), 'success feedback')
  const favorites = await evaluate('return await window.jj.playlists.items("favorites")'), custom = await evaluate('return await window.jj.playlists.items("custom")')
  check('favorite remains in original position', favorites[0].id === id(nextPath) && favorites[0].path === nextPath)
  check('online same ID untouched', favorites[1].id === old.id && favorites[1].source === 'wy')
  check('custom playlist order preserved', custom[0].source === 'wy' && custom[1].id === id(nextPath))
  const storedSettings = await evaluate('return await window.jj.settings.get()')
  report.sessionAfter = storedSettings.lastSession
  check('recent order and session queue migrated', storedSettings.recentPlayed[0].id === id(nextPath) && storedSettings.lastSession.queue[1].id === id(nextPath))
  check('resume position preserved', storedSettings.lastSession.position === 0.25)
  check('download history not redirected', (await evaluate('return await window.jj.downloads.list()'))[0].path === oldPath)
  check('generated audio unmodified', (await readFile(nextPath)).equals(b))
  check('old file never recreated', await readFile(oldPath).then(() => false, e => e.code === 'ENOENT'))
  await close()
  const afterClose = JSON.parse(await readFile(join(profile, 'settings.json'), 'utf8'))
  check('closing retains repaired session and progress', afterClose.lastSession.track.id === id(nextPath) && afterClose.lastSession.position === 0.25)
  // Simulate a crash after the library write but before all list writes completed.
  const listsPath = join(profile, 'playlists.json'), interrupted = JSON.parse(await readFile(listsPath, 'utf8'))
  interrupted.items.favorites[0] = old
  await writeFile(listsPath, JSON.stringify(interrupted))
  await writeFile(join(profile, 'local-relink.pending.json'), JSON.stringify({ version: 1, change: { old, next: afterClose.lastSession.track } }))
  await launch()
  check('restarted index uses new identity', (await evaluate('return await window.jj.library.tracks()'))[0].id === id(nextPath))
  check('restarted favorites retain new identity', (await evaluate('return await window.jj.playlists.items("favorites")'))[0].id === id(nextPath))
  check('startup repaired interrupted list transaction', await readFile(join(profile, 'local-relink.pending.json')).then(() => false, e => e.code === 'ENOENT'))
  check('no automatic playback', await evaluate('return navigator.mediaSession.playbackState!=="playing"'))
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
