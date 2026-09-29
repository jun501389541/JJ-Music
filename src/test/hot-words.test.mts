import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { HOT_WORD_AGGREGATE_LIMIT, HOT_WORD_LIMIT, HOT_WORD_SOURCES, HotWordSource } from './online/hot-words.js'

/**
 * 热门搜索词。
 *
 * 这里的词全是编的占位串：测的是"能不能从各家自己的结构里认出来"，不是线上到底在搜什么。
 * 四家的响应骨架照抄 2026-09-22 本机实测到的形状（端点取自 lx-music-desktop 那份维护了
 * 多年的清单），因为字段名一旦改回去，这一行就会静默变空。
 */

function qqPayload(words) {
  return JSON.stringify({ code: 0, data: { hotkey: words.map((word, index) => ({ k: word, n: 1000 - index })) } })
}

/** 网易云的热搜榜（不是搜索联想：那是输入前缀之后才有的东西）。 */
function neteasePayload(words) {
  return JSON.stringify({ code: 200, data: { itemList: words.map((word, index) => ({ position: index + 1, searchWord: word, trend: 0 })) } })
}

function kuwoPayload(words) {
  return JSON.stringify({ status: 'ok', tagvalue: words.map((word, index) => ({ key: word, popularity: String(9000 - index) })) })
}

/** 酷狗一次给九个榜，各 30 条；只有「热搜榜」是"大家在搜什么"。 */
function kugouPayload(words) {
  const boards = ['飙升榜', 'DJ榜', '热搜榜', '外语热搜'].map((name) => ({
    name,
    keywords: words.map((word) => ({ keyword: `${name}-${word}`, type: 1 }))
  }))
  return JSON.stringify({ status: 1, errcode: 0, data: { list: boards } })
}

const ROUTES = {
  gethotkey: qqPayload,
  'chart/detail': neteasePayload,
  'hotword.s': kuwoPayload,
  hot_tab: kugouPayload
}

/** 记录每家的请求次数与请求头，好把"缓存生效"和"每次都去问"区分开。 */
function recorder(overrides) {
  const calls = []
  const headers = []
  const fetchText = async (url, referer, extra) => {
    calls.push(url)
    headers.push(extra ?? {})
    const key = Object.keys(ROUTES).find((name) => url.includes(name))
    const custom = key && overrides ? overrides[key] : undefined
    if (custom !== undefined) {
      if (custom instanceof Error) throw custom
      return typeof custom === 'function' ? custom() : custom
    }
    if (!key) throw new Error(`没有配对的端点：${url}`)
    return ROUTES[key](['甲', '乙', '丙'])
  }
  return { calls, headers, fetchText }
}

test('四家各自的形状都能读出词来，且都只认自己那一个榜', async () => {
  const tx = await new HotWordSource(recorder().fetchText).words('tx')
  assert.deepEqual(tx.map((word) => word.text), ['甲', '乙', '丙'])
  assert.ok(tx.every((word) => word.source === 'tx'), '每条都要说得出是哪一家给的')

  const wy = await new HotWordSource(recorder().fetchText).words('wy')
  assert.deepEqual(wy.map((word) => word.text), ['甲', '乙', '丙'], '网易云走热搜榜 itemList[].searchWord')

  const kw = await new HotWordSource(recorder().fetchText).words('kw')
  assert.deepEqual(kw.map((word) => word.text), ['甲', '乙', '丙'], '酷我走 tagvalue[].key')

  const kg = await new HotWordSource(recorder().fetchText).words('kg')
  assert.deepEqual(kg.map((word) => word.text), ['热搜榜-甲', '热搜榜-乙', '热搜榜-丙'],
    '酷狗一次返回九个榜，只取「热搜榜」，否则 270 条会挤成一片')
})

test('酷狗与酷我要带自己的请求头，否则平台直接不认', async () => {
  const spy = recorder()
  await new HotWordSource(spy.fetchText).words('kg')
  assert.equal(spy.headers[0]['x-router'], 'msearch.kugou.com')
  assert.equal(spy.headers[0]['kg-rc'], '1')
  assert.ok(spy.headers[0].dfid, '酷狗网关要 dfid/mid 这一组设备标识')

  const kuwo = recorder()
  await new HotWordSource(kuwo.fetchText).words('kw')
  assert.match(kuwo.headers[0]['User-Agent'], /^Dalvik\//, '酷我热词接口只答安卓端 UA')
})

test('QQ 的词带尾随空格，去重之前要先裁', async () => {
  const source = new HotWordSource(async () => qqPayload([' 甲 ', '甲', '乙']))
  const words = await source.words('tx')
  assert.deepEqual(words.map((word) => word.text), ['甲', '乙'], '同一个词不能因为一个空格出现两次')
})

test('JSONP 包一层也认得，非词的行一律丢掉', async () => {
  const jsonp = `callback(${qqPayload(['甲'])});`
  const one = await new HotWordSource(async () => jsonp).words('tx')
  assert.deepEqual(one.map((word) => word.text), ['甲'])

  // 脏数据：null、对象、空串、以及长得不像搜索词的超长串。
  const dirty = JSON.stringify({ code: 0, data: { hotkey: [null, { k: '' }, { k: '   ' }, { k: '甲' }, { k: 'x'.repeat(80) }, '乙'] } })
  const cleaned = await new HotWordSource(async () => dirty).words('tx')
  assert.deepEqual(cleaned.map((word) => word.text), ['甲', '乙'], '只留能直接放进搜索框的短串')

  const broken = await new HotWordSource(async () => '<html>网关错误</html>').words('tx')
  assert.deepEqual(broken, [], '拿不到 JSON 就当没有，而不是把 HTML 当词')
})

test('单家最多一屏的二十来条，「全部」是四家轮流上', async () => {
  const many = (prefix) => Array.from({ length: 30 }, (_, index) => `${prefix}${index}`)
  const source = new HotWordSource(async (url) => {
    if (url.includes('gethotkey')) return qqPayload(many('T'))
    if (url.includes('chart/detail')) return neteasePayload(many('W'))
    if (url.includes('hotword.s')) return kuwoPayload(many('K'))
    return kugouPayload(many('G'))
  })
  const single = await source.words('tx')
  assert.equal(single.length, HOT_WORD_LIMIT, `一家给 30 条也只留 ${HOT_WORD_LIMIT}：${single.length}`)

  const merged = await source.words('all')
  assert.equal(merged.length, HOT_WORD_AGGREGATE_LIMIT, `汇总行截在这里，再多就成了列表：${merged.length}`)
  for (const prefix of ['T', 'W', 'K']) {
    const count = merged.filter((word) => word.text.startsWith(prefix)).length
    assert.ok(count >= 5, `四家都该露脸，${prefix} 只有 ${count} 条`)
  }
  assert.equal(new Set(merged.map((word) => word.text)).size, merged.length, '不许出现重复行')
})

test('同一个词几家都给，只留一条', async () => {
  const source = new HotWordSource(async (url) => {
    if (url.includes('gethotkey')) return qqPayload(['共同'])
    if (url.includes('chart/detail')) return neteasePayload(['共同', '独有'])
    if (url.includes('hotword.s')) return kuwoPayload(['共同'])
    return kugouPayload(['独有'])
  })
  const merged = await source.words('all')
  // 三家都交「共同」，只留第一条；酷狗那个榜给的是另一串。
  assert.deepEqual(merged.map((word) => word.text), ['共同', '热搜榜-独有', '独有'])
})

test('没有端点的平台答空，不报错也不去请求', async () => {
  let asked = 0
  const source = new HotWordSource(async () => { asked += 1; return '{}' })
  assert.deepEqual(await source.words('mg'), [], '咪咕没有公开热词端点，整行不出现而不是转圈')
  assert.equal(asked, 0, '没有端点就不该发请求')
  assert.deepEqual(await source.words('乱七八糟'), [])
  assert.ok(HOT_WORD_SOURCES.join() === 'tx,wy,kw,kg', 'UI 靠这个列表决定哪些页签会显示热搜')
})

test('一家挂起来，汇总行不等它：三秒后就先显示其余三家', async () => {
  const slow = new Promise((resolve) => setTimeout(() => resolve(qqPayload(['慢'])), 5000))
  const source = new HotWordSource(async (url) => {
    if (url.includes('gethotkey')) return slow
    if (url.includes('chart/detail')) return neteasePayload(['甲'])
    if (url.includes('hotword.s')) return kuwoPayload(['乙'])
    return kugouPayload(['丙'])
  })
  const started = Date.now()
  const merged = await source.words('all')
  const elapsed = Date.now() - started
  assert.ok(elapsed < 4500, `等一家 5 秒的端点等满 8 秒超时才不合理：实际 ${elapsed}ms`)
  assert.ok(merged.length >= 3, `慢的那家先不要，其余三家该在：${merged.length} 条`)
  assert.ok(!merged.some((word) => word.text === '慢'), '慢的那家这一轮确实没赶上')
  const again = await source.words('all')
  assert.ok(again.some((word) => word.text === '慢'), '但那一家的结果该已经进缓存，下一次就有它了')
})

test('一次结果页签共用，失败的也不反复重试', async () => {
  const spy = recorder()
  const source = new HotWordSource(spy.fetchText)
  await source.words('tx')
  await source.words('tx')
  assert.equal(spy.calls.length, 1, '同一天内问过就不该再问')

  const failing = recorder({ gethotkey: new Error('connect timeout') })
  const offline = new HotWordSource(failing.fetchText)
  assert.deepEqual(await offline.words('tx'), [], '拿不到就当这一家没有热搜')
  assert.deepEqual(await offline.words('tx'), [])
  assert.equal(failing.calls.length, 1, '失败也要有退避，别每次切页签都去撞一次')
})

test('一家挂了不影响其余三家', async () => {
  const source = new HotWordSource(async (url) => {
    if (url.includes('gethotkey')) throw new Error('connect timeout')
    if (url.includes('chart/detail')) return neteasePayload(['甲'])
    if (url.includes('hotword.s')) return kuwoPayload(['乙'])
    return kugouPayload(['丙'])
  })
  const merged = await source.words('all')
  assert.deepEqual(merged.map((word) => word.text), ['甲', '乙', '热搜榜-丙'], 'QQ 连不上时，汇总行仍然是另外三家')
})

/* ------------------------------------------------------------------ *
 * 缓存策略：每家平台每个本地自然日一次，落盘，跨重启。
 * 时钟是注入的，所以"跨过零点"不需要等到明天。
 * ------------------------------------------------------------------ */
const dayAt = (month, day, hour = 10) => new Date(2026, month - 1, day, hour, 0, 0).getTime()

async function waitFor(predicate, ms = 1500) {
  const until = Date.now() + ms
  while (Date.now() < until) {
    if (await predicate()) return true
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  return false
}

test('同一天内只问一次，跨过零点才再问', async () => {
  let clock = dayAt(9, 22)
  const spy = recorder()
  const source = new HotWordSource(spy.fetchText, { now: () => clock })
  await source.words('tx')
  await source.words('tx')
  await source.words('all')
  assert.equal(spy.calls.filter(url => url.includes('gethotkey')).length, 1, '当天后面几次都该读记录')
  clock = dayAt(9, 23, 2)
  await source.words('tx')
  assert.equal(spy.calls.filter(url => url.includes('gethotkey')).length, 2, '过了零点就该重新问')
})

test('有昨天的记录：先立刻给昨天的，今天在后台换', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'jj-hot-'))
  const file = join(dir, 'hot-words.json')
  let clock = dayAt(9, 22)
  const seed = new HotWordSource(async () => qqPayload(['昨天的词']), { now: () => clock, file })
  await seed.words('tx')

  // 重启：新实例、同一天、同一份文件
  const persisted = new HotWordSource(async () => { throw new Error('当天不该再问') }, { now: () => clock, file })
  await persisted.load()
  assert.deepEqual((await persisted.words('tx')).map((word) => word.text), ['昨天的词'], '读盘就直接命中，一次请求都不发')

  clock = dayAt(9, 23)
  let asks = 0
  const stale = new HotWordSource(async () => { asks += 1; return qqPayload(['今天的词']) }, { now: () => clock, file })
  await stale.load()
  assert.deepEqual((await stale.words('tx')).map((word) => word.text), ['昨天的词'], '跨过零点那次不能让用户等：先给昨天的')
  assert.ok(await waitFor(async () => (await stale.words('tx')).map((word) => word.text)[0] === '今天的词'),
    '后台那次跑完之后，再进搜索页就是今天的了')
  assert.equal(asks, 1, '跨天只问一次')
  // 落盘是后台那次的尾巴，只能等文件本身：`tools/build-test.mjs` 把 `json-file` 打进了
  // hot-words 这个 bundle，测试里 import 的 `flushJsonWrites()` 是另一份副本、另一张
  // pendingWrites 表，等不到那边的写。
  assert.ok(await waitFor(async () => JSON.parse(await readFile(file, 'utf8')).tx.words[0] === '今天的词'),
    '刷新到的结果要落盘，否则重启又退回"昨天"')
  await rm(dir, { recursive: true, force: true })
})

test('失败不把今天写成"没有"：保留昨天的词，并在退避期内不再撞', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'jj-hot-'))
  const file = join(dir, 'hot-words.json')
  let clock = dayAt(9, 22)
  const seed = new HotWordSource(async () => qqPayload(['昨天的词']), { now: () => clock, file })
  await seed.words('tx')

  clock = dayAt(9, 23)
  let asks = 0
  const broken = new HotWordSource(async () => { asks += 1; throw new Error('connect timeout') }, { now: () => clock, file })
  await broken.load()
  assert.deepEqual((await broken.words('tx')).map((word) => word.text), ['昨天的词'], '取不到就继续用旧的，而不是把这一栏清空')
  assert.equal(asks, 1)
  await broken.words('tx')
  assert.equal(asks, 1, '退避期内不该再去撞那台主机')
  clock = dayAt(9, 23, 11)
  await broken.words('tx')
  assert.equal(asks, 2, '半小时之后可以再试一次')
  assert.deepEqual((await broken.words('tx')).map((word) => word.text), ['昨天的词'], '一直失败就一直留着旧的')
  await rm(dir, { recursive: true, force: true })
})

/* ------------------------------------------------------------------ *
 * 按音源版本隔离。
 *
 * 这是 E6 遗留的那条 Constraints：「更新后按音源版本隔离平台缓存」。
 * `providerId` 不够——`stableId` 按设计跨版本不变，所以"版本"那一半必须是
 * 脚本内容摘要，见 `source-store.ts` 的 `versionOf`。
 *
 * 下面每条都断言**要么答旧词、要么重新发请求**，而不是只看返回值的形状：
 * 一个只把旧条目从返回值里过滤掉、却仍不发请求的实现，会让用户看到空榜
 * 且永远等不到新数据。
 *
 * 变异验证的真实结果（2026-09-28，别把它读成"验过"）：
 * 三道版本防线是**串联冗余**的——`load()` 的读盘过滤、`showNow()` 对异版本的
 * 剔除、`refresh()` 的 `usable` 判据。去掉其中任何**单独**一条，另两条都会让
 * "不展示旧版本的词"这个可观察结论继续成立，所以针对单条的变异在下面这套
 * 断言下**全部逃逸**（实测：`load()` 过滤→`if (false)`、`showNow()` 剔除→
 * `if (false)`、`usable` 判据→`const usable = previous`，三次都 18/18 全绿）。
 * 更下游的两处甚至无从生效：探针显示 `load()` 过滤生效时 `entries` 已是空的，
 * `showNow()`/`refresh()` 根本没有条目可处理。
 *
 * 因此这套测试证明的是**行为契约**（换版本之后用户看到的必须是新脚本的词，
 * 且确实重新问过），不是"上一段实现里的某一行被覆盖"。要让单行可变异，只能
 * 直接读私有的 `entries`——那验的是实现而不是契约，不值当。**"变异通过"这句
 * 话在本分组上不成立，任何后续读者不应据此认为这三条防线各自被验证过。**
 * ------------------------------------------------------------------ */

test('版本没变时照旧读缓存，一个请求都不发', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'jj-hot-ver-'))
  const file = join(dir, 'hot-words.json')
  const clock = dayAt(9, 22)
  const seed = new HotWordSource(async () => qqPayload(['脚本给的词']), { now: () => clock, file, version: () => 'src@aaaa' })
  await seed.words('tx')

  const sameVersion = new HotWordSource(async () => { throw new Error('同版本不该再问') }, { now: () => clock, file, version: () => 'src@aaaa' })
  await sameVersion.load()
  assert.deepEqual(
    (await sameVersion.words('tx')).map((word) => word.text),
    ['脚本给的词'],
    '版本一致就是同一条记录，读盘即命中'
  )
  await rm(dir, { recursive: true, force: true })
})

test('脚本换了版本：磁盘上旧版本写的词不再被展示，而是重新去问', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'jj-hot-ver-'))
  const file = join(dir, 'hot-words.json')
  const clock = dayAt(9, 22)
  const seed = new HotWordSource(async () => qqPayload(['旧版本的词']), { now: () => clock, file, version: () => 'src@aaaa' })
  await seed.words('tx')

  // 升级：同一个音源身份，不同内容指纹。这一格的关键是"答了旧词"和"没去问"
  // 是两种不同的失败，所以两边都断言。
  let asks = 0
  const upgraded = new HotWordSource(async () => { asks += 1; return qqPayload(['新版本的词']) }, { now: () => clock, file, version: () => 'src@bbbb' })
  await upgraded.load()
  const shown = (await upgraded.words('tx')).map((word) => word.text)
  assert.ok(asks >= 1, '旧版本的记录不该被当成"今天已经问过了"：必须重新去问')
  if (shown[0] === '旧版本的词') {
    assert.fail('旧版本写的词不该出现在新版本身边：那份意见已不代表任何在跑的东西')
  }
  assert.deepEqual(shown, ['新版本的词'], '拿到的该是新版本自己的答案')
  await rm(dir, { recursive: true, force: true })
})

test('运行中换版本：setVersion 立刻清掉旧版本的条目，不是只在读时忽略', async () => {
  const clock = dayAt(9, 22)
  const spy = recorder()
  const source = new HotWordSource(spy.fetchText, { now: () => clock, version: () => 'src@aaaa' })
  await source.words('tx')

  // 切到新版本：内存里那份必须当场作废，否则切回旧脚本的用户会继续看到新脚本的榜。
  source.setVersion('src@bbbb')
  await source.words('tx')
  assert.equal(
    spy.calls.filter(url => url.includes('gethotkey')).length,
    2,
    '换版本之后必须重新去问：条目是被删掉了，不是被读时过滤掉了'
  )
})

test('没有音源版本时不隔离，行为与隔离前完全一样', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'jj-hot-ver-'))
  const file = join(dir, 'hot-words.json')
  const clock = dayAt(9, 22)
  const seed = new HotWordSource(async () => qqPayload(['内置的词']), { now: () => clock, file })
  await seed.words('tx')

  // 默认构造：没有 version。这是离线套件与"没有已启用脚本"时的形状。
  const noVersion = new HotWordSource(async () => { throw new Error('不隔离时该照旧命中') }, { now: () => clock, file })
  await noVersion.load()
  assert.deepEqual(
    (await noVersion.words('tx')).map((word) => word.text),
    ['内置的词'],
    '没有版本可归属时不能把记录丢掉——那会让默认安装每天白问一次'
  )
  await rm(dir, { recursive: true, force: true })
})

test('升级前写入的条目（没有 provider 字段）在有版本时被丢弃', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'jj-hot-ver-'))
  const file = join(dir, 'hot-words.json')
  const clock = dayAt(9, 22)
  // 老格式：直接写一份没有 provider 的缓存文件。
  await writeFile(file, JSON.stringify({ tx: { at: clock, words: ['老格式的词'] } }), 'utf8')

  let asks = 0
  const source = new HotWordSource(async () => { asks += 1; return qqPayload(['新格式的词']) }, { now: () => clock, file, version: () => 'src@aaaa' })
  await source.load()
  /*
   * `load()` 从不去问网络，所以断言必须落在 `words()` 之后：老条目被丢弃的证据是
   * 「问到的新词」而不是「加载时发了请求」。
   *
   * 这条测试验的是**展示结果**，不是 `load()` 那一条防线。三者是冗余的——`load()`
   * 的过滤、`showNow()` 对异版本的剔除、`refresh()` 的 `usable` 判据，去掉任何单独
   * 一条，另两条都会让同一个结论成立（变异验证确认：把 `load()` 的过滤整条拿掉，
   * 这条测试仍全绿）。要看住 `load()` 本身，只能直接读 `entries`；那属于内部状态，
   * 而它的可观察后果已经由这里和 `运行中换版本` 那条一起覆盖了。
   */
  const shown = (await source.words('tx')).map((word) => word.text)
  assert.ok(asks >= 1, '没人说得清老条目是哪个脚本版本写的，所以不认它——该重新去问')
  assert.deepEqual(shown, ['新格式的词'], '给出的必须是本次问到的词，不是那份来源不明的老记录')
  await rm(dir, { recursive: true, force: true })
})
