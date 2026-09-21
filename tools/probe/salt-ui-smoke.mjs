/**
 * Determine whether the dev-only E2E hook is actually reachable at runtime.
 *
 * A naive text search for `__jj_player` is not sufficient: Vite compiles
 * `import.meta.env['VITE_E2E'] === '1'` into a property access on an inlined
 * env object, so the identifier appears in the bundle even when the guard is
 * permanently false. What matters is whether the assignment can execute.
 *
 * This launches the built app and asks the renderer directly.
 *
 * Usage: node tools/probe/probe-hook.mjs
 */
import { spawn } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const { createServer } = await import('node:net')
const DEBUG_PORT = await new Promise((resolve, reject) => {
  const server = createServer()
  server.on('error', reject)
  server.listen(0, '127.0.0.1', () => { const port = server.address().port; server.close(() => resolve(port)) })
})
const packagedApp=process.argv.find(arg=>arg.startsWith('--app='))?.slice(6)
const electronBin = packagedApp || join(
  repoRoot,
  'node_modules',
  'electron',
  'dist',
  process.platform === 'win32' ? 'electron.exe' : 'electron'
)

if (!existsSync(electronBin)) {
  console.error('electron binary not found')
  process.exit(1)
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function waitForTarget(timeoutMs = 40_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`)
      const page = (await res.json()).find(
        (t) => t.type === 'page' && !t.url.startsWith('devtools://')
      )
      if (page?.webSocketDebuggerUrl) return page
    } catch {
      /* retry */
    }
    await sleep(400)
  }
  throw new Error('renderer target never appeared')
}

function connect(url) {
  return new Promise((resolvePromise, reject) => {
    const socket = new WebSocket(url)
    let nextId = 1
    const pending = new Map()
    socket.addEventListener('message', (event) => {
      const message = JSON.parse(event.data)
      const entry = pending.get(message.id)
      if (!entry) return
      pending.delete(message.id)
      if (message.error) entry.reject(new Error(message.error.message))
      else entry.resolve(message.result)
    })
    socket.addEventListener('error', () => reject(new Error('socket error')))
    socket.addEventListener('open', () =>
      resolvePromise((method, params = {}) => {
        const id = nextId++
        return new Promise((res, rej) => {
          pending.set(id, { resolve: res, reject: rej })
          socket.send(JSON.stringify({ id, method, params }))
          setTimeout(() => {
            if (pending.delete(id)) rej(new Error(`timeout: ${method}`))
          }, 20_000)
        })
      })
    )
  })
}

// A separate profile also keeps the smoke test from changing a running user's settings.
mkdirSync(join(repoRoot, '.cache'), { recursive: true })
const testDataDir = mkdtempSync(join(repoRoot, '.cache', 'ui-profile-'))
const originalDataDir = join(process.env.APPDATA, 'jj-music')
for (const name of ['settings.json', 'playlists.json', 'library', 'sources']) {
  const source = join(originalDataDir, name)
  if (existsSync(source)) cpSync(source, join(testDataDir, name), { recursive: true })
}
// Cached cover paths in the copied JSON must refer to the isolated profile too.
for (const name of ['settings.json', 'playlists.json', 'library/index.json']) {
  const file = join(testDataDir, name)
  if (!existsSync(file)) continue
  const data = JSON.parse(readFileSync(file, 'utf8'), (_key, value) =>
    typeof value === 'string' && value.startsWith(originalDataDir + '\\')
      ? testDataDir + value.slice(originalDataDir.length) : value)
  writeFileSync(file, JSON.stringify(data))
}
// The download directory is set here, in the copied profile, rather than through
// the running app: `downloadFolder` is no longer writable over IPC (it decides
// where the app writes files), and the only channel that sets it opens a modal
// picker this probe cannot drive.
{
  const file = join(testDataDir, 'settings.json')
  if (existsSync(file)) {
    const data = JSON.parse(readFileSync(file, 'utf8'))
    data.downloadFolder = join(testDataDir, 'downloaded')
    writeFileSync(file, JSON.stringify(data))
  }
}
const child = spawn(electronBin, [...(packagedApp?[]:['.']),`--user-data-dir=${testDataDir}`], { cwd: repoRoot, stdio: 'inherit', windowsHide: true, env: { ...process.env, JJ_DEBUG_PORT: String(DEBUG_PORT), JJ_TEST_USER_DATA: testDataDir, ELECTRON_RUN_AS_NODE: undefined } })
const childExit=new Promise(resolve=>child.once('exit',code=>resolve(code)))
const screenshotDir = join(repoRoot, 'docs', 'research', 'screenshots', 'salt-ui')
mkdirSync(screenshotDir, { recursive: true })
let send, original, failed = 0
try {
 const target = await waitForTarget()
 send = await connect(target.webSocketDebuggerUrl)
 const evaluate = async expression => { const response = await send('Runtime.evaluate', {expression, returnByValue:true, awaitPromise:true}); if(response.exceptionDetails) throw Error(response.exceptionDetails.text + ': ' + response.result?.description); return response.result.value }
 await sleep(2500)
 await evaluate(`window.uiTestStores = document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s; window.uiTestLibrary = uiTestStores.get('library'); window.uiTestPlayer = uiTestStores.get('player'); window.uiTestUi = uiTestStores.get('ui')`)
 original = await evaluate('JSON.stringify(uiTestLibrary.settings)')
 const check = (name, ok) => { console.log(`${ok ? 'PASS' : 'FAIL'} ${name}`); if(!ok) failed++ }
 check('production test hooks are inaccessible',await evaluate('typeof window.__jj_player === "undefined"'))
 check('UI version matches release manifest',await evaluate('document.querySelector(".brand small").textContent')===JSON.parse(readFileSync(join(repoRoot,'package.json'),'utf8')).version)
 const screenshot = async name => { await sleep(350); const shot = await send('Page.captureScreenshot', {format:'png'}); writeFileSync(join(screenshotDir, name + '.png'), Buffer.from(shot.data, 'base64')) }
 const route = async path => { await evaluate(`location.hash = ${JSON.stringify('#' + path)}`); await sleep(550) }
 // Icon-only buttons carry their label in aria-label/title and have no text node,
 // so matching on textContent alone silently stops finding them. All three are
 // searched; existing call sites are unaffected.
 const click = async (selector,text) => evaluate(`(() => { const e=[...document.querySelectorAll(${JSON.stringify(selector)})].find(e=>((e.textContent||'')+' '+(e.getAttribute('aria-label')||'')+' '+(e.getAttribute('title')||'')).includes(${JSON.stringify(text)})); if(!e) throw Error('Missing ${text}'); e.click(); return true })()`)
 check('default landing remains discovery', await evaluate('document.querySelector("h1").textContent === "发现音乐"'))
 await evaluate(`uiTestLibrary.updateSettings({theme:'dark'})`)
 await route('/library')
 // /music-library and /sources left the rail for the Settings page, so they are
 // no longer expected to carry a count here.
 check('classification and playlist counts are visible', await evaluate(`['/library','/genres','/albums','/artists','/playlist/default','/playlist/favorites'].every(path => /^\\d+$/.test(document.querySelector('.sidebar a[href="#'+path+'"] small')?.textContent || ''))`))
 check('virtualized library rows', await evaluate('uiTestLibrary.tracks.length > 0 && document.querySelectorAll(".track-row").length < 35'))
 for (const path of ['/genres','/folders','/music-library','/albums','/artists','/playlist/favorites','/search','/recent','/settings','/settings/appearance/lyrics']) {
   await route(path); check(`route ${path}`, await evaluate('!!document.querySelector(".view")'))
 }
 await evaluate('uiTestPlayer.playQueue(uiTestLibrary.tracks.slice(0,3),0)')
 await sleep(1000)
 check('real audio advances', await evaluate('uiTestPlayer.playing && uiTestPlayer.currentTime > 0'))
 check('history records successful playback', await evaluate('uiTestLibrary.recentPlayed[0].id === uiTestPlayer.currentTrack.id'))
 check('history persists through IPC', await evaluate('(async () => (await window.jj.settings.get()).recentPlayed[0].id === uiTestPlayer.currentTrack.id)()'))
 await route('/discover')
 // The contract here is "the discover page must not duplicate the 最近播放 page".
 // It used to be asserted as "no recent-played markup at all", which was written
 // when the list was moved out to fill the whole landing page with nothing but
 // four status cards. A compact cover rail that links to the dedicated page is
 // not a duplicate, so the check now targets the actual thing: no history
 // TrackList rows on landing, and the rail hands off to /recent.
 check('discovery carries a recent rail, not the history list', await evaluate(`(() => {
   const rail = document.querySelector('.recent')
   return !!rail &&
     rail.querySelectorAll('.recent__item').length > 0 &&
     rail.querySelectorAll('.track-row').length === 0 &&
     !document.querySelector('.view > .tracklist, .view > .track-row') &&
     !![...document.querySelectorAll('.recent__more')].find(b => b.textContent.includes('查看全部'))
 })()`))
 await route('/recent')
 check('recent playback has its own rail entry and list', await evaluate('document.querySelector(".sidebar")?.innerText.includes("最近播放") && !!document.querySelector(".recent-view .track-row")'))
 check('recent page shows history, not newly added files', await evaluate('!document.body.innerText.includes("最近添加")'))
 await screenshot('09-recent-playback')
 const query = await evaluate('uiTestPlayer.currentTrack.name')
 await route('/search')
 // Tabs must be the adapters the main process reports. They were a hand-copied
 // literal and silently lost 咪咕 when its adapter landed, which no other check
 // could see -- the adapter worked, the tab simply was not there.
 const searchTabs = await evaluate(`(() => {
   const tabs = [...document.querySelectorAll('.platforms .platform')].map((e) => e.textContent.trim())
   return window.jj.music.providers().then((providers) => JSON.stringify({
     tabs,
     providerCount: providers.length,
     missing: providers.filter((p) => !tabs.includes(p.name)).map((p) => p.id + ':' + p.name)
   }))
 })()`)
 {
   const parsedTabs = JSON.parse(searchTabs)
   // The count and the non-empty checks are what keep this from passing when
   // `providers()` answers nothing, and they are also what would have caught the
   // old literal: 6 tabs against 5 adapters plus 2 scopes.
   check('search tabs cover every host search adapter',
     parsedTabs.providerCount > 0 && parsedTabs.missing.length === 0 &&
       parsedTabs.tabs.length === parsedTabs.providerCount + 2,
     searchTabs)
 }
 await evaluate(`(() => {const e=document.querySelector('.searchbar__input');e.value=${JSON.stringify(query)};e.dispatchEvent(new Event('input',{bubbles:true}));document.querySelector('.searchbar').dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}))})()`)
 await sleep(300)
 check('global search renders local matches before network completes', await evaluate('document.querySelector(".track-row")?.innerText.includes("本地")'))
 await screenshot('10-global-search')
 await click('.platform', '本地音乐')
 await sleep(300)
 check('local-only search works without waiting on platforms', await evaluate('!document.querySelector(".search-pending") && !!document.querySelector(".track-row")'))
 await evaluate(`document.querySelector('#app').__vue_app__.config.globalProperties.$router.push({path:'/search',query:{q:'陈奕迅'}})`)
 await sleep(300)
 check('search query updates on same-route navigation',await evaluate('document.querySelector(".searchbar input").value === "陈奕迅" && document.querySelector(".track-row")?.innerText.includes("陈奕迅")'))
 await evaluate('uiTestUi.nowPlaying = true')
 await sleep(400)
 // The playback screen has no EQ / 播放列表 buttons of its own any more, and no
 // second 更多 button at the top right either: its bottom bar is the shared
 // PlayerBar, whose single 更多 menu opens both panels.
 await click('.playbar--bare .mini-right > .icon-btn', '播放更多选项')
 await click('.menu-layer .menu-panel button', 'EQ 均衡器')
 check('EQ opens inside playback screen', await evaluate('!!document.querySelector(".np .equalizer-content")'))
 await click('.eq-presets button', '摇滚')
 await sleep(500)
 check('EQ changes apply and persist', await evaluate('(async () => uiTestPlayer.equalizerPreset === "摇滚" && (await window.jj.settings.get()).equalizerName === "摇滚")()'))
 await screenshot('11-playback-equalizer')
 await click('.np-panel button[aria-label="关闭播放面板"]', '')
 await click('.playbar--bare .mini-right > .icon-btn', '播放更多选项')
 await click('.menu-layer .menu-panel button', '播放列表')
 check('playback list opens within player', await evaluate('!!document.querySelector(".np-panel .tracklist") && document.querySelectorAll(".np-panel .track-row").length === 3'))
 await evaluate(`document.querySelectorAll('.np-panel .track-row')[1].dispatchEvent(new MouseEvent('dblclick',{bubbles:true}))`)
 await sleep(800)
 check('playback list switches current song', await evaluate('uiTestPlayer.currentIndex === 1 && uiTestPlayer.playing'))
 await screenshot('12-playback-list')
 await send('Emulation.setDeviceMetricsOverride', {width:940,height:620,deviceScaleFactor:1,mobile:false})
 await screenshot('13-small-playback-list')
 check('drawer fits minimum window size', await evaluate(`document.querySelector('.np-panel').getBoundingClientRect().right <= innerWidth && document.querySelector('.np-panel').getBoundingClientRect().bottom <= innerHeight`))
 await send('Emulation.clearDeviceMetricsOverride')
 await evaluate('uiTestUi.playbackPanel=null;uiTestUi.nowPlaying=false')
 /*
  * Desktop lyrics. This has shipped as a setting that did nothing twice, so the
  * check is that a *window* appears and shows the same line the player is on —
  * not that a boolean was stored.
  */
 await evaluate('uiTestLibrary.updateSettings({desktopLyric:true})')
 let lyricTarget = null
 for (let attempt = 0; attempt < 40 && !lyricTarget; attempt += 1) {
  await sleep(300)
  const pages = (await (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`)).json()).filter(t => t.type === 'page')
  lyricTarget = pages.find(t => t.url.includes('desktop-lyrics'))
 }
 check('desktop lyric setting opens a second window', !!lyricTarget, lyricTarget ? lyricTarget.url.split('/').pop() : 'never appeared')
 if (lyricTarget) {
  const lyricSend = await connect(lyricTarget.webSocketDebuggerUrl)
  await lyricSend('Runtime.enable')
  await lyricSend('Page.enable')
  const lyricEval = async expression => {
   const response = await lyricSend('Runtime.evaluate', {expression, returnByValue:true, awaitPromise:true})
   if (response.exceptionDetails) throw Error(response.exceptionDetails.text + ': ' + response.result?.description)
   return response.result.value
  }
  await sleep(1500)
  check('the overlay window has no jj bridge, only its own methods', await lyricEval('typeof window.jj === "undefined" && typeof window.desktopLyric?.dragStart === "function" && typeof window.desktopLyric?.dragEnd === "function" && typeof window.desktopLyric?.dragMove === "undefined"'))
  const strip = await lyricEval(`({ line: document.querySelector('#line')?.textContent ?? null, fallback: document.querySelector('#line')?.classList.contains('is-fallback') ?? null, size: getComputedStyle(document.documentElement).getPropertyValue('--lyric-size').trim(), background: getComputedStyle(document.body).backgroundColor })`)
  const expected = await evaluate(`(() => { const i = uiTestPlayer.activeLyricIndex; const l = i >= 0 ? (uiTestPlayer.lyrics?.lines?.[i]?.text ?? '') : ''; return l || (uiTestPlayer.currentTrack ? uiTestPlayer.currentTrack.name : '') })()`)
  check('the strip shows the line the player is on', strip.line === expected && strip.line !== '', `悬浮窗="${strip.line}" 应有="${expected}"`)
  check('the strip is transparent, not a grey box', strip.background === 'rgba(0, 0, 0, 0)', strip.background)
  await evaluate('uiTestLibrary.updateSettings({desktopLyricFontSize:46})')
  await sleep(800)
  check('font size reaches the overlay live', (await lyricEval(`getComputedStyle(document.documentElement).getPropertyValue('--lyric-size').trim()`)) === '46px')
  await evaluate('uiTestLibrary.updateSettings({desktopLyricFontSize:28,desktopLyricLocked:true})')
  await sleep(800)
  check('lock state reaches the overlay', await lyricEval(`document.body.classList.contains('is-locked')`))
  const shot = await lyricSend('Page.captureScreenshot', {format:'png'}).catch(() => null)
  if (shot) writeFileSync(join(screenshotDir, '14-desktop-lyrics.png'), Buffer.from(shot.data, 'base64'))
  await evaluate('uiTestLibrary.updateSettings({desktopLyricLocked:false,desktopLyric:false})')
  let closed = false
  for (let attempt = 0; attempt < 25 && !closed; attempt += 1) {
   await sleep(300)
   closed = !(await (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`)).json()).some(t => t.type === 'page' && t.url.includes('desktop-lyrics'))
  }
  check('turning the setting off destroys the overlay window', closed)
  lyricSend.close?.()
 }
 await route('/settings/audio/equalizer')
 await sleep(400)
 check('legacy EQ entry opens playback EQ', await evaluate('!!document.querySelector(".np .equalizer-content")'))
 await evaluate('uiTestPlayer.stop();uiTestUi.nowPlaying=false')
 await evaluate('uiTestLibrary.updateSettings({recentPlayed:uiTestLibrary.recentPlayed})')
 check('reactive list settings save through IPC', await evaluate('(async () => JSON.stringify((await window.jj.settings.get()).recentPlayed) === JSON.stringify(uiTestLibrary.recentPlayed))()'))
 // This check used to ride on `libraryFolders`, which was incidental — that field
 // is now the file-access allow-list and the settings channel drops it, so the
 // round-trip is proven with a list the renderer does own, and the allow-list is
 // asserted not to move below.
 const folderWrite = await evaluate(`(async () => {
   const before = await window.jj.library.folders()
   await window.jj.settings.update({ libraryFolders: [] })
   const after = await window.jj.library.folders()
   return { same: JSON.stringify(before) === JSON.stringify(after), count: after.length }
 })()`)
 check('设置通道改不动曲库白名单', folderWrite.same === true && folderWrite.count > 0, JSON.stringify(folderWrite))
 await evaluate('(async()=>{ const writes=[];for(let i=0;i<30;i++)writes.push(uiTestLibrary.updateSettings({volume:i/100}));await Promise.all(writes)})()')
 check('settings burst retains last input and live player state', await evaluate('(async () => Math.abs(uiTestPlayer.volume-.29)<.001 && (await window.jj.settings.get()).volume===.29)()'))
 await route('/playlists')
 check('built-in favorites has no delete button', await evaluate(`![...document.querySelectorAll('.plcard')].find(e=>e.textContent.includes('我喜欢的'))?.querySelector('.plcard__remove')`))
 await route('/sources')
 check('each declared platform has a status badge', await evaluate('document.querySelectorAll(".platform-status").length === uiTestLibrary.sources.length && uiTestLibrary.sources.length > 0'))
 for(let attempt=0;attempt<30;attempt++) {
   if(await evaluate('Object.values(uiTestLibrary.platformHealth).every(result=>result.status!=="checking")')) break
   await sleep(2000)
 }
 check('automatic platform verification settles', await evaluate('Object.values(uiTestLibrary.platformHealth).every(result=>result.status!=="checking")'))
 console.log('Platform verification:', await evaluate('JSON.stringify(Object.fromEntries(Object.entries(uiTestLibrary.platformHealth).map(([id,result])=>[id,{status:result.status,message:result.message}])) )'))
 await evaluate(`document.querySelector('.platforms')?.scrollIntoView({block:'start'})`)
 await screenshot('14-platform-verification')
 await click('.platform-section-head button','重新验证')
 check('manual retry starts new verification',await evaluate('Object.values(uiTestLibrary.platformHealth).some(result=>result.status==="checking")'))
 if(process.argv.includes('--downloads')) {
   await route('/settings/downloads')
   check('download settings expose lyrics translation romanization and cover',await evaluate('document.querySelectorAll(".settings-items [role=switch]").length === 5 && document.body.innerText.includes("下载目录")'))
   await screenshot('15-download-settings')
   await route('/playlist-import')
   await evaluate(`const input=document.querySelector('.import-form input');input.value='3778678';input.dispatchEvent(new Event('input',{bubbles:true}));document.querySelector('.import-form').dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}))`)
   for(let i=0;i<45;i++){if(await evaluate('!!document.querySelector(".preview") || !!document.querySelector(".error")'))break;await sleep(2000)}
   check('public playlist preview includes songs',await evaluate('document.querySelectorAll(".preview li").length > 0'))
   await screenshot('16-playlist-import')
   await click('.preview button','导入为新歌单')
   await sleep(1200)
   check('playlist import persists into sidebar and detail',await evaluate('location.hash.startsWith("#/playlist/") && uiTestLibrary.playlists.some(p=>p.name==="热歌榜"&&p.trackCount===200)'))
   await evaluate(`document.querySelector('.track-row').dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,clientX:450,clientY:220}))`)
   check('online context menu exposes quality downloads',await evaluate('uiTestUi.menu.items.some(item=>item.label==="下载歌曲" && item.children.some(child=>child.label.includes("128k")))'))
   await evaluate('uiTestUi.menu=null')
   // Asserted rather than set: the folder comes from the copied profile above, and
   // if this silently fell back to the real Downloads directory the probe would
   // scatter sample files into the user's own folders while still passing.
   check('download sample uses the isolated profile folder', await evaluate(`(async () => (await window.jj.downloads.folder()).startsWith(${JSON.stringify(testDataDir)}))()`))
   await evaluate(`(async()=>{window.downloadSample=(await window.jj.music.search('tx','晴天 周杰伦',1)).list[0];window.downloadTestId=(await window.jj.downloads.add([downloadSample],'128k'))[0]})()`)
   await route('/downloads')
   for(let i=0;i<90;i++){if(await evaluate('(async()=>["completed","failed","cancelled"].includes((await window.jj.downloads.list()).find(t=>t.id===downloadTestId).status))()'))break;await sleep(1000)}
   const downloadResult=await evaluate('(async()=>(await window.jj.downloads.list()).find(t=>t.id===downloadTestId))()')
   console.log('Download sample:',JSON.stringify(downloadResult))
   check('real online download completes',downloadResult.status==='completed')
   await sleep(1200)
   check('download management renders completed task',await evaluate('document.querySelector(".download-card")?.innerText.includes("已完成")'))
   await screenshot('17-download-management')
 }
 await evaluate(`uiTestLibrary.updateSettings(JSON.parse(${JSON.stringify(original)}))`)
 await evaluate('window.jj.window.close()').catch(()=>undefined)
 check('application shuts down cleanly',await Promise.race([childExit,sleep(10000).then(()=> 'timeout')])===0)
 console.log(`UI smoke failures: ${failed}; screenshots: ${screenshotDir}`)
} catch(error) { console.error(error); failed++; }
finally {
 if(send && original) { try { await send('Runtime.evaluate', {expression:`uiTestLibrary.updateSettings(JSON.parse(${JSON.stringify(original)}))`,awaitPromise:true}); } catch {} }
 child.kill(); await sleep(500)
 // The copied profile holds a full copy of `library/` — covers included, so
 // ~950 MB per run. Deleting it keeps a week of smoke runs from eating the disk.
 if (process.argv.includes('--keep-profile')) console.log(`保留隔离 profile: ${testDataDir}`)
 else { try { rmSync(testDataDir, { recursive: true, force: true, maxRetries: 20, retryDelay: 300 }) } catch (error) { console.log(`清理 profile 失败（${error.code ?? error.message}）: ${testDataDir}`) } }
}
process.exit(failed ? 1 : 0)
