/** Fixture-only native Electron QA: fresh profile, generated disabled source only. */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer } from 'node:net'
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const output = join(root, '.cache/online-reliability-baseline')
await mkdir(output, { recursive: true })
const profile = await mkdtemp(join(output, 'fixture-profile-'))
await mkdir(join(profile, 'cache/online/v1'), { recursive: true })
await mkdir(join(profile, 'library'), { recursive: true })
await writeFile(join(profile, 'settings.json'), JSON.stringify({ showSearchHotWords: false, onlineReliability: true, onlineDiagnostics: true, onlineLyricSource: 'platform', onlineLyricFallback: false, recentPlayed: [], queueHistory: [], libraryFolders: [], minimizeToTray: false }))
const sentinel = join(profile, 'library/manual-resource.txt')
await writeFile(sentinel, 'user-owned-fixture')
const key = JSON.stringify([1, 'artistDetail', 'wy', '7:1', 'zh-CN', 'wy-1', '', ''])
const now = Date.now()
const artUrl = 'https://p1.music.126.net/fixture.png'
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=', 'base64')
const hash = createHash('sha256').update(png).digest('hex')
await mkdir(join(profile, 'library/covers/online-cache-v1'), { recursive: true })
await writeFile(join(profile, 'library/covers/online-cache-v1', `${hash}.bin`), png)
const assetEntry = data => ({ data, fetchedAt: now, expiresAt: now + 30 * 86400_000, staleUntil: now + 180 * 86400_000, persist: true })
const assetKey = (capability, identity) => JSON.stringify([1, capability, 'wy', identity, 'zh-CN', 'wy-1', '', ''])
await writeFile(join(profile, 'cache/online/v1/covers.json'), JSON.stringify({ schema: 1, entries: [[assetKey('cover', createHash('sha256').update(artUrl).digest('hex')), assetEntry({ hash, size: png.length, mimeType: 'image/png' })]] }))
await writeFile(join(profile, 'cache/online/v1/lyrics.json'), JSON.stringify({ schema: 1, entries: [[assetKey('lyrics', '123'), assetEntry({ lyric: '[00:01]合成缓存歌词' })]] }))
const savedCover = join(profile, 'library/covers/manual.png')
await writeFile(savedCover, png)
const fixtureSong = (id, name = `合成歌曲${id}`) => ({ id: `wy_${id}`, name, singer: '合成歌手', source: 'wy', meta: { songmid: String(id), qualitys: [{ type: '128k' }] } })
await writeFile(join(profile, 'playlists.json'), JSON.stringify({ version: 1, playlists: [{ id: 'fixture-refresh', name: '我的合成歌单', source: 'wy', sourceListId: '456', position: 2, coverPath: savedCover }], items: { 'fixture-refresh': [fixtureSong(1, '保留的本地标题'), fixtureSong(2)] } }))
const modeFile = join(profile, 'playlist-mode.txt')
await writeFile(modeFile, 'normal')
const value = { status: 'available', entity: { id: '7', name: '合成艺术家', pictureUrl: artUrl }, tracks: [{ id: 'wy_1', name: '合成曲目', singer: '合成艺术家', source: 'wy' }], page: 1, total: 1, hasMore: false }
await writeFile(join(profile, 'cache/online/v1/artistDetail.json'), JSON.stringify({ schema: 1, entries: [[key, { data: value, fetchedAt: now, expiresAt: now + 3600_000, staleUntil: now + 7 * 86400_000, persist: true }]] }))
const port = await new Promise((resolvePort, reject) => {
  const server = createServer(); server.on('error', reject)
  server.listen(0, '127.0.0.1', () => { const port = server.address().port; server.close(() => resolvePort(port)) })
})
// Deny external fetch at the Electron Node boundary, including any unexpected
// metadata request. Loopback is reserved for the application protocol and CDP.
const guard = join(profile, 'offline-guard.cjs')
const sourceScript = version => `/*!\n * @name OR6 合成停用源\n * @version ${version}\n * @homepage https://fixture.invalid/source.js\n */\nthrow new Error('Disabled fixture must never execute')`
await writeFile(guard, `const previous = globalThis.fetch; globalThis.fetch = (...args) => { const url = new URL(typeof args[0] === 'string' ? args[0] : args[0].url ?? String(args[0])); const host = url.hostname; if (host === 'music.163.com' && url.pathname === '/api/v6/playlist/detail' && url.searchParams.get('id') === '456') { const mode = require('node:fs').readFileSync(${JSON.stringify(modeFile)}, 'utf8'); require('node:fs').appendFileSync(${JSON.stringify(join(profile, 'playlist-fetches.log'))}, mode+String.fromCharCode(10)); if (mode === 'broken') return Promise.resolve(new Response(JSON.stringify({code:200,playlist:{tracks:'broken'}}))); const ids = mode === 'empty' ? [] : mode === 'partial' ? [1,3,4] : [1,3]; const tracks = ids.filter(id => id !== 4).map(id => ({id,name:'远程标题'+id,ar:[{name:'合成歌手'}],l:{br:128000}})); return Promise.resolve(new Response(JSON.stringify({code:200,playlist:{name:'远程名称',tracks,trackIds:ids.map(id=>({id})),trackCount:ids.length}}))); } if (host === 'music.163.com' && url.pathname === '/api/song/detail') return Promise.resolve(new Response(JSON.stringify({code:200,songs:[]}))); if (host === 'music.163.com' && url.pathname === '/api/v6/playlist/detail' && url.searchParams.get('id') === '456') { const mode = require('node:fs').readFileSync(${JSON.stringify(modeFile)}, 'utf8'); const ids = mode === 'empty' ? [] : mode === 'partial' ? [1,3,4] : [1,3]; const tracks = ids.filter(id => id !== 4).map(id => ({id,name:'远程标题'+id,ar:[{name:'合成歌手'}],l:{br:128000}})); return Promise.resolve(new Response(JSON.stringify({code:200,playlist:{name:'远程名称',tracks,trackIds:ids.map(id=>({id})),trackCount:ids.length}}))); } if (host === 'music.163.com' && url.pathname === '/api/song/detail') return Promise.resolve(new Response(JSON.stringify({code:200,songs:[]}))); if (host === 'music.163.com' && url.pathname === '/api/song/lyric' && url.searchParams.get('id') === '123') { require('node:fs').appendFileSync(${JSON.stringify(join(profile, 'synthetic-fetches.log'))}, 'lyric\\n'); return Promise.resolve(new Response(JSON.stringify({ lrc: { lyric: '[00:02]合成刷新歌词' } }), { headers: { 'Content-Type': 'application/json' } })); } if (!['127.0.0.1','localhost','[::1]'].includes(host)) { require('node:fs').appendFileSync(${JSON.stringify(join(profile, 'blocked-fetches.log'))}, host + '\\n'); return Promise.reject(new Error('Fixture probe blocks external fetch')); } return previous(...args); };`)
await writeFile(guard, (await readFile(guard, 'utf8')) + `;globalThis.__fixtureFetch = globalThis.fetch;globalThis.fetch = (...args) => { const raw = args[0]; const url = new URL(typeof raw === 'string' ? raw : raw.url ?? String(raw)); if (url.href !== 'https://fixture.invalid/source.js') return globalThis.__fixtureFetch(...args); require('node:fs').appendFileSync(${JSON.stringify(join(profile, 'source-checks.log'))}, 'check\\n'); return Promise.resolve(new Response(${JSON.stringify(sourceScript('2'))}, {headers:{'Content-Type':'text/javascript'}})); };`)
const child = spawn(join(root, 'node_modules/electron/dist/electron.exe'), ['.', `--user-data-dir=${profile}`], {
  cwd: root, windowsHide: true, stdio: 'ignore',
  env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined, JJ_DEBUG_PORT: String(port), NODE_OPTIONS: `--require=${guard}` }
})
let socket
const pending = new Map(), errors = []
let nextId = 0
const sleep = ms => new Promise(r => setTimeout(r, ms))
try {
  let target
  for (let i = 0; i < 100 && !target; i++) {
    if (child.exitCode !== null) throw new Error(`Electron exited: ${child.exitCode}`)
    try { target = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find(t => t.type === 'page') } catch {}
    if (!target) await sleep(200)
  }
  assert.ok(target, 'Electron renderer starts')
  socket = new WebSocket(target.webSocketDebuggerUrl)
  socket.addEventListener('message', e => {
    const m = JSON.parse(e.data)
    if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails.text)
    if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') errors.push(JSON.stringify(m.params.args))
    const task = pending.get(m.id)
    if (task) { pending.delete(m.id); clearTimeout(task.timer); m.error ? task.reject(new Error(m.error.message)) : task.resolve(m.result) }
  })
  await new Promise((r, reject) => { socket.addEventListener('open', r, { once: true }); socket.addEventListener('error', reject, { once: true }) })
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++nextId, timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP timeout ${method}`)) }, 10_000)
    pending.set(id, { resolve, reject, timer }); socket.send(JSON.stringify({ id, method, params }))
  })
  const evaluate = async expression => {
    const result = await send('Runtime.evaluate', { expression: `(async () => (${expression}))()`, awaitPromise: true, returnByValue: true })
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? 'Evaluation failed')
    return result.result.value
  }
  await send('Runtime.enable')
  for (let i = 0; i < 100 && !await evaluate('!!window.jj && !!document.querySelector("h1")'); i++) await sleep(100)
  assert.equal(resolve((await evaluate('window.jj.data.location()')).dir).toLowerCase(), profile.toLowerCase(), 'only the synthetic profile is active')
  assert.equal((await evaluate('window.jj.sources.list()')).length, 0, 'no real scripts loaded')
  const lyric = await evaluate('window.jj.music.enrich({id:"wy_123",name:"合成",singer:"合成",source:"wy",meta:{songmid:"123"},picUrl:"https://p1.music.126.net/fixture.png"})')
  assert.equal(lyric.lyric, '[00:01]合成缓存歌词', 'persistent lyric reaches the production enrich IPC')
  assert.equal(lyric.asset.reliability.cacheState, 'fresh')
  assert.ok(lyric.picUrl.startsWith('data:image/png;base64,'), 'online playback enrichment also uses the cached platform cover')
  const refreshed = await evaluate('window.jj.music.enrich({id:"wy_123",name:"合成",singer:"合成",source:"wy",meta:{songmid:"123"},picUrl:"fixture-existing"},"platform")')
  assert.equal(refreshed.lyric, '[00:02]合成刷新歌词', 'explicit lyric source selection bypasses the 30-day cache')
  assert.equal((await readFile(join(profile, 'synthetic-fetches.log'), 'utf8')).trim(), 'lyric', 'one synthetic refresh, no external connection')
  await evaluate('location.hash = "#/online/artist/wy/7"')
  for (let i = 0; i < 100 && !await evaluate('document.body.innerText.includes("合成曲目")'); i++) await sleep(100)
  assert.equal(await evaluate('document.body.innerText.includes("合成曲目")'), true, 'persistent synthetic detail is rendered through real IPC')
  for (let i = 0; i < 100 && !await evaluate('Array.from(document.images).some(img => img.src.startsWith("data:image/png;base64,") && img.naturalWidth === 1)'); i++) await sleep(100)
  assert.equal(await evaluate('Array.from(document.images).some(img => img.src.startsWith("data:image/png;base64,") && img.naturalWidth === 1)'), true, 'cached cover is decoded and rendered')
  const waitFor = async expression => {
    for (let i = 0; i < 100; i++) { if (await evaluate(expression)) return; await sleep(100) }
    throw new Error(`UI condition timeout: ${expression}`)
  }
  const click = label => evaluate(`Array.from(document.querySelectorAll('button')).find(b=>b.textContent.trim()===${JSON.stringify(label)}).click()`)
  const ids = () => evaluate('(await window.jj.playlists.items("fixture-refresh")).map(t=>t.id)')
  await evaluate('location.hash = "#/playlist/fixture-refresh"')
  await waitFor('!!document.querySelector("[aria-label=远程歌单刷新]")')
  await click('预览远程更改')
  await waitFor('document.body.innerText.includes("新增 1 首，移出 1 首")')
  const previewImage = await send('Page.captureScreenshot', { format: 'png' })
  await writeFile(join(output, 'playlist-diff-fixture.png'), Buffer.from(previewImage.data, 'base64'))
  assert.deepEqual(await ids(), ['wy_1', 'wy_2'], 'preview does not write the saved list')
  await click('应用更改')
  await waitFor('!!document.querySelector("[role=dialog]")')
  await click('取消')
  assert.deepEqual(await ids(), ['wy_1', 'wy_2'], 'cancelled confirmation does not write')
  await click('应用更改'); await waitFor('!!document.querySelector("[role=dialog]")'); await click('确认')
  await waitFor('document.body.innerText.includes("合成歌曲3") || document.body.innerText.includes("远程标题3")')
  assert.deepEqual(await ids(), ['wy_1', 'wy_3'], 'explicit confirmation applies server candidate')
  assert.equal(await evaluate('(await window.jj.playlists.items("fixture-refresh"))[0].name'), '保留的本地标题')
  const saved = await evaluate('(await window.jj.playlists.list()).find(p=>p.id==="fixture-refresh")')
  assert.equal(saved.name, '我的合成歌单'); assert.equal(saved.coverPath, savedCover)
  await writeFile(modeFile, 'partial')
  await click('预览远程更改'); await waitFor('document.body.innerText.includes("未完整获取远程歌单")')
  assert.equal(await evaluate('Array.from(document.querySelectorAll("button")).some(b=>b.textContent.trim()==="应用更改")'), false)
  assert.deepEqual(await ids(), ['wy_1', 'wy_3'])
  await writeFile(modeFile, 'normal')
  await click('预览远程更改'); await waitFor('document.body.innerText.includes("无需应用")')
  // A changed candidate lets the real confirmation path exercise the local CAS.
  await writeFile(modeFile, 'empty')
  await click('预览远程更改'); await waitFor('document.body.innerText.includes("远程歌单为空")')
  await evaluate('window.jj.playlists.rename("fixture-refresh","预览后的本地编辑")')
  await click('应用更改'); await waitFor('!!document.querySelector("[role=dialog]")'); await click('确认')
  await waitFor('document.body.innerText.includes("歌单已变更")')
  assert.deepEqual(await ids(), ['wy_1', 'wy_3'], 'local edit after preview rejects application')
  assert.equal(await evaluate('(await window.jj.playlists.list()).find(p=>p.id==="fixture-refresh").name'), '预览后的本地编辑')
  await writeFile(modeFile, 'empty')
  await click('预览远程更改'); await waitFor('document.body.innerText.includes("远程歌单为空")')
  assert.deepEqual(await ids(), ['wy_1', 'wy_3'], 'legal empty remote is only a preview')
  await click('应用更改'); await waitFor('!!document.querySelector("[role=dialog]")')
  assert.ok(await evaluate('document.querySelector("[role=dialog]").textContent.includes("全部 2 个条目")'))
  await click('确认'); await waitFor('(await window.jj.playlists.items("fixture-refresh")).length===0')
  assert.deepEqual(await ids(), [])
  assert.deepEqual((await evaluate('window.jj.settings.get()')).queueHistory, [], 'refresh does not create a playback queue')
  const playlistImage = await send('Page.captureScreenshot', { format: 'png' })
  await writeFile(join(output, 'playlist-refresh-fixture.png'), Buffer.from(playlistImage.data, 'base64'))
  const countFetches=async()=>(await readFile(join(profile,'playlist-fetches.log'),'utf8')).trim().split('\n').length
  const beforeCooling=await countFetches()
  await writeFile(modeFile,'broken')
  let cooling
  for(let i=0;i<5;i++)cooling=await evaluate('window.jj.playlistRefresh.preview("fixture-refresh")')
  assert.equal(cooling.status,'unavailable')
  assert.equal(cooling.sourceStatus.error.code,'cooling','repeated malformed snapshots cool only playlist capability')
  assert.equal(await countFetches()-beforeCooling,4,'manual refresh bypasses ordinary cooling only once in thirty seconds')
  assert.deepEqual(await ids(),[],'health rejection cannot alter the saved list')
  await writeFile(modeFile,'empty')
  // Exercise native source-update UI with generated text that always stays disabled.
  await evaluate('location.hash = "#/sources"')
  await waitFor('Array.from(document.querySelectorAll("button")).some(b=>b.textContent.trim()==="粘贴导入")')
  await click('粘贴导入')
  await evaluate(`(document.querySelector('textarea').value=${JSON.stringify(sourceScript('1'))},document.querySelector('textarea').dispatchEvent(new Event('input',{bubbles:true})),true)`)
  await click('导入')
  await waitFor('document.body.innerText.includes("OR6 合成停用源")')
  const imported = (await evaluate('window.jj.sources.list()'))[0]
  assert.equal(imported.enabled, false)
  await evaluate('(window.__sourceEvents = [], window.jj.sources.onChanged(event => window.__sourceEvents.push(event)), true)')
  await evaluate('document.querySelector("button[title=检查更新]").click()')
  await waitFor('Array.from(document.querySelectorAll("button")).some(b=>b.textContent.trim()==="确认更新")')
  assert.equal((await evaluate('window.jj.sources.list()'))[0].version, '1', 'checking cannot install or execute a candidate')
  await click('确认更新'); await waitFor('!!document.querySelector("[role=dialog]")'); await click('确认')
  await waitFor('document.body.innerText.includes("保持停用，未运行初始化；实际播放未验证")')
  let installed = (await evaluate('window.jj.sources.list()'))[0]
  assert.equal(installed.version, '2'); assert.equal(installed.enabled, false); assert.equal(installed.stableId, imported.stableId)
  await waitFor(`!!document.querySelector('button[title="回退到 v1"]')`)
  await evaluate(`document.querySelector('button[title="回退到 v1"]').click()`)
  await waitFor('!!document.querySelector("[role=dialog]")'); await click('确认')
  await waitFor('(await window.jj.sources.list())[0].version === "1"')
  installed = (await evaluate('window.jj.sources.list()'))[0]
  assert.equal(installed.enabled, false); assert.equal(installed.stableId, imported.stableId)
  assert.deepEqual(await evaluate('window.jj.sources.available()'), [], 'disabled fixture never supplies capabilities')
  const revisions = await evaluate('window.__sourceEvents.filter(e=>e?.kind==="runtime")')
  assert.equal(revisions.length, 2); assert.ok(revisions.every(e=>e.phase==='invalidated'))
  assert.ok(revisions[1].generation > revisions[0].generation)
  assert.equal((await readFile(join(profile, 'source-checks.log'), 'utf8')).trim(), 'check')
  const preserved = await evaluate('window.jj.music.enrich({id:"wy_123",name:"合成",singer:"合成",source:"wy",meta:{songmid:"123"},picUrl:"https://p1.music.126.net/fixture.png"})')
  assert.equal(preserved.lyric, '[00:02]合成刷新歌词'); assert.ok(preserved.picUrl.startsWith('data:image/png;base64,'))
  assert.equal((await readFile(join(profile, 'synthetic-fetches.log'), 'utf8')).trim(), 'lyric', 'source revision retains platform assets')
  const sourceImage = await send('Page.captureScreenshot', {format:'png'})
  await writeFile(join(output, 'source-update-fixture.png'), Buffer.from(sourceImage.data, 'base64'))
  await evaluate('location.hash = "#/settings/data"')
  for (let i = 0; i < 100 && !await evaluate('!!document.querySelector("[aria-label=本地在线诊断]")'); i++) await sleep(100)
  assert.equal(await evaluate('document.querySelector("[aria-label=本地在线诊断]").getAttribute("aria-checked")'), 'true')
  await evaluate('document.querySelector("[aria-label=本地在线诊断]").click()')
  for (let i = 0; i < 50 && await evaluate('(await window.jj.settings.get()).onlineDiagnostics'); i++) await sleep(50)
  assert.equal(await evaluate('(await window.jj.settings.get()).onlineDiagnostics'), false, 'diagnostic switch persists')
  await evaluate('document.querySelector("[aria-label=在线资料缓存]").click()')
  for (let i = 0; i < 50 && await evaluate('(await window.jj.settings.get()).onlineReliability'); i++) await sleep(50)
  assert.equal(await evaluate('(await window.jj.settings.get()).onlineReliability'), false, 'cache opt-out persists')
  assert.equal((await evaluate('window.jj.playlistRefresh.preview("fixture-refresh")')).status, 'ready', 'cache opt-out preserves explicit complete refresh')
  await evaluate('window.jj.data.clearOnlineCache()')
  await evaluate('window.jj.data.clearOnlineDiagnostics()')
  assert.equal(await readFile(sentinel, 'utf8'), 'user-owned-fixture', 'user resource survives cache clear')
  assert.deepEqual(await readFile(savedCover), png, 'saved cover copy survives automatic cache eviction')
  assert.deepEqual(JSON.parse(await readFile(join(profile, 'cache/online/v1/lyrics.json'), 'utf8')).entries, [])
  assert.deepEqual(JSON.parse(await readFile(join(profile, 'cache/online/v1/covers.json'), 'utf8')).entries, [])
  assert.deepEqual(JSON.parse(await readFile(join(profile, 'cache/online/v1/artistDetail.json'), 'utf8')).entries, [])
  assert.deepEqual(JSON.parse(await readFile(join(profile, 'cache/online/v1/diagnostics.json'), 'utf8')).events, [])
  const image = await send('Page.captureScreenshot', { format: 'png' })
  await writeFile(join(output, 'settings-fixture.png'), Buffer.from(image.data, 'base64'))
  assert.equal(errors.length, 0, `renderer errors: ${errors.join(';')}`)
  let blocked = ''
  try { blocked = await readFile(join(profile, 'blocked-fetches.log'), 'utf8') } catch (e) { if (e.code !== 'ENOENT') throw e }
  assert.equal(blocked, '', 'UI fixture requires no external requests')
  console.log('PASS: synthetic detail, lyric IPC, cached artwork, playlist diff/confirmation/cancel/partial/empty/local-edit safety, health cooling/manual throttle, disabled source check/update/rollback/revisions/verification feedback, saved metadata, switches, cache clear, user assets, console, screenshots, zero external fetches')
  console.log(`Fixture profile retained for inspection: ${profile}`)
} finally {
  socket?.close()
  for (const task of pending.values()) clearTimeout(task.timer)
  if (child.exitCode === null) child.kill()
}
