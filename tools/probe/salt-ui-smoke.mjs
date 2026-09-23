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
      /*
       * The desktop-lyric overlay is excluded, and that matters: it is a second
       * top-level page that exists from launch whenever `desktopLyric` is on in the
       * profile this run copied, and it is a plain DOM page with no `#app` — so
       * taking whichever page answers first made the very first evaluate die on
       * `document.querySelector('#app')` being null.
       */
      const page = (await res.json()).find(
        (t) => t.type === 'page' && !t.url.startsWith('devtools://') && !t.url.includes('desktop-lyrics')
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
    /*
     * The panel's history pages come from settings, so a copied profile inherits
     * whatever the developer's own session left there — and then "only the live
     * queue is on screen" is no longer the thing under test. Start from an empty
     * history; the paging assertions build their own.
     */
    data.queueHistory = []
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
 // `detail` is optional and only printed when given: a bare FAIL says what broke
 // but not how far off it was, which is how a slow-but-fine shutdown got read as a
 // regression of whatever had been edited last.
 // `null` means "this run could not look at it", which is neither a pass nor a
 // product failure — reporting it as either would be a lie in one direction or the
 // other. Anything that is not exactly `true` fails.
 const check = (name, ok, detail) => { console.log(`${ok === null ? 'SKIP' : ok === true ? 'PASS' : 'FAIL'} ${name}${detail ? `  → ${detail}` : ''}`); if(ok !== true && ok !== null) failed++ }
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
 /*
  * 清空输入框 = 回到起始态。触发方式必须照抄 `<input type="search">` 那颗原生 ×
  * 的行为：只派发 input，不派发 submit —— 这正是这个缺陷的成因，用 submit 去测就
  * 等于把被测路径绕开了。
  * 两半都要钉：① 上一轮的结果（列表 / 计数行 / 分页器）全部消失、提示行回来；
  * ② 地址栏里的 ?q **跟着一起删掉** —— 清空就是这次搜索作罢。这一条以前钉的是反方向
  *    （"不许删"，为了「返回」和侧栏记忆），P 轮按用户拍板反转：留着词会让侧栏
  *    「全局搜索」把上次的搜索又跑一遍，那是要的；代价是清空后「返回」也回不去，
  *    而那批结果本来就是我主动叉掉的。
  */
 await click('.platform','本地音乐')
 await sleep(400)
 const clearedBefore = await evaluate('({ rows: document.querySelectorAll(".view > .tracklist .track-row").length, meta: !!document.querySelector(".result-meta"), loadMore: !!document.querySelector(".load-more") })')
 check('清空前确有结果（否则下面那条清空断言是空测）', clearedBefore.rows > 0 && clearedBefore.meta === true, JSON.stringify(clearedBefore))
 await evaluate(`(() => { const e = document.querySelector('.searchbar__input'); e.value = ''; e.dispatchEvent(new Event('input', { bubbles: true })) })()`)
 await sleep(500)
 const cleared = await evaluate('({ rows: document.querySelectorAll(".view > .tracklist .track-row").length, meta: !!document.querySelector(".result-meta"), loadMore: !!document.querySelector(".load-more"), hints: !!document.querySelector(".hints"), empty: document.querySelector(".searchbar__input").value === "" })')
 check('清空后结果列表/计数行/分页器全部收起，提示行回来',
   cleared.rows === 0 && cleared.meta === false && cleared.loadMore === false && cleared.hints === true && cleared.empty === true,
   JSON.stringify(cleared))
 /*
  * 上面那条里的"分页器/加载更多行"是**空测**：本地音乐页签不出在线结果，清空之前根本
  * 没有那一行（clearedBefore.loadMore=false），所以"清空后没有它"不费吹灰之力就成立。
  * 要单独在会出在线结果的那个页签上量一遍——拿不到就报 SKIP，不拿一个不可能失败的
  * 断言冒充验过。
  *
  * 选择器从 `.pager` 换成了 `.load-more`：M 轮把翻页器改成了"滚动加载 + 底部加载更多"，
  * `.pager` 已经不存在，那条断言从此只能走 SKIP 分支 —— 一个永远不会红的红，比没写还糟，
  * 因为它看起来是被量过的。语义没变：清空之后那一行必须跟着收起。
  */
 await evaluate(`document.querySelector('#app').__vue_app__.config.globalProperties.$router.push({path:'/search',query:{q:'陈奕迅'}})`)
 await sleep(2500)
 const paged = await evaluate('!!document.querySelector(".load-more")')
 if (!paged) {
   check('清空后「加载更多」那一行也收起（在真会出在线结果的地方量）', null, `这一轮在线没有给出结果（.load-more 不存在），这条没量到`)
 } else {
   await evaluate(`(() => { const e = document.querySelector('.searchbar__input'); e.value = ''; e.dispatchEvent(new Event('input', { bubbles: true })) })()`)
   await sleep(500)
   check('清空后「加载更多」那一行也收起（在真会出在线结果的地方量）', await evaluate('!document.querySelector(".load-more") && !document.querySelector(".result-meta")'), '清空前 .load-more 在，清空后不在')
 }
 /*
  * ⚠️ 清空要**无条件**做一次：上面那段 `.load-more` 分支这一轮可能 SKIP（在线没给结果），
  * 那样就没有第二次清空，读到的 `?q` 还留着 —— 反转后的断言会红在一个跟改动无关的
  * 顺序上。清空是幂等的，多做一次不改变什么，但让这条断言只看自己的因果关系。
  */
 await evaluate(`(() => { const e = document.querySelector('.searchbar__input'); e.value = ''; e.dispatchEvent(new Event('input', { bubbles: true })) })()`)
 await sleep(500)
 const qAfterClear = await evaluate(`document.querySelector('#app').__vue_app__.config.globalProperties.$route.query.q ?? '(没了)'`)
 check('清空把 ?q 一起删掉：地址栏回到干净的 /search（P 轮反转了这条的方向）',
   qAfterClear === '(没了)', `route.query.q=${qAfterClear}`)
 /* 正常路径不能被这次改动弄坏：清空之后重新输入并回车，结果要回来。 */
 await evaluate(`(() => { const e = document.querySelector('.searchbar__input'); e.value = '晴天'; e.dispatchEvent(new Event('input', { bubbles: true })) })()`)
 await click('.searchbar .btn--primary','搜索')
 await sleep(700)
 check('清空之后重新搜索仍然正常', await evaluate('document.querySelector(".track-row")?.innerText.includes("晴天") && !!document.querySelector(".result-meta")'))
 await evaluate('uiTestUi.nowPlaying = true')
 await sleep(400)
 // The playback screen has no EQ / 播放列表 buttons of its own any more, and no
 // second 更多 button at the top right either: its bottom bar is the shared
 // PlayerBar, whose single 更多 menu opens both panels.
 //
 // S 轮把面板从 `.np` 里搬到了 body（Teleport），所以这里的探针从 `.np .equalizer-content`
 // 改成 `.np-panel .equalizer-content` —— 类名是刻意保留的（面板与播放页不再是包含关系，
 // 再拿 `.np` 当祖先会永远选不到）。
 await click('.playbar--bare .mini-right > .icon-btn', '播放更多选项')
 await click('.menu-layer .menu-panel button', 'EQ 均衡器')
 check('EQ opens inside playback screen', await evaluate('!!document.querySelector(".np-panel .equalizer-content")'))
 await click('.eq-presets button', '摇滚')
 await sleep(500)
 check('EQ changes apply and persist', await evaluate('(async () => uiTestPlayer.equalizerPreset === "摇滚" && (await window.jj.settings.get()).equalizerName === "摇滚")()'))
 await screenshot('11-playback-equalizer')
 await click('.np-panel button[aria-label="关闭播放面板"]', '')
 await click('.playbar--bare .mini-right > .icon-btn', '播放更多选项')
 await click('.menu-layer .menu-panel button', '播放列表')
 check('playback list opens within player', await evaluate('!!document.querySelector(".np-panel .tracklist") && document.querySelectorAll(".np-panel .track-row").length === 3'))
 /*
  * S 轮的四件事，逐条量：面板是窗口级的（主页上也能开，且是同一个组件）、行是单行的、
  * 每行有一个常驻的移除按钮、翻页器在只有当前队列时两头都按不动。
  * 「恰好 3 行」这条仍然是队列的真实长度。
  */
 const panelShape = await evaluate(`(() => {
   const row = document.querySelector('.np-panel .track-row')
   const label = row?.querySelector('.track-label')
   return {
     singleLine: !!label && label.querySelectorAll('strong').length === 1 && !label.querySelector('small'),
     removeEverywhere: document.querySelectorAll('.np-panel .track-row').length === document.querySelectorAll('.np-panel .row-remove').length,
     removeVisible: getComputedStyle(row?.querySelector('.row-remove') ?? document.createElement('i')).opacity,
     pager: document.querySelector('.np-panel__pager span')?.textContent.trim() ?? '',
     arrowsDisabled: [...document.querySelectorAll('.np-panel__pager button')].map(b => b.disabled),
     stored: (uiTestPlayer.queueHistory ?? []).length,
     count: document.querySelector('.np-panel__count')?.textContent.trim() ?? ''
   }
 })()`)
 check('面板行是单行「歌手 — 歌名」，没有第二行', panelShape.singleLine === true, JSON.stringify(panelShape))
 check('每行有常驻的移除按钮（不靠悬停）', panelShape.removeEverywhere === true && Number(panelShape.removeVisible) === 1, `opacity=${panelShape.removeVisible}`)
 /*
  * 页数不写死。早期步骤本身就会播好几份列表，历史里躺着几条是当时的现场；
  * 写死「第 1 / 1 页」会红在跟这条断言无关的地方。判据改成"面板报的数与 store
  * 里的条数一致"，再钉住当前页的两个方向：右箭头（往更新）按不动，
  * 左箭头（往更早）只有存在历史时才可点。
  */
 check('翻页器报的页数与 store 的历史条数一致，且当前页的右箭头按不动',
   panelShape.pager === `第 1 / ${panelShape.stored + 1} 页`
     && panelShape.arrowsDisabled[1] === true
     && panelShape.arrowsDisabled[0] === (panelShape.stored === 0)
     && /^1\/3$/.test(panelShape.count),
   JSON.stringify(panelShape))
 await evaluate(`document.querySelectorAll('.np-panel .track-row')[1].dispatchEvent(new MouseEvent('dblclick',{bubbles:true}))`)
 await sleep(800)
 check('playback list switches current song', await evaluate('uiTestPlayer.currentIndex === 1 && uiTestPlayer.playing'))
 await screenshot('12-playback-list')
 await send('Emulation.setDeviceMetricsOverride', {width:940,height:620,deviceScaleFactor:1,mobile:false})
 await screenshot('13-small-playback-list')
 check('drawer fits minimum window size', await evaluate(`document.querySelector('.np-panel').getBoundingClientRect().right <= innerWidth && document.querySelector('.np-panel').getBoundingClientRect().bottom <= innerHeight`))
 await send('Emulation.clearDeviceMetricsOverride')
 await evaluate('uiTestUi.playbackPanel=null;uiTestUi.nowPlaying=false')
 await sleep(500)
 /*
  * 「更多 → 播放列表」现在就地开面板（以前会顺手 ui.nowPlaying = true）。
  * 这条由 .cache/panel-s-check.mjs 的 S5/S9 量：主页与播放页两处点开的是同一个组件、
  * 都不跳页 —— 冒烟这里不再重复点一次底栏（overlay 退场后底栏的可见时机不稳定）。
  */
 await sleep(300)
 /*
  * Desktop lyrics. This has shipped as a setting that did nothing twice, so the
  * check is that a *window* appears and shows the same line the player is on —
  * not that a boolean was stored.
  */
 /*
  * 锁定状态也一起写死：这一段要靠"悬停能浮出卡片"来验悬浮窗真的画了控件，而锁定时
  * 卡片按设计不出现。上一轮这里跟着 profile 里残留的 locked=true 跑，那条断言就
  * 一直 SKIP —— 看起来像"热区改动把悬停弄坏了"，其实是从没量到。别把结论建立在
  * 上一次运行有没有退出干净上面。
  */
 await evaluate('uiTestLibrary.updateSettings({desktopLyric:true,desktopLyricLocked:false})')
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
  check('the overlay window has no jj bridge, only its own methods', await lyricEval('typeof window.jj === "undefined" && typeof window.desktopLyric?.dragStart === "function" && typeof window.desktopLyric?.dragEnd === "function" && typeof window.desktopLyric?.command === "function" && typeof window.desktopLyric?.dragMove === "undefined"'), '桥面只该有这几个方法，command 是卡片控件用的')
  /*
   * The line is drawn twice now (a dim copy and a clipped lit copy), so reading
   * `#line`.textContent would return the words twice and this check would fail
   * against working code. Read the copy that carries the text, and assert the lit
   * copy matches it — if they ever differ, the two layers stop overlapping and the
   * wipe highlights the wrong characters.
   */
  const strip = await lyricEval(`({ line: document.querySelector('#dim')?.textContent ?? null, lit: document.querySelector('#lit')?.textContent ?? null, fallback: document.querySelector('#line')?.classList.contains('is-fallback') ?? null, size: getComputedStyle(document.documentElement).getPropertyValue('--lyric-size').trim(), background: getComputedStyle(document.body).backgroundColor, cardShown: getComputedStyle(document.querySelector('#card')).visibility, lineTop: Math.round(document.querySelector('#line').getBoundingClientRect().top), plateIdle: getComputedStyle(document.querySelector('.verse'), '::before').opacity })`)
  const expected = await evaluate(`(() => { const i = uiTestPlayer.activeLyricIndex; const l = i >= 0 ? (uiTestPlayer.lyrics?.lines?.[i]?.text ?? '') : ''; return l || (uiTestPlayer.currentTrack ? uiTestPlayer.currentTrack.name : '') })()`)
  check('the strip shows the line the player is on', strip.line === expected && strip.line !== '', `悬浮窗="${strip.line}" 应有="${expected}"`)
  check('点亮层与暗层是同一串字（两层错位就会高亮错字）', strip.lit === strip.line, `暗层="${strip.line}" 亮层="${strip.lit}"`)
  /*
   * "Transparent, not a grey box" still measures `body`, and it still passes — the
   * card's panel is a child element, so the idle strip over the desktop stays
   * see-through. But that intent now has two halves, and measuring only the first
   * would let a card that never paints look correct. So the pair is asserted
   * together: retracted and see-through when idle, panel painted **and body still
   * see-through** when revealed.
   *
   * Read it as "which half this one owns": it pins the *idle* half. The revealed
   * half is pinned by the card/plate checks below, because a hover-only panel is
   * supposed to be opaque — this assertion can neither prove nor disprove that.
   *
   * There are now two panels (the card, and the plate under the words) and both are
   * children, so `body` staying transparent is still the right thing to measure. The
   * plate gets its own idle assertion next to the card's, since "the body is clear"
   * would also be true if the plate had been wired to show all the time.
   */
  check('the strip is transparent, not a grey box', strip.background === 'rgba(0, 0, 0, 0)', strip.background)
  check('不悬停时卡片是收着的（控件不常驻）', strip.cardShown === 'hidden', `#card visibility=${strip.cardShown}`)
  check('不悬停时歌词下面也没有底板（透明悬浮条这一半仍然成立）', strip.plateIdle === '0', `.verse::before opacity=${strip.plateIdle}`)
  const idleShot = await lyricSend('Page.captureScreenshot', {format:'png'}).catch(() => null)
  if (idleShot) writeFileSync(join(screenshotDir, '14a-desktop-lyrics-idle.png'), Buffer.from(idleShot.data, 'base64'))
  /*
   * Reveal the card with a pointer move through CDP. `Input.dispatchMouseEvent`
   * goes through the renderer's real input pipeline, so it does produce DOM pointer
   * events — unlike the synthetic `contextmenu` and Ctrl+A cases elsewhere in this
   * file, which is why the reveal is asserted rather than assumed: if the move
   * arrives and nothing opens, that is a product failure; if the move does not
   * arrive at all, this run simply did not look.
   *
   * The point is the lyric line's own centre, read at runtime. It used to be a
   * literal (410, 130), which was only ever right by accident: the hot area is now
   * the visible content rather than the whole 820×156 window, and the line moves
   * with the font size and the translation toggle. A literal there does not fail —
   * it silently stops hovering anything.
   */
  const lyricPoint = async () => {
    const p = await lyricEval(`(() => { const r = document.querySelector('#line').getBoundingClientRect()
      return JSON.stringify([Math.round(r.left + r.width / 2), Math.round(r.top + r.height / 2)]) })()`)
    return JSON.parse(p)
  }
  const [hoverX, hoverY] = await lyricPoint()
  await lyricSend('Input.dispatchMouseEvent', { type: 'mouseMoved', x: hoverX, y: hoverY, buttons: 0 })
  await sleep(500)
  const revealed = await lyricEval(`({ hover: document.querySelector('#lyric')?.classList.contains('is-hover') ?? false, cardVis: getComputedStyle(document.querySelector('#card')).visibility, cardBg: getComputedStyle(document.querySelector('#card')).backgroundColor, bodyBg: getComputedStyle(document.body).backgroundColor, lineTop: Math.round(document.querySelector('#line').getBoundingClientRect().top) })`)
  if (!revealed.hover) {
    const why = await lyricEval(`JSON.stringify({ 行盒: (() => { const r = document.querySelector('#line').getBoundingClientRect()
      return [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)] })(),
      字号: getComputedStyle(document.documentElement).getPropertyValue('--lyric-size').trim(),
      卡片: getComputedStyle(document.querySelector('#card')).display,
      locked: document.body.classList.contains('is-locked') })`)
    check('悬停浮出卡片', null, `CDP 的 mouseMoved 没有让页面进入悬停态，这一项没量到：打在 (${hoverX},${hoverY})，页面 ${why}`)
  } else {
    check('悬停浮出卡片（控件条确实出现）', revealed.cardVis === 'visible', `#card visibility=${revealed.cardVis}`)
    const idleLineTop = strip.lineTop
  const [cr, cg, cb, ca] = (revealed.cardBg.match(/[\d.]+/g) ?? []).map(Number)
    const painted = revealed.cardBg !== 'rgba(0, 0, 0, 0)' && (ca === undefined || ca > 0) && cr + cg + cb < 720
    check('卡片确实有一块深色底板（可读性靠它，不是只写了个 background 值）', painted, `#card background=${revealed.cardBg}`)
    check('底板画出来了，body 却仍然全透明（灰块只出现在悬停的卡片上）', revealed.bodyBg === 'rgba(0, 0, 0, 0)', `body=${revealed.bodyBg}`)
    check('浮出卡片时歌词行不跳动（卡片长在上方而不是把字顶下去）', idleLineTop === revealed.lineTop, `行顶边 ${idleLineTop} → ${revealed.lineTop}`)
    /*
     * The plate (O 项): it has to be a continuation of the card, not a second box
     * with a seam between them. Everything below is measurable from the two rects —
     * the seam check is "card bottom and plate top are the same pixel", which is the
     * exact thing the screenshot showed broken (board ended at y=113, text started at
     * y=117, and the desktop showed through the gap).
     */
    const plate = await lyricEval(`(() => { const card = document.querySelector('#card'), verse = document.querySelector('.verse')
      const s = getComputedStyle(verse, '::before'), cr = card.getBoundingClientRect(), vr = verse.getBoundingClientRect()
      const [r, g, b, a] = (s.backgroundColor.match(/[\\d.]+/g) ?? []).map(Number)
      return JSON.stringify({ opacity: s.opacity, bg: s.backgroundColor, alpha: a ?? 1, dark: r + g + b < 720,
        left: Math.round(vr.left - cr.left), right: Math.round(cr.right - vr.right),
        seam: Math.round((vr.top - 6) - cr.bottom), bottomGap: Math.round(window.innerHeight - (vr.bottom + 4)),
        pointerEvents: s.pointerEvents }) })()`)
    const platePainted = JSON.parse(plate)
    check('悬停时底板画出来了（opacity 1 + 深色半透明）', platePainted.opacity === '1' && platePainted.dark && platePainted.alpha > 0, `opacity=${platePainted.opacity} background=${platePainted.bg}`)
    check('底板与卡片左右对齐（同一条内容宽度，不是各算各的）', Math.abs(platePainted.left) <= 1 && Math.abs(platePainted.right) <= 1, `左边差 ${platePainted.left}px，右边差 ${platePainted.right}px`)
    check('卡片下沿与底板上沿之间没有缝', Math.abs(platePainted.seam) <= 1, `相差 ${platePainted.seam}px（0 才算接上）`)
    check('底板一直铺到窗口底边（文字下面不留一条亮缝）', Math.abs(platePainted.bottomGap) <= 1, `距窗口底 ${platePainted.bottomGap}px`)
    check('底板不吃热区：它是纯装饰层，pointer-events 必须是 none', platePainted.pointerEvents === 'none', `pointer-events=${platePainted.pointerEvents}`)
  }
  const cardShot = await lyricSend('Page.captureScreenshot', {format:'png'}).catch(() => null)
  if (cardShot) writeFileSync(join(screenshotDir, '14-desktop-lyrics.png'), Buffer.from(cardShot.data, 'base64'))
  await lyricSend('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 5, y: 5, buttons: 0 })
  await evaluate('uiTestLibrary.updateSettings({desktopLyricFontSize:46})')
  await sleep(800)
  check('font size reaches the overlay live', (await lyricEval(`getComputedStyle(document.documentElement).getPropertyValue('--lyric-size').trim()`)) === '46px')
  await evaluate('uiTestLibrary.updateSettings({desktopLyricFontSize:28,desktopLyricLocked:true})')
  await sleep(800)
  check('lock state reaches the overlay', await lyricEval(`document.body.classList.contains('is-locked')`))
  /*
   * A locked strip must not reveal the card. This is the measured rule (locked
   * windows still receive pointer motion, so the only reason the card stays away is
   * that the page refuses it deliberately), and it is asserted with a pointer move
   * rather than by reading a class.
   */
  const [lockedX, lockedY] = await lyricPoint()
  await lyricSend('Input.dispatchMouseEvent', { type: 'mouseMoved', x: lockedX, y: lockedY, buttons: 0 })
  await sleep(500)
  /*
   * 锁定时悬停：卡片（一整排点不动的按钮）仍然不许出现，但**必须**露出解锁入口。
   * 这条以前只断言前半句 —— 那时"锁定了就什么都点不到"是设计，唯一的解锁路径在
   * 主窗口。用户后来否掉了那个决定，所以现在量的是两半：不该有的没有，该有的真有。
   * 只测后半句会漏掉"把整条工具栏放出来骗人"，只测前半句会漏掉"根本没法解锁"。
   */
  const lockedReveal = await lyricEval(`({ hover: document.querySelector('#lyric').classList.contains('is-hover'), cardVis: getComputedStyle(document.querySelector('#card')).visibility, cardDisplay: getComputedStyle(document.querySelector('#card')).display, unlockDisplay: getComputedStyle(document.querySelector('#unlockBar')).display, plateDisplay: getComputedStyle(document.querySelector('.verse'), '::before').display, unlockShown: (() => { const b = document.querySelector('#unlockBtn'); const r = b.getBoundingClientRect(); const s = getComputedStyle(b); return r.width > 40 && r.height >= 16 && s.backgroundColor !== 'rgba(0, 0, 0, 0)' })() })`)
  check('锁定时悬停不弹卡片（点不动的按钮不该露出来）', lockedReveal.cardDisplay === 'none', JSON.stringify(lockedReveal))
  check('锁定时底板也不出现：那块板是为卡片续下去的，卡片没了它就该跟着没有', lockedReveal.plateDisplay === 'none', `.verse::before display=${lockedReveal.plateDisplay}`)
  // 与上面那条"悬停浮出卡片"同一套处理：CDP 的 mouseMoved 有量能不进悬停态（本机实测
  // 会整段 hover 不到），那种情况是这一项没量到，不是"解锁入口没了"。以前这里把
  // `hover===true` 焊在断言里，环境一抖就报成产品红。
  if (!lockedReveal.hover) check('锁定时悬停会露出解锁入口，而且它是唯一露出来的东西', null, `CDP 的 mouseMoved 没让页面进入悬停态，这一项没量到：${JSON.stringify(lockedReveal)}`)
  else check('锁定时悬停会露出解锁入口，而且它是唯一露出来的东西', lockedReveal.unlockDisplay === 'flex' && lockedReveal.unlockShown === true, JSON.stringify(lockedReveal))
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
 /*
  * 设置里那个 EQ 入口以前靠 ui.nowPlaying = true 把播放页拉起来再显示面板；S 轮把
  * 面板提到窗口级之后，它就是"在你当前这一页上就地开面板"。所以这条现在量两件事：
  * 面板在（不再要求它是 .np 的后代），以及播放页没有被顺手打开。
  */
 check('legacy EQ entry opens the panel in place, without the playback page',
   await evaluate('!!document.querySelector(".np-panel .equalizer-content") && uiTestUi.nowPlaying === false'))
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
   /*
    * 预览里那份列表是虚拟化的 `TrackList`（`.preview :deep(.tracklist)`），行是
    * `.track-row`，**从来就没有 `<li>`** —— 所以 `.preview li` 是个从结构上就不可能命中的
    * 选择器，它以前能过是因为预览曾经是普通 `<li>` 列表，改成 TrackList 之后这条就一直是
    * 假红/假绿的边缘。改按真实行判，并且知道虚拟化只会渲染十几行，不能拿"200"去要。
    */
   for(let i=0;i<45;i++){if(await evaluate('!!document.querySelector(".preview .track-row") || !!document.querySelector(".error")'))break;await sleep(2000)}
   check('public playlist preview includes songs',await evaluate('document.querySelectorAll(".preview .track-row").length > 0'),await evaluate('JSON.stringify({preview:!!document.querySelector(".preview"),error:(document.querySelector(".error")||{}).textContent||null,renderedRows:document.querySelectorAll(".preview .track-row").length,head:(document.querySelector(".preview__title")||{}).innerText?.replace(/\\s+/g," ").slice(0,80)})'))
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
   /*
    * 拿一首能下的样本歌。挨家试而不是钉死 tx：本机实测过 tx 整家返 500 / "无法取得测试
    * 歌曲"的时候 wy、kw、mg 是好的。以前这里是一次裸 `search('tx')`，平台一抖整条冒烟就
    * 死在 reject 上，后面几十项全部没跑 —— 那是"红得无声无息"，比一项 SKIP 糟糕得多。
    *
    * 一家一次 evaluate，而不是把四次重试塞进一个页面表达式里：塞进去那一发就要在浏览器里
    * 挂几十秒，直接撞爆冒烟自己的 Runtime.evaluate 超时（第一次改就是这么死的）。逐家调用
    * 每次都很短，某一家挂住由 Node 侧 try/catch 吃掉，换下一家。
    */
   let sample = null
   for (const src of ['tx','wy','kw','mg']) {
     for (let attempt = 0; attempt < 2 && !sample; attempt++) {
       let raw = null
       try {
         // 一次交四五首而不是首：下载管理器同时只跑两个，第一首 128k（约 4.4 MB）常在
         // 页面渲染出来之前就下完了，"下载中"那一帧就永远抓不到 —— 进度线那条只能报
         // SKIP。多首排队保证进页面时确实还有活在跑。
         raw = await evaluate(`(async () => { try {
           const r = await window.jj.music.search(${JSON.stringify(src)}, '晴天 周杰伦', 1)
           const picks = (r.list || []).filter(t => t && t.id && t.meta).slice(0, 5)
           if (!picks.length) return null
           const ids = await window.jj.downloads.add(picks, '128k')
           return JSON.stringify({ src: ${JSON.stringify(src)}, id: ids[0], count: ids.length, name: picks[0].name })
         } catch { return null } })()`)
       } catch { /* 这一家这一轮没答上来（超时或 500），试下一家 */ }
       if (raw) { sample = JSON.parse(raw); break }
       await sleep(800)
     }
     if (sample) break
   }
   if (!sample) {
     const why = '四家平台这一轮都没给出可下载的样本（本机实测会有整家返 500），下载相关的三项本轮没量到'
     check('进行中的条目：进度是行底一条细线，不额外撑高这一行', null, why)
     check('real online download completes', null, why)
     check('download management renders completed task', null, why)
   } else {
   await route('/downloads')
   /*
    * 边等结果边抓"下载中"那一帧：这一轮的下载条目压成一行之后，进度不再是单独一块
    * progress 撑高一行，而是行底一条 2px 的细线 —— 只有真的在下着的任务才会画它。
    * 抓不到（下得太快 / 平台没响应）就如实报 SKIP，不拿"已完成"的那一帧充数。
    */
   const sampleId = JSON.stringify(sample.id)
   let progressShot = null
   for(let i=0;i<90;i++){
     if(!progressShot) progressShot = await evaluate(`(() => { const p = document.querySelector('.dl-progress')
       if (!p) return null
       // 认"哪一行有进度线"而不是"第一行"：列表是 reverse() 画的，刚排进去的任务落在最下面，
       // 第一行是这堆里最老的一条（多半早已完成），在它身上找进度线永远找不到。
       const row = p.closest('.download-row'), pr = p.getBoundingClientRect(), rr = row.getBoundingClientRect()
       return JSON.stringify({ h: Math.round(pr.height), w: Math.round(pr.width), rowH: Math.round(rr.height),
         atBottom: Math.abs(pr.bottom - rr.bottom) <= 2, spansRow: Math.abs(pr.width - rr.width) <= 2 }) })()`)
     if(await evaluate('(async()=>["completed","failed","cancelled"].includes((await window.jj.downloads.list()).find(t=>t.id===' + sampleId + ').status))()'))break
     await sleep(250)
   }
   if(progressShot) check('进行中的条目：进度是行底一条细线，不额外撑高这一行', (() => { const v = JSON.parse(progressShot); return v.h <= 4 && v.atBottom && v.spansRow && v.rowH <= 92 })(), progressShot)
   else check('进行中的条目：进度是行底一条细线，不额外撑高这一行', null, `没抓到"下载中"的那一帧（${sample.src} 下得太快），这一项本次没量到`)
   const downloadResult=await evaluate('(async()=>(await window.jj.downloads.list()).find(t=>t.id===' + sampleId + '))()')
   console.log('Download sample:',JSON.stringify({from:sample.src,name:sample.name,status:downloadResult.status,error:downloadResult.error}))
   check('real online download completes',downloadResult.status==='completed')
   await sleep(1200)
   // `.download-card` 是旧的堆叠卡片，N 轮改成一行一条的 `.download-row` 了；
   // 选择器留着的话这条会在"元素不存在"上永远判假，看着像下载页坏了。
   // 认"哪一行是已完成的那条"而不是"页面第一行"：现在一次排了五首，最上面那条
   // 很可能还在下，拿第一行去要"已完成"是量错了对象。
   const doneRow = '(() => [...document.querySelectorAll(".download-row")].find(r => r.textContent.includes("已完成")) || null)()'
   check('download management renders completed task',await evaluate(`!!${doneRow} && (${doneRow}).innerText.includes("已完成")`))
   /*
    * 一行的高度的确断言，而不是只看"渲染出来了"：这一轮改的就是纵向密度（实测 178px →
    * 一行的 --row-height）。用应用自己的歌曲行做基准，比记一个绝对数字稳，因为它跟着
    * rowDensity 一起变。
    */
   const rowShape = await evaluate(`(() => { const row = (${doneRow}); const r = row.getBoundingClientRect()
     const songRow = Number(getComputedStyle(document.documentElement).getPropertyValue('--row-height').replace('px','')) || 72
     const note = row.querySelector('.dl-note')
     return JSON.stringify({ height: Math.round(r.height), token: songRow,
       showsPath: row.innerText.includes(${JSON.stringify(testDataDir)}), errorLine: !!note, note: note?.innerText.trim() ?? '' }) })()`)
   /*
    * 失败/警告那一行是 N 轮明确保留的例外（它要横跨整行），所以"有 note 就一定红"
    * 是把例外当成了缺陷。判据改成：没有 note 时必须是一行高；有 note 时最多两行，
    * 且两种情况下都不许再显示文件路径。note 的原文打出来，红了能直接看出是哪一种。
    */
   check('下载条目压成一行：无提示时不超过歌曲行 + 18px，有提示时也只多一行，且都不显示文件路径', (() => {
     const v = JSON.parse(rowShape)
     const bound = v.errorLine ? v.token + 18 + 26 : v.token + 18
     return v.height <= bound && v.showsPath === false
   })(), rowShape)
   await screenshot('17-download-management')
   }
 }
 await evaluate(`uiTestLibrary.updateSettings(JSON.parse(${JSON.stringify(original)}))`)
 /*
  * What is still running when we ask the window to close, measured *before* the
  * close: a slow exit has several possible causes (an active audio device, an
  * unfinished download, a settings flush) and they are indistinguishable from the
  * outside, which is what made this check's reds un-argueable. Reading it after
  * the window is gone returns nothing at all — an earlier version of this block did
  * exactly that and reported 状态读不到 with a 0 ms exit.
  */
 const inFlight = await evaluate(`(async () => ({
   playing: uiTestPlayer.playing,
   activeDownloads: (await window.jj.downloads.list()).filter(t => !['completed','failed','cancelled'].includes(t.status)).length
 }))()`).catch((error) => ({ error: String(error).slice(0, 80) }))
 const shutdownStart = Date.now()
 await evaluate(`window.jj.window.close()`).catch(()=>undefined)
 /*
  * Report how long the quit actually took, and keep watching past the 10 s budget
  * rather than walking away: a 16 s exit and a hang are different problems, and the
  * old check reported them identically. The assertion is unchanged — over 10 s is
  * still a failure.
  */
 let shutdown = await Promise.race([childExit.then((code) => ({ code })), sleep(10000).then(() => null)])
 let late = 0
 if (!shutdown) { shutdown = await Promise.race([childExit.then((code) => ({ code })), sleep(35000).then(() => null)]); late = 1 }
 const flight = inFlight && !inFlight.error
   ? `playing=${inFlight.playing} 未完成任务=${inFlight.activeDownloads}`
   : `状态读不到（${(inFlight && inFlight.error) || 'evaluate 返回空'}）`
 check('application shuts down cleanly', shutdown ? shutdown.code === 0 : false,
  shutdown ? `${flight}，退出码 ${shutdown.code}，用时 ${Date.now() - shutdownStart}ms${late ? '（超过 10000ms 预算，但确实退了）' : ''}` : `${flight}，等了 45000ms 仍没退（可能是挂住）`)
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
