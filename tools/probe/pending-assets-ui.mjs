/** Production Electron acceptance using an owned, offline, disposable profile. */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { spawn, spawnSync } from 'node:child_process'
import { openSync, closeSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, rmdir, stat, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const output = join(root, '.cache/pending-assets-ui')
await mkdir(output, { recursive: true })
const runId = randomUUID()
const reportFile = join(output, 'report.json')
const report = { runId, status: 'starting', checks: [], screenshots: [], profileRemoved: false }
const saveReport = () => {
  const text = JSON.stringify(report, null, 2)
  return Promise.all([writeFile(reportFile, text), writeFile(join(output, `${runId}-report.json`), text)])
}
await saveReport()
let profile, child, socket, startupError
let nextId = 0
const pending = new Map()
const rendererErrors = []
const sleep = ms => new Promise(resolveWait => setTimeout(resolveWait, ms))
const check = (name, condition) => { assert.ok(condition, name); report.checks.push(name) }

try {
  const buildLog = openSync(join(output, `${runId}-build.log`), 'w')
  let built
  try {
    built = spawnSync(process.execPath, [join(root, 'node_modules/electron-vite/bin/electron-vite.js'), 'build'], {
      cwd: root, windowsHide: true, stdio: ['ignore', buildLog, buildLog], timeout: 120_000
    })
  } finally { closeSync(buildLog) }
  assert.ifError(built.error)
  assert.equal(built.status, 0, 'fresh production build succeeds')
  profile = await mkdtemp(join(output, 'fixture-'))
  await mkdir(join(profile, 'library'))
  const musicFolder = join(profile, 'generated-music')
  await mkdir(musicFolder)
  const localAudio = join(musicFolder, 'fixture-local.wav')
  const sidecar = join(musicFolder, 'fixture-local.lrc')
  // One second of generated mono PCM silence; no real recording is read.
  const wav = Buffer.alloc(44 + 16_000)
  wav.write('RIFF', 0); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8)
  wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22)
  wav.writeUInt32LE(8000, 24); wav.writeUInt32LE(16_000, 28)
  wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34)
  wav.write('data', 36); wav.writeUInt32LE(16_000, 40)
  await writeFile(localAudio, wav)
  await writeFile(join(profile, 'settings.json'), JSON.stringify({
    showSearchHotWords: false, onlineDiagnostics: false, onlineLyricSource: 'off',
    onlineLyricFallback: false, libraryFolders: [musicFolder], assetWriteTarget: 'sidecar',
    recentPlayed: [], queueHistory: [], minimizeToTray: false
  }))
  const queueFile = join(profile, 'library/pending-assets.json')
  const broken = '{"entries":["private-corrupt-fixture"'
  await writeFile(queueFile, broken)
  const audioPath = join(profile, 'fixture.mp3')
  await writeFile(audioPath, 'fixture-owned-audio-sentinel')
  const blockedFile = join(profile, 'blocked.log')
  const captureRequest = join(profile, 'capture-request.json')
  const captureResult = join(profile, 'capture-result.json')
  const guard = join(profile, 'probe-main.cjs')
  await writeFile(guard, `
const { app, BrowserWindow, session } = require('electron');
const fs = require('node:fs');
const blocked = () => require('node:fs').appendFileSync(${JSON.stringify(blockedFile)}, 'blocked\\n');
const local = raw => ['127.0.0.1','localhost','[::1]'].includes(new URL(raw).hostname);
const previous = globalThis.fetch;
globalThis.fetch = (...args) => {
  const raw = args[0]; const url = typeof raw === 'string' || raw instanceof URL ? String(raw) : raw.url;
  if (!local(url)) { blocked(); return Promise.reject(new Error('Offline fixture blocks external fetch')); }
  return previous(...args);
};
// Hide only this probe's windows; production main/preload/renderer stay intact.
BrowserWindow.prototype.show = function () {};
app.on('browser-window-created', (_event, window) => window.webContents.setBackgroundThrottling(false));
app.whenReady().then(() => session.defaultSession.webRequest.onBeforeRequest({ urls: ['http://*/*','https://*/*'] }, (details, callback) => {
  const cancel = !local(details.url); if (cancel) blocked(); callback({ cancel });
}));
// Owned-file observer only: no production IPC, arbitrary paths, or window show.
const captureLabels = new Set(['corrupt','repaired','after-restart','before-write','write-failed','after-write','mixed-queue']);
const mainUrl = ${JSON.stringify(pathToFileURL(join(root, 'out/renderer/index.html')).href)};
let captureBusy = false, lastCapture;
const captureTimer = setInterval(async () => {
  if (captureBusy) return;
  let request;
  try {
    if (!fs.lstatSync(${JSON.stringify(captureRequest)}).isFile()) return;
    request = JSON.parse(fs.readFileSync(${JSON.stringify(captureRequest)}, 'utf8'));
  } catch { return; }
  if (!request || !/^[a-f0-9-]{36}$/.test(request.requestId) || request.requestId === lastCapture || !captureLabels.has(request.label)) return;
  captureBusy = true; lastCapture = request.requestId;
  let result = { requestId: request.requestId, label: request.label };
  try {
    const window = BrowserWindow.getAllWindows().find(window => !window.isDestroyed() && window.webContents.getURL().split(/[?#]/)[0] === mainUrl);
    if (!window) throw new Error('Owned main window is not ready');
    result.visibleBefore = window.isVisible();
    // Hidden capture may initially return the last compositor frame. Warm it,
    // then let real renderer transitions finish before taking the evidence.
    await window.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true });
    await window.webContents.executeJavaScript('Promise.race([Promise.allSettled(document.getAnimations().map(animation => animation.finished)), new Promise(resolve => setTimeout(resolve, 600))])');
    await new Promise(resolve => setTimeout(resolve, 200));
    const image = await window.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true });
    if (image.isEmpty()) throw new Error('Native capture returned an empty image');
    result.visibleAfter = window.isVisible();
    result.size = image.getSize();
    result.warmedCompositor = true;
    result.file = ${JSON.stringify(runId + '-')} + request.label + '.png';
    fs.writeFileSync(require('node:path').join(${JSON.stringify(output)}, result.file), image.toPNG());
    result.ok = true;
  } catch (error) { result.ok = false; result.error = error.message; }
  try { fs.writeFileSync(${JSON.stringify(captureResult)}, JSON.stringify(result)); }
  finally { captureBusy = false; }
}, 40);
captureTimer.unref();
app.on('will-quit', () => clearInterval(captureTimer));
import(${JSON.stringify(pathToFileURL(join(root, 'out/main/index.js')).href)}).catch(error => { console.error(error); app.exit(1); });
`)
  const waitFor = async (condition, label) => {
    const deadline = performance.now() + 20_000
    while (performance.now() < deadline) {
      if (startupError) throw startupError
      if (child.exitCode !== null || child.signalCode !== null) throw new Error(`Electron stopped before ${label}`)
      if (await condition()) return
      await sleep(100)
    }
    throw new Error(`Timed out: ${label}`)
  }
  let instance = 0
  const launch = async () => {
    instance++
    startupError = undefined
    const port = await new Promise((resolvePort, reject) => {
      const server = createServer()
      server.once('error', reject)
      server.listen(0, '127.0.0.1', () => { const port = server.address().port; server.close(() => resolvePort(port)) })
    })
    const mainLog = openSync(join(output, `${runId}-main-${instance}.log`), 'w')
    try {
      child = spawn(join(root, 'node_modules/electron/dist/electron.exe'), [guard, `--user-data-dir=${profile}`, '--disable-background-networking'], {
        cwd: root, windowsHide: true, stdio: ['ignore', mainLog, mainLog],
        env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined, JJ_ALLOW_DEBUG_PORT: '1', JJ_DEBUG_PORT: String(port), NODE_OPTIONS: undefined }
      })
      child.once('error', error => { startupError = error })
    } finally { closeSync(mainLog) }
    report.status = 'running'
    await saveReport()
    let target
    await waitFor(async () => {
      try { target = (await (await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(1000) })).json()).find(item => item.type === 'page') }
      catch { return false }
      return !!target
    }, 'renderer CDP target')
    socket = new WebSocket(target.webSocketDebuggerUrl)
    socket.addEventListener('message', event => {
      const message = JSON.parse(event.data)
      if (message.method === 'Runtime.exceptionThrown') rendererErrors.push(message.params.exceptionDetails.text)
      const task = pending.get(message.id)
      if (task) {
        pending.delete(message.id); clearTimeout(task.timer)
        message.error ? task.reject(new Error(message.error.message)) : task.resolve(message.result)
      }
    })
    await new Promise((resolveOpen, reject) => {
      const timer = setTimeout(() => reject(new Error('CDP connection timeout')), 5000)
      socket.addEventListener('open', () => { clearTimeout(timer); resolveOpen() }, { once: true })
      socket.addEventListener('error', () => { clearTimeout(timer); reject(new Error('CDP connection failed')) }, { once: true })
    })
  }
  const send = (method, params = {}) => new Promise((resolveCommand, reject) => {
    const id = ++nextId
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP timeout: ${method}`)) }, 10_000)
    pending.set(id, { resolve: resolveCommand, reject, timer })
    socket.send(JSON.stringify({ id, method, params }))
  })
  const evaluate = async expression => {
    const result = await send('Runtime.evaluate', { expression: `(async () => (${expression}))()`, awaitPromise: true, returnByValue: true })
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? 'Renderer evaluation failed')
    return result.result.value
  }
  const screenshot = async label => {
    const requestId = randomUUID()
    await writeFile(captureRequest, JSON.stringify({ requestId, label }))
    let result
    await waitFor(async () => {
      try { result = JSON.parse(await readFile(captureResult, 'utf8')) } catch { return false }
      return result.requestId === requestId
    }, `native hidden screenshot ${label}`)
    assert.equal(result.ok, true, result.error)
    assert.equal(result.label, label)
    assert.equal(result.file, `${runId}-${label}.png`)
    assert.equal(result.visibleBefore, false, 'native capture must start hidden')
    assert.equal(result.visibleAfter, false, 'native capture must stay hidden')
    assert.ok(result.size.width > 0 && result.size.height > 0)
    const png = await readFile(join(output, result.file))
    assert.ok(png.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex')), 'native capture must be a PNG')
    ;(report.nativeCaptures ??= []).push({ ...result, instance })
    report.screenshots.push(result.file)
  }
  await launch()
  await send('Runtime.enable')
  await waitFor(() => evaluate('!!window.jj && !!document.querySelector("h1")'), 'production UI')
  report.electronVersion = await evaluate('navigator.userAgent.split("Electron/")[1]?.split(" ")[0]')
  check('startup uses only owned profile', resolve((await evaluate('window.jj.data.location()')).dir).toLowerCase() === profile.toLowerCase())
  check('no actual sources loaded', (await evaluate('window.jj.sources.list()')).length === 0)
  await evaluate('location.hash = "#/settings/assets"')
  await waitFor(() => evaluate('document.body.innerText.includes("待写入资料已损坏")'), 'corrupt-file feedback')
  const buttons = () => evaluate('Array.from(document.querySelectorAll("button")).filter(b=>["全部写入","全部丢弃"].includes(b.textContent.trim())).map(b=>({text:b.textContent.trim(),disabled:b.disabled}))')
  check('corrupt queue actions disabled', (await buttons()).length === 2 && (await buttons()).every(button => button.disabled))
  check('failure is distinct from empty', !await evaluate('document.body.innerText.includes("没有等待写入的内容")'))
  check('corrupt content not displayed', !await evaluate('document.body.innerText.includes("private-corrupt-fixture")'))
  for (const operation of ['pending', 'writePending', 'discardPending']) {
    const error = await evaluate(`window.jj.assets.${operation}().then(()=>null,error=>error.message)`)
    check(`${operation} rejects corrupted queue`, typeof error === 'string' && error.includes('原文件已保留'))
  }
  check('corrupt bytes preserved', await readFile(queueFile, 'utf8') === broken)
  await screenshot('corrupt')
  const entry = { trackId: 'fixture-track', kind: 'lyric', path: audioPath, name: '恢复测试歌曲', singer: '合成歌手', at: 1, lyric: '[00:01]合成待写入' }
  await writeFile(queueFile, JSON.stringify({ entries: [entry], dismissed: [] }))
  await evaluate('location.hash = "#/settings/data"')
  await waitFor(() => evaluate('!!document.querySelector("[aria-label=本地在线诊断]")'), 'leave assets settings')
  await evaluate('location.hash = "#/settings/assets"')
  await waitFor(() => evaluate('document.body.innerText.includes("1 项等待写入")'), 'same-instance repair')
  check('repaired queue actions enabled', (await buttons()).length === 2 && (await buttons()).every(button => !button.disabled))
  check('same instance reads repaired selection', (await evaluate('window.jj.assets.pending()'))[0]?.trackId === entry.trackId)
  await screenshot('repaired')
  await evaluate('Array.from(document.querySelectorAll("button")).find(b=>b.textContent.trim()==="全部丢弃").click()')
  await waitFor(() => evaluate('document.body.innerText.includes("没有等待写入的内容")'), 'discard repaired fixture')
  check('recovered discard persisted', JSON.parse(await readFile(queueFile, 'utf8')).entries.length === 0)
  check('audio sentinel unchanged', await readFile(audioPath, 'utf8') === 'fixture-owned-audio-sentinel')

  // Exercise an actual indexed track and the user's explicit write decision.
  const tracks = await evaluate('window.jj.library.tracks()')
  const track = tracks.find(item => resolve(item.path).toLowerCase() === localAudio.toLowerCase())
  check('generated WAV scanned into local library', !!track && track.duration === 1 && track.sampleRate === 8000)
  check('only generated folder scanned', tracks.length === 1 && (await evaluate('window.jj.library.folders()')).length === 1)
  check('sidecar write target active', (await evaluate('window.jj.settings.get()')).assetWriteTarget === 'sidecar')
  const lyric = '[00:01]合成确认写入歌词'
  let tlyric = '[00:01]合成翻译'
  const rlyric = '[00:01]synthetic romanization'
  const staged = await evaluate(`window.jj.lyric.stageCandidate(${JSON.stringify(track.id)},${JSON.stringify({ lyric, tlyric, rlyric })})`)
  report.stagedChoice = { source: staged.source, hasProviderRevision: typeof staged.provider === 'string' }
  check('production staging creates pending choice', (await evaluate('window.jj.assets.pending()')).some(item => item.trackId === track.id && item.lyric === lyric))
  check('staged choice immediately resolves in production', (await evaluate(`window.jj.lyric.resolve(${JSON.stringify(track.id)},false)`)).lyric === lyric)
  await evaluate('location.hash = "#/settings/data"')
  await waitFor(() => evaluate('!!document.querySelector("[aria-label=本地在线诊断]")'), 'leave for pending refresh')
  await evaluate('location.hash = "#/settings/assets"')
  await waitFor(() => evaluate('document.body.innerText.includes("1 项等待写入")'), 'choice ready for discard')
  await evaluate('Array.from(document.querySelectorAll("button")).find(b=>b.textContent.trim()==="全部丢弃").click()')
  await waitFor(() => evaluate('document.body.innerText.includes("没有等待写入的内容")'), 'chosen lyric discarded')
  check('discarded choice no longer resolves offline', (await evaluate(`window.jj.lyric.resolve(${JSON.stringify(track.id)},false)`)).source === 'none')
  check('discarded choice remains absent from pending', (await evaluate('window.jj.assets.pending()')).length === 0)
  tlyric = '[00:01]重新选择的新翻译'
  await evaluate(`window.jj.lyric.stageCandidate(${JSON.stringify(track.id)},${JSON.stringify({ lyric, tlyric, rlyric })})`)
  check('explicit reselection restores discarded lyric with new translation', (await evaluate('window.jj.assets.pending()')).some(item => item.trackId === track.id && item.lyric === lyric && item.tlyric === tlyric))
  check('explicit reselection immediately displays new translation', (await evaluate(`window.jj.lyric.resolve(${JSON.stringify(track.id)},false)`)).tlyric === tlyric)
  const sidecarExists = await readFile(sidecar).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error })
  check('staging does not write sidecar', !sidecarExists)
  await evaluate('location.hash = "#/settings/data"')
  await waitFor(() => evaluate('Array.from(document.querySelectorAll("button")).some(b=>b.textContent.trim()==="清除资料缓存")'), 'cache clear button')
  await evaluate('Array.from(document.querySelectorAll("button")).find(b=>b.textContent.trim()==="清除资料缓存").click()')
  await waitFor(() => evaluate('document.body.innerText.includes("在线资料缓存已清除")'), 'cache cleared feedback')
  check('cache clear preserves pending in service', (await evaluate('window.jj.assets.pending()')).some(item => item.trackId === track.id && item.lyric === lyric))
  check('cache clear preserves pending on disk', JSON.parse(await readFile(queueFile, 'utf8')).entries.some(item => item.trackId === track.id && item.lyric === lyric))
  check('chosen lyric remains available offline after cache clear', (await evaluate(`window.jj.lyric.resolve(${JSON.stringify(track.id)},false)`)).lyric === lyric)
  const firstPid = child.pid
  const beforeRestart = await readFile(queueFile, 'utf8')
  const firstExit = new Promise((resolveExit, reject) => {
    const timer = setTimeout(() => reject(new Error('Production close did not exit; owned profile retained')), 10_000)
    child.once('exit', (code, signal) => { clearTimeout(timer); resolveExit({ code, signal }) })
  })
  // The response may race renderer shutdown; CDP send observes its own errors.
  void evaluate('window.jj.window.close()').catch(() => undefined)
  const exit = await firstExit
  check('first instance exits normally through production close', exit.code === 0 && exit.signal === null)
  socket.close()
  for (const task of pending.values()) { clearTimeout(task.timer); task.reject(new Error('Instance closed')) }
  pending.clear()
  await launch()
  await send('Runtime.enable')
  await waitFor(() => evaluate('!!window.jj && !!document.querySelector("h1")'), 'restarted production UI')
  check('restart uses a different process', child.pid !== firstPid)
  check('restart uses same owned profile', resolve((await evaluate('window.jj.data.location()')).dir).toLowerCase() === profile.toLowerCase())
  check('restart does not load real sources', (await evaluate('window.jj.sources.list()')).length === 0)
  check('restart preserves pending file byte-identically', await readFile(queueFile, 'utf8') === beforeRestart)
  check('restart preserves indexed track identity', (await evaluate('window.jj.library.tracks()')).some(item => item.id === track.id && resolve(item.path).toLowerCase() === localAudio.toLowerCase()))
  check('restart restores pending lyric choice', (await evaluate('window.jj.assets.pending()')).some(item => item.trackId === track.id && item.lyric === lyric))
  await evaluate('location.hash = "#/settings/assets"')
  await waitFor(() => evaluate('document.body.innerText.includes("1 项等待写入")'), 'restored pending settings')
  check('restart does not write sidecar without confirmation', await stat(sidecar).then(() => false, error => { if (error.code === 'ENOENT') return true; throw error }))
  const restored = await evaluate(`window.jj.lyric.resolve(${JSON.stringify(track.id)},false)`)
  check('restart restores chosen lyric for offline display', restored.lyric === lyric && restored.asset?.pending === true)
  check('restart preserves chosen translation and romanization', restored.tlyric === tlyric && restored.rlyric === rlyric)
  check('restored lyric read does not rewrite pending choice', await readFile(queueFile, 'utf8') === beforeRestart)
  await screenshot('after-restart')
  await evaluate('location.hash = "#/settings/assets"')
  await waitFor(() => evaluate('document.body.innerText.includes("1 项等待写入")'), 'staged write in settings')
  await screenshot('before-write')
  // A directory at the output filename causes a real atomic rename failure.
  // Keep the obstruction inside this run's owned profile, without ACL changes.
  const pendingBeforeFailure = await readFile(queueFile, 'utf8')
  await mkdir(sidecar)
  await evaluate('Array.from(document.querySelectorAll(".toast__close")).forEach(b=>b.click())')
  await evaluate('Array.from(document.querySelectorAll("button")).find(b=>b.textContent.trim()==="全部写入").click()')
  await waitFor(() => evaluate('Array.from(document.querySelectorAll(".toast--error")).some(t=>t.textContent.includes("fixture-local.lrc"))'), 'actual sidecar write failure feedback')
  check('failed write explicitly reports output failure', await evaluate('Array.from(document.querySelectorAll(".toast--error")).some(t=>t.textContent.includes("fixture-local.lrc"))'))
  await screenshot('write-failed')
  check('failed write preserves pending choice in service', (await evaluate('window.jj.assets.pending()')).some(item => item.trackId === track.id && item.lyric === lyric))
  check('failed write preserves pending file byte-identically', await readFile(queueFile, 'utf8') === pendingBeforeFailure)
  check('failed write leaves generated audio byte-identical', (await readFile(localAudio)).equals(wav))
  check('failed write preserves output obstruction', (await stat(sidecar)).isDirectory())
  check('failed write cleans temporary output files', !(await readdir(musicFolder)).some(file => file.endsWith('.tmp')))
  check('failed write keeps retry available', (await buttons()).length === 2 && (await buttons()).every(button => !button.disabled))
  check('failed write does not display empty queue', await evaluate('document.body.innerText.includes("1 项等待写入") && !document.body.innerText.includes("没有等待写入的内容")'))
  // Non-recursive removal: an unexpectedly nonempty obstruction is retained.
  await rmdir(sidecar)
  await evaluate('Array.from(document.querySelectorAll(".toast__close")).forEach(b=>b.click())')
  await evaluate('Array.from(document.querySelectorAll("button")).find(b=>b.textContent.trim()==="全部写入").click()')
  await waitFor(() => evaluate('document.body.innerText.includes("没有等待写入的内容")'), 'all-write completes')
  check('all-write publishes expected sidecar', (await readFile(sidecar, 'utf8')).trim() === lyric)
  check('all-write clears persisted pending choice', JSON.parse(await readFile(queueFile, 'utf8')).entries.length === 0)
  check('sidecar write leaves generated audio byte-identical', (await readFile(localAudio)).equals(wav))
  const resolved = await evaluate(`window.jj.lyric.resolve(${JSON.stringify(track.id)},false)`)
  check('written sidecar resolves locally', resolved.source === 'sidecar' && resolved.lyric === lyric)
  await screenshot('after-write')
  check('no renderer exceptions', rendererErrors.length === 0)
  let blocked = ''
  try { blocked = await readFile(blockedFile, 'utf8') } catch (error) { if (error.code !== 'ENOENT') throw error }
  check('no external request attempts', blocked === '')

  // Read the production Pinia instance, without adding a dev hook or replacing
  // any action/IPC. These online rows contain only synthetic identities, no URLs.
  const stores = 'document.querySelector("#app").__vue_app__.config.globalProperties.$pinia._s'
  check('production player and library stores are available', await evaluate(`(${stores}).has('player') && (${stores}).has('library')`))
  const onlineWy = { id: 'wy_or8-fixture', source: 'wy', name: track.name, singer: track.singer, albumName: track.albumName, interval: '00:01', meta: { songmid: 'or8-fixture' } }
  const onlineTx = { ...onlineWy, id: 'tx_or8-fixture', source: 'tx' }
  const mixed = [track, onlineWy, onlineTx]
  report.mixedQueueScope = { onlineSamples: 'synthetic identities without media or cover URLs', drag: 'synthetic DOM DragEvent/DataTransfer through production handlers; no physical mouse claim', providerBindingUi: 'not tested: no per-provider binding selector exists in current SettingsView/SourcesView' }
  await evaluate(`(async()=>{ const player=(${stores}).get('player'); player.clearQueue(); await player.addToQueue(${JSON.stringify(mixed)}); await player.addToQueue(${JSON.stringify(mixed)}); })()`)
  let queue = await evaluate(`(${stores}).get('player').queue.map(item=>({id:item.id,source:item.source??'local'}))`)
  check('mixed queue preserves separate local wy and tx identities without duplicates', queue.length === 3 && queue.map(item => item.id).join() === mixed.map(item => item.id).join())
  check('mixed online playback begins with no enabled source', (await evaluate('window.jj.sources.available()')).length === 0)
  await evaluate(`(${stores}).get('player').playTrackAt(1,{autoplay:false,retryUrl:false,transition:false})`)
  const rejectedOnline = await evaluate(`(()=>{const player=(${stores}).get('player');return {id:player.currentTrack?.id,error:player.error,playing:player.playing,loading:player.loading,resource:player.resolvedResource,queue:player.queue.map(item=>item.id)}})()`)
  check('online source failure is explicit without playing or loading', !!rejectedOnline.error && rejectedOnline.playing === false && rejectedOnline.loading === false)
  check('unavailable online identity does not silently fall back to local', rejectedOnline.id === onlineWy.id && rejectedOnline.resource === null)
  check('online source failure preserves all queue entries', rejectedOnline.queue.join() === mixed.map(item => item.id).join())
  await evaluate('document.querySelector("[aria-label=播放队列]").click()')
  await waitFor(() => evaluate('document.querySelectorAll(".np-panel .track-row").length === 3'), 'mixed queue rows')
  const domDrag = await evaluate(`(()=>{
    const rows=Array.from(document.querySelectorAll('.np-panel .track-row'));
    const source=rows[0], target=rows[2], rect=target.getBoundingClientRect(), dataTransfer=new DataTransfer();
    source.dispatchEvent(new DragEvent('dragstart',{bubbles:true,cancelable:true,dataTransfer}));
    const allowed=!target.dispatchEvent(new DragEvent('dragover',{bubbles:true,cancelable:true,dataTransfer,clientY:rect.bottom-1}));
    target.dispatchEvent(new DragEvent('drop',{bubbles:true,cancelable:true,dataTransfer,clientY:rect.bottom-1}));
    source.dispatchEvent(new DragEvent('dragend',{bubbles:true,dataTransfer}));
    return {allowed,payload:dataTransfer.getData('text/plain')};
  })()`)
  await waitFor(() => evaluate(`(${stores}).get('player').queue[2]?.id === ${JSON.stringify(track.id)}`), 'DOM drag reordered mixed queue')
  queue = await evaluate(`(${stores}).get('player').queue.map(item=>item.id)`)
  check('queue DOM drag and drop handlers accept the move', domDrag.allowed && domDrag.payload === '0')
  check('queue DOM drag reorders all three identities', queue.join() === [onlineWy.id, onlineTx.id, track.id].join())
  check('queue DOM drag preserves current online playback intent identity', await evaluate(`(${stores}).get('player').currentTrack?.id === ${JSON.stringify(onlineWy.id)} && (${stores}).get('player').currentIndex === 0`))
  await screenshot('mixed-queue')
  await evaluate('document.querySelector("[aria-label=关闭播放面板]").click()')
  await evaluate(`(async()=>{ const library=(${stores}).get('library'); for(const track of ${JSON.stringify(mixed)}) await library.toggleFavorite(track); })()`)
  const favorites = await evaluate('window.jj.playlists.items("favorites")')
  check('favorites preserve same-name local wy and tx identities independently', favorites.length === 3 && favorites.every(item => item.name === track.name) && new Set(favorites.map(item => item.id)).size === 3)
  const duplicateAdded = await evaluate(`window.jj.playlists.addTracks('favorites',${JSON.stringify(mixed)})`)
  check('duplicate favorites additions do not duplicate persisted entries', duplicateAdded === 0 && (await evaluate('window.jj.playlists.items("favorites")')).length === 3)
  await evaluate(`(${stores}).get('library').toggleFavorite(${JSON.stringify(onlineWy)})`)
  const kept = await evaluate('window.jj.playlists.items("favorites")')
  check('removing wy favorite leaves local and tx favorites intact', kept.length === 2 && kept.some(item => item.id === track.id) && kept.some(item => item.id === onlineTx.id))
  check('removing favorite does not mutate mixed playback queue', (await evaluate(`(${stores}).get('player').queue.map(item=>item.id)`)).join() === queue.join())
  check('mixed queue scenario introduces no renderer exceptions', rendererErrors.length === 0)
  let mixedBlocked = ''
  try { mixedBlocked = await readFile(blockedFile, 'utf8') } catch (error) { if (error.code !== 'ENOENT') throw error }
  check('mixed online samples make no external request attempts', mixedBlocked === '')
  report.status = 'passed'
} catch (error) {
  report.status = 'failed'
  report.error = error instanceof Error ? error.message : String(error)
  process.exitCode = 1
} finally {
  socket?.close()
  for (const task of pending.values()) clearTimeout(task.timer)
  try {
    if (child?.pid && child.exitCode === null && child.signalCode === null) {
      const stopped = new Promise((resolveExit, reject) => {
        const timer = setTimeout(() => reject(new Error('Owned Electron did not exit; profile retained')), 5000)
        child.once('exit', () => { clearTimeout(timer); resolveExit() })
      })
      child.kill()
      await stopped
    }
    if (profile) {
      assert.equal(dirname(resolve(profile)), output)
      assert.ok(basename(profile).startsWith('fixture-'))
      assert.equal((await realpath(profile)).toLowerCase(), resolve(profile).toLowerCase())
      await rm(profile, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 })
      report.profileRemoved = true
    }
  } catch (error) {
    report.status = 'failed'
    report.cleanupError = error.message
    process.exitCode = 1
  }
  await saveReport()
  console.log(JSON.stringify(report, null, 2))
}
