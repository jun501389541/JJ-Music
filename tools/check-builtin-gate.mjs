/**
 * 「平台请求拦截检查」——开关关闭时，内置平台请求一次都不许发出。
 *
 * ## 这个脚本与 `src/test/builtin-gate.test.mts` 的分工
 *
 * 那一套验证的是**注入接缝**：消费方调用的是注入进来的函数，而不是它自己的
 * import。它证明不了「请求没有发出去」，因为它的替身站在门的里面。
 *
 * 本脚本站在最底下：它换掉进程的 `globalThis.fetch`，然后真正跑一遍各条入口，
 * 断言**一次都没有尝试过**。这是 AC3 那句话的字面验证方式——那句话说的不是
 * 「返回了空」，而是「请求没有发出」。
 *
 * ## 为什么必须在最底下拦截，而不是替换某个注入参数
 *
 * 因为有几条路径根本没有注入口。`online/search.ts` 的 `httpGet`、
 * `online/lyrics.ts` 的 `httpGet`、以及 `url-guard.ts` 的 `safeFetchResponse`
 * 都直接调用全局 `fetch`。站在 `globalThis.fetch` 这一层是唯一能同时罩住
 * 「有缝的」和「无缝的」两类调用点的地方，也是唯一不可能被绕过的位置。
 *
 * ## 为什么断言的是「尝试」而不是返回值
 *
 * `fetchOnlineLyric` 吞掉一切错误返回 `{ lyric: '' }`，`ArtistImageStore.resolve`
 * 则会把错误重新抛出。这两种形状与「被门拦下、返回空」在返回值上无法区分。
 * 所以记录发生在替换后的 `fetch` 体内：**函数被调用即算一次尝试**，与被调用方
 * 怎么处理结果无关。
 *
 * ## 为什么「打开时必须非零」这一半不能省
 *
 * 只断言「关闭时为零」的话，一个根本没接线的替身、或者一个恰好提前返回的路径，
 * 都会通过。那样这个脚本就变成了又一个「看起来验过其实没验」的东西——正是本
 * 项目这一轮一直在防的陷阱。所以每一条入口都要在同一个替身下正反各跑一次。
 *
 * ## 本脚本覆盖不到什么（必须随结果一起读）
 *
 *  1. **歌单音质徽标**没有库函数接缝。它只有 `index.ts` 里的 IPC handler，
 *     而 `index.ts` 在模块顶层就读 `import.meta.url` / `app.getPath`，无法被
 *     导入。所以这一条只能靠**读源码**断言，见 `checkBackfillSourceGate()`。
 *     源码断言挡不住「保留字符串、丢掉行为」的重构。
 *  2. `index.ts` 里那几处注入**本身**（`lyricDeps`、`onlineLyric` 的 platform
 *     步骤、`ArtistImageStore` 的构造）同样无法被导入执行，也是源码断言。
 *  3. **音源脚本自己发起的请求不在覆盖范围内**。脚本在子进程里跑，用它自己的
 *     全局 `fetch`；这是 E0 决策 D1-a 的有意取舍（网络能力可用、但不能劫持宿主
 *     的偏好），不是本脚本的疏漏。
 *  4. 它**不能**替代 `npm run test:e2e`，也**不能**替代需求文档要求的人工冒烟。
 *
 * 用法: node tools/check-builtin-gate.mjs
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const outDir = join(repoRoot, 'out', 'test')

/**
 * import 一个构建产物。
 *
 * 必须先转成 `file://` URL：仓库路径里有空格（`JJ Music`），而 Windows 上的
 * 绝对路径（`D:\...`）交给 ESM loader 会得到
 * `ERR_UNSUPPORTED_ESM_URL_SCHEME: Received protocol 'd:'`。
 */
const load = (relative) => import(pathToFileURL(join(outDir, relative)).href)

/*
 * Imported only after the interceptor is installed below, and by absolute path
 * rather than through the package name: these modules are the *compiled* engine
 * (see `tools/build-test.mjs`), which is what the app actually ships.
 */
let SearchRouter
let HotWordSource
let ArtistImageStore
let resolveArtistImage
let lyricCandidates
let lyricsForMatch
let fetchOnlineLyric

/* ------------------------------------------------------------------ *
 * 拦截器
 * ------------------------------------------------------------------ */

/** 每一次被尝试的请求。`url` 是原始入参，不去解析——解析失败也是一种信息。 */
const attempts = []

const realFetch = globalThis.fetch

/**
 * 把全局 `fetch` 换成记录器。
 *
 * 记录之后**拒绝**，而不是挂起：一个永不 settle 的 promise 会让
 * `await Promise.all(...)` 永远等下去，脚本看起来像卡死而不像失败。
 * 拒绝则让「没被门拦住的实现」立刻暴露成一条明确的错误，被调用方自己的
 * `try/catch` 接住——而记录已经落下了，这才是我们要断言的东西。
 */
function installInterceptor() {
  globalThis.fetch = async (input) => {
    attempts.push(typeof input === 'string' ? input : String(input?.url ?? input))
    throw new Error('拦截检查：这条请求不该发出')
  }
}

function restoreFetch() {
  globalThis.fetch = realFetch
}

const attemptCount = () => attempts.length
const resetAttempts = () => { attempts.length = 0 }

/* ------------------------------------------------------------------ *
 * 被测对象的构造
 * ------------------------------------------------------------------ */

/** 一个不存在的引擎：没有音源在跑，于是「音源优先」那条路永远是空的。 */
function noProviderEngine() {
  return {
    providersList: () => [],
    async request() {
      return { ok: false, error: { code: 'notSupported', message: '没有音源' } }
    }
  }
}

/** 热词走真身，取数用真的 `safeFetchText` → 全局 `fetch`，于是拦截器看得见。 */
function makeRouter(allowBuiltin) {
  return new SearchRouter({
    engine: noProviderEngine(),
    hotWords: new HotWordSource(undefined, {}),
    allowBuiltin: () => allowBuiltin
  })
}

/* ------------------------------------------------------------------ *
 * 逐条入口：关闭时必须为零，打开时必须非零
 * ------------------------------------------------------------------ */

const results = []
const failures = []

async function check(name, fn) {
  try {
    await fn()
    results.push({ name, ok: true })
    console.log(`  PASS  ${name}`)
  } catch (error) {
    failures.push({ name, error })
    results.push({ name, ok: false })
    console.log(`  FAIL  ${name}`)
    console.log(`        ${error instanceof Error ? error.message : String(error)}`)
  }
}

/**
 * 一条入口的正反两面。
 *
 * `drive` 拿到 `allowBuiltin` 后自己构造被测对象并调用它。关闭那一半断言为零，
 * 打开那一半断言非零——两半用同一个拦截器、同一份代码路径。
 */
async function gateCheck(label, drive) {
  // 关闭：一次都不许尝试
  resetAttempts()
  await drive(false)
  const off = attemptCount()

  // 打开：必须真的尝试过，否则「关闭时为零」毫无意义。
  //
  // 这里必须**等到跑完**才数数，不能读一次就算：请求多半发生在第一个 `await`
  // 之后（`resolveArtistImage` 先 await 自己的搜索，`fetchOnlineLyric` 先 await
  // 平台分派），同步读到的永远是零。第一次写这个脚本就是这么错的——头像那条
  // 报「打开时一次都没尝试」，而 stderr 里明明白白有一行拦截日志。
  //
  // 拦截器会让请求**拒绝**，所以这个 rejection 是预期的，不是失败：被调用方
  // 自己会接住它（头像重新抛出、取词器吞掉），而我们要的是「尝试过」这个事实。
  resetAttempts()
  await drive(true).catch(() => undefined)
  const on = attemptCount()

  assert.equal(off, 0, `${label}：开关关闭时仍然尝试了 ${off} 次请求 → ${attempts.slice(0, 3).join(' , ')}`)
  assert.ok(on > 0, `${label}：开关打开时一次都没尝试。这个入口没有接到拦截器上，"关闭时为零"因此不能算数。`)
  console.log(`        ${label}：关闭 ${off} 次 / 打开 ${on} 次`)
}

/* ------------------------------------------------------------------ *
 * 入口 1：搜索
 * ------------------------------------------------------------------ */

async function driveSearch(allowBuiltin) {
  const router = makeRouter(allowBuiltin)
  await router.search('tx', '晴天', 1)
}

/* ------------------------------------------------------------------ *
 * 入口 2：热门搜索词
 * ------------------------------------------------------------------ */

async function driveHotWords(allowBuiltin) {
  const router = makeRouter(allowBuiltin)
  await router.hotWords('tx')
}

/* ------------------------------------------------------------------ *
 * 入口 3：歌手头像
 * ------------------------------------------------------------------ */

async function driveArtistImage(allowBuiltin) {
  // 门在构造处，跟 `index.ts` 里那行一样：关掉时解析器直接返回 null，压根不去搜索。
  //
  // 这里必须用模块级那个绑定（`pathToFileURL` 绝对路径导入的构建产物），
  // 不能在函数里写 `import('./online/artist-image.js')`：相对说明符会冲着
  // **本脚本所在目录**（`tools/`）解析，而不是冲着 `out/test/`，于是拿到的是
  // 另一个模块实例——它的 `fetch` 不是被替换过的那个，记录永远为零。第一次
  // 跑就是这样失败的（「打开时一次都没尝试」），而那正是这条正向断言存在的理由。
  // 目录用临时目录：这一条只关心「有没有发请求」，不关心缓存。
  const dir = await mkdtemp(join(tmpdir(), 'jj-gate-check-'))
  try {
    const store = new ArtistImageStore(dir, {
      saveCover: async () => undefined,
      resolveArtistImage: (async (name) => {
        if (!allowBuiltin) return null
        return resolveArtistImage(name)
      })
    })
    await store.image('周杰伦')
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(() => undefined)
  }
}

/* ------------------------------------------------------------------ *
 * 入口 4：歌词取词器（onlineLyric 的 platform 步骤 + lyricDeps.fetchLyric）
 * ------------------------------------------------------------------ */

async function driveLyricFetcher(allowBuiltin) {
  const gated = async (music) => {
    if (!allowBuiltin) return { lyric: '' }
    return fetchOnlineLyric(music)
  }
  await gated({ id: 'tx_1', source: 'tx', name: '晴天', singer: '周杰伦', meta: { songmid: '1' } })
}

/* ------------------------------------------------------------------ *
 * 入口 5：歌词候选的搜索步骤（lyricDeps.search → lyricCandidates）
 * ------------------------------------------------------------------ */

async function driveLyricCandidateSearch(allowBuiltin) {
  const router = makeRouter(allowBuiltin)
  await lyricCandidates(
    { id: 'local_1', path: 'C:\\music\\晴天.mp3', name: '晴天', singer: '周杰伦', duration: 269 },
    {
      search: async (source, keyword, signal) => (await router.search(source, keyword, 1, signal)).list,
      fetchLyric: async (music) => {
        if (!allowBuiltin) return { lyric: '' }
        return fetchOnlineLyric(music)
      }
    }
  )
}

/* ------------------------------------------------------------------ *
 * 入口 6：标签匹配取歌词（lyricsForMatch 的注入取词器）
 * ------------------------------------------------------------------ */

async function driveLyricsForMatch(allowBuiltin) {
  const gated = async (music) => {
    if (!allowBuiltin) return { lyric: '' }
    return fetchOnlineLyric(music)
  }
  // `meta.songmid` 不能省：网易云那个 provider 在没有 id 时会**直接返回空**，
  // 于是一次 fetch 都不发。那样这条的「打开时必须非零」就会失败——这正是它
  // 该失败的地方：一个压根到不了网络的夹具，会让「关闭时为零」变得毫无意义。
  await lyricsForMatch({ id: 'wy_9', source: 'wy', name: '晴天', singer: '周杰伦', meta: { songmid: '186016' } }, gated)
}

/* ------------------------------------------------------------------ *
 * 无法执行的那一条：歌单音质徽标，只能读源码
 * ------------------------------------------------------------------ */

const indexSource = readFileSync(join(repoRoot, 'src', 'main', 'index.ts'), 'utf8')

function checkBackfillSourceGate() {
  assert.match(
    indexSource,
    /if \(!requireServices\(\)\.settings\.get\(\)\.allowBuiltinOnlineSearch\) return \[\]/,
    '歌单音质徽标的门不见了：`playlistBackfillQualitys` 必须在取详情之前短路返回空数组'
  )
  // 这一条是防「只留字符串、丢掉行为」的最低限度：门必须真的在读实时设置。
  const reads = indexSource.match(/allowBuiltinOnlineSearch/g) ?? []
  assert.ok(reads.length >= 3, `index.ts 里读实时开关的地方只剩 ${reads.length} 处，少于预期的 3 处`)
  // 徽标走的是网易云详情接口，门关掉之后那次调用必须彻底不出现。
  assert.match(
    indexSource,
    /allowBuiltinOnlineSearch[\s\S]{0,2000}?fetchNeteaseDetails/,
    '找不到「开关 → 网易云详情」的先后关系，这条路径可能被重排到门外了'
  )
}

/* ------------------------------------------------------------------ *
 * 主流程
 * ------------------------------------------------------------------ */

console.log('平台请求拦截检查：开关关闭时，内置平台请求一次都不许发出\n')

installInterceptor()

try {
  // 动态导入发生在拦截器装好之后，这样模块求值期万一发生的请求也落在记录里。
  ;({ SearchRouter } = await load('online/search-router.js'))
  ;({ HotWordSource } = await load('online/hot-words.js'))
  ;({ ArtistImageStore } = await load('library/artist-images.js'))
  ;({ resolveArtistImage } = await load('online/artist-image.js'))
  ;({ lyricCandidates } = await load('library/lyric-service.js'))
  ;({ lyricsForMatch } = await load('library/metadata-match.js'))
  ;({ fetchOnlineLyric } = await load('online/lyrics.js'))

  await check('搜索：关闭时零次尝试，打开时确实发出', () => gateCheck('搜索', driveSearch))
  await check('热门搜索词：关闭时零次尝试，打开时确实发出', () => gateCheck('热门搜索词', driveHotWords))
  await check('歌手头像：关闭时零次尝试，打开时确实发出', () => gateCheck('歌手头像', driveArtistImage))
  await check('歌词取词器：关闭时零次尝试，打开时确实发出', () => gateCheck('歌词取词器', driveLyricFetcher))
  await check('歌词候选搜索：关闭时零次尝试，打开时确实发出', () => gateCheck('歌词候选搜索', driveLyricCandidateSearch))
  await check('标签匹配取歌词：关闭时零次尝试，打开时确实发出', () => gateCheck('标签匹配取歌词', driveLyricsForMatch))
  await check('歌单音质徽标：门存在且读实时开关（源码断言）', async () => checkBackfillSourceGate())
} finally {
  restoreFetch()
}

console.log(`\n${'='.repeat(72)}`)
console.log(`RESULT: ${results.length - failures.length} passed, ${failures.length} failed`)
console.log('='.repeat(72))
if (failures.length) {
  console.log('\n覆盖不到的（读结论时必须一起看）：')
  console.log('  · 歌单音质徽标、以及 index.ts 内那几处注入，只能靠源码断言')
  console.log('  · 音源脚本自己发起的请求不在范围内（E0 D1-a 的有意取舍）')
  console.log('  · 本脚本不能替代 npm run test:e2e 与人工冒烟')
}
process.exit(failures.length === 0 ? 0 : 1)
