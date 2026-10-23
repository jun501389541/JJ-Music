/** Owned MP3 + production preload/IPC/renderer, with only a scan completion gate. */
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { cp, mkdir, readFile, writeFile, stat, rm } from 'node:fs/promises'
import { openSync, closeSync, existsSync } from 'node:fs'
import { createServer } from 'node:net'
import { dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import NodeID3 from 'node-id3'
import { parseFile } from 'music-metadata'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const output = join(root, '.cache/scan-tag-consistency'), runId = randomUUID(), owned = join(output, runId)
await mkdir(owned, { recursive: true })
const profile = join(owned, 'profile'), appDir = join(owned, 'app'), music = join(profile, 'music'), audio = join(music, 'fixture.mp3')
const arm = join(owned, 'arm'), captured = join(owned, 'captured.json'), release = join(owned, 'release'), blocked = join(owned, 'blocked')
const report = { runId, status: 'running', checks: [], errors: [], scope: 'DOM rescan + real match.apply IPC; no candidate dialog or listening', profileRemoved: false }
const sleep = ms => new Promise(done => setTimeout(done, ms))
const check = (label, value) => { assert.ok(value, label); report.checks.push(label) }
let child, socket, childError, nextId = 0
const pending = new Map()
const run = (command, args, label) => {
  const result = spawnSync(command, args, { cwd: root, windowsHide: true, timeout: 120_000, maxBuffer: 8 * 1024 * 1024 })
  assert.ifError(result.error); assert.equal(result.status, 0, `${label}: ${result.stderr}`)
  return result.stdout
}
const wait = async (condition, label) => {
  const end = performance.now() + 20_000
  while (performance.now() < end) {
    if (childError) throw childError
    if (child && child.exitCode !== null) throw Error(`App exited before ${label}`)
    if (await condition()) return
    await sleep(80)
  }
  throw Error(`Timeout: ${label}`)
}
const send = (method, params = {}) => new Promise((yes, no) => {
  const id = ++nextId, timer = setTimeout(() => { pending.delete(id); no(Error(`CDP timeout ${method}`)) }, 15_000)
  pending.set(id, { yes, no, timer }); socket.send(JSON.stringify({ id, method, params }))
})
const evaluate = async expression => {
  const result = await send('Runtime.evaluate', { expression: `(async()=>{${expression}})()`, awaitPromise: true, returnByValue: true })
  if (result.exceptionDetails) throw Error(result.exceptionDetails.exception?.description ?? 'Renderer error')
  return result.result.value
}
try {
  run(process.execPath, ['node_modules/electron-vite/bin/electron-vite.js', 'build'], 'production build')
  await cp(join(root, 'out'), appDir, { recursive: true })
  await mkdir(join(profile, 'library'), { recursive: true }); await mkdir(music)
  run('ffmpeg.exe', ['-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1', '-c:a', 'libmp3lame', '-y', audio], 'generate MP3')
  assert.equal(NodeID3.update({ title: 'scan old title', artist: 'generated fixture' }, audio), true)
  const info = await stat(audio), id = createHash('sha1').update(audio.toLowerCase()).digest('hex').slice(0, 16)
  await writeFile(join(profile, 'library/index.json'), JSON.stringify({ version: 5, folders: [music], tracks: [{ id, path: audio, name: 'scan old title', singer: 'generated fixture', size: info.size, mtimeMs: info.mtimeMs }] }))
  await writeFile(join(profile, 'settings.json'), JSON.stringify({ libraryFolders: [music], showSearchHotWords: false, onlineDiagnostics: false, onlineLyricSource: 'off', onlineLyricFallback: false, assetWriteTarget: 'embedded', tagWritableFormats: ['mp3'], minimizeToTray: false }))
  const main = join(appDir, 'main/index.js'), original = await readFile(main, 'utf8')
  assert.ok(original.includes('class MusicLibrary {'), 'known production class seam')
  // The observer changes timing only. Parsed values and all IPC handlers stay production code.
  const observer = `
const __scanRead = MusicLibrary.prototype.readTrack;
let __heldScan = false;
MusicLibrary.prototype.readTrack = async function(...args) {
  const track = await __scanRead.apply(this, args);
  if (!__heldScan && args[0] === ${JSON.stringify(audio)} && args[1] !== undefined && (await import('node:fs')).existsSync(${JSON.stringify(arm)})) {
    __heldScan = true;
    const fs = await import('node:fs/promises');
    await fs.writeFile(${JSON.stringify(captured)}, JSON.stringify(track));
    const end = Date.now()+18000;
    while (!(await import('node:fs')).existsSync(${JSON.stringify(release)})) {
      if(Date.now()>end)throw Error('Owned scan gate timeout');
      await new Promise(done=>setTimeout(done,20));
    }
  }
  return track;
};`
  await writeFile(main, original + observer)
  const guard = join(owned, 'probe-main.cjs')
  await writeFile(guard, `
const {app,BrowserWindow,session}=require('electron');
const fs=require('node:fs');
const blocked=(stage,raw)=>{let host='unparseable';try{host=new URL(typeof raw==='string'||raw instanceof URL?String(raw):raw.url).hostname;}catch{}fs.appendFileSync(${JSON.stringify(blocked)},JSON.stringify({stage,host,blocked:true})+'\\n');};
globalThis.fetch=(raw)=>{blocked('node-fetch',raw);return Promise.reject(Error('Offline probe'));};
BrowserWindow.prototype.show=function(){};
app.on('browser-window-created',(_,w)=>w.webContents.setBackgroundThrottling(false));
app.whenReady().then(()=>session.defaultSession.webRequest.onBeforeRequest({urls:['http://*/*','https://*/*']},(details,cb)=>{blocked('renderer',details.url);cb({cancel:true});}));
import(${JSON.stringify(pathToFileURL(main).href)}).catch(e=>{console.error(e);app.exit(1);});`)
  const port = await new Promise(yes => { const server = createServer(); server.listen(0, '127.0.0.1', () => { const port = server.address().port; server.close(() => yes(port)) }) })
  const log = openSync(join(output, `${runId}-main.log`), 'w')
  try {
    child = spawn(join(root, 'node_modules/electron/dist/electron.exe'), [guard, `--user-data-dir=${profile}`, '--disable-background-networking'], { cwd: root, windowsHide: true, stdio: ['ignore', log, log], env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined, NODE_OPTIONS: undefined, JJ_ALLOW_DEBUG_PORT: '1', JJ_DEBUG_PORT: String(port) } })
    child.once('error', error => { childError = error })
  } finally { closeSync(log) }
  let target
  await wait(async () => { try { target = (await (await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(1000) })).json()).find(t => t.type === 'page'); return !!target } catch { return false } }, 'renderer')
  socket = new WebSocket(target.webSocketDebuggerUrl)
  socket.addEventListener('message', event => {
    const message = JSON.parse(event.data), task = pending.get(message.id)
    if (task) { clearTimeout(task.timer); pending.delete(message.id); message.error ? task.no(Error(message.error.message)) : task.yes(message.result) }
    if (message.method === 'Runtime.exceptionThrown') report.errors.push(message.params.exceptionDetails.text)
  })
  await new Promise((yes, no) => { socket.addEventListener('open', yes, { once: true }); socket.addEventListener('error', no, { once: true }) })
  await send('Runtime.enable')
  await wait(() => evaluate('return !!window.jj && !!document.querySelector("h1")'), 'production page')
  check('owned data directory', resolve((await evaluate('return await window.jj.data.location()')).dir).toLowerCase() === profile.toLowerCase())
  check('no actual source scripts', (await evaluate('return await window.jj.sources.list()')).length === 0)
  await evaluate('location.hash="#/library"')
  await wait(() => evaluate('return document.body.innerText.includes("scan old title")'), 'indexed title in UI')
  assert.equal(NodeID3.update({ title: 'scan captured old title' }, audio), true)
  await writeFile(arm, '')
  check('real DOM rescan clicked', await evaluate('const b=[...document.querySelectorAll("button")].find(b=>b.textContent.includes("重新扫描")); if(!b||b.disabled)return false;b.click();return true'))
  await wait(() => Promise.resolve(existsSync(captured)), 'scan captured old metadata')
  check('observer captured actual old title', JSON.parse(await readFile(captured, 'utf8')).name === 'scan captured old title')
  const written = await evaluate('const track=(await window.jj.library.tracks())[0];return await window.jj.match.apply(track,{title:"confirmed final title"},{withLyrics:false,withCover:false})')
  check('production match IPC embedded a real MP3 tag', written.written && written.embeddedWritten)
  check('actual file reads back confirmed title', (await parseFile(audio)).common.title === 'confirmed final title')
  check('index refreshed before scan release', (await evaluate('return (await window.jj.library.tracks())[0].name')) === 'confirmed final title')
  await writeFile(release, '')
  await wait(() => evaluate('const b=[...document.querySelectorAll("button")].find(b=>b.textContent.includes("重新扫描")); return b && !b.disabled'), 'DOM scan complete')
  report.finalName = await evaluate('return (await window.jj.library.tracks())[0].name')
  check('late production scan preserves confirmed title', report.finalName === 'confirmed final title')
  check('disk index preserves confirmed title', JSON.parse(await readFile(join(profile, 'library/index.json'), 'utf8')).tracks[0].name === 'confirmed final title')
  check('renderer shows confirmed title after rescan', await evaluate('return document.body.innerText.includes("confirmed final title") && !document.body.innerText.includes("scan captured old title")'))
  check('no renderer exceptions', report.errors.length === 0)
  report.status = 'passed'
} catch (error) { report.status = 'failed'; report.error = error.stack; process.exitCode = 1 }
finally {
  await writeFile(release, '').catch(() => {})
  if (socket?.readyState === WebSocket.OPEN) await evaluate('window.jj.window.close()').catch(() => {})
  if (child && child.exitCode === null) { for (let i = 0; i < 50 && child.exitCode === null; i++) await sleep(100) }
  socket?.close()
  report.normalExit = !!child && child.exitCode === 0
  if (child && child.exitCode === null) { child.kill(); await new Promise(done => child.once('exit', done)) }
  for (const task of pending.values()) clearTimeout(task.timer)
  report.blockedRequests = existsSync(blocked) ? (await readFile(blocked, 'utf8')).trim().split('\n').map(line => JSON.parse(line)) : []
  if (resolve(owned).startsWith(resolve(output) + sep) && resolve(owned) === join(resolve(output), runId)) {
    await rm(owned, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); report.profileRemoved = true
  }
  if (report.status === 'passed' && !report.normalExit) { report.status = 'failed'; report.error = 'App did not exit normally'; process.exitCode = 1 }
  await writeFile(join(output, `${runId}-report.json`), JSON.stringify(report, null, 2))
  await writeFile(join(output, 'report.json'), JSON.stringify(report, null, 2))
  console.log(JSON.stringify(report))
}
