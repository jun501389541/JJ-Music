import assert from 'node:assert/strict'
import { test } from 'node:test'
import { SearchRouter } from './online/search-router.js'
import { HotWordSource } from './online/hot-words.js'

/**
 * 搜索与热词的路由与闸门（E3）。
 *
 * 这一套盯的是 AC3 的核心承诺：**内置平台适配器在用户没打开开关时根本不可达**，
 * 而且音源失败绝不会"悄悄"变成一次内置平台请求。两件事都必须有测试守住，
 * 因为它们的失败方式是"看起来一切正常"——返回结果、不报错、只是走了不该走的那条路。
 *
 * 这里用一个假引擎代替真的 `JjProviderEngine`：真引擎要 fork 子进程，而沙箱禁止
 * Node 派生 Node（见 `jj-provider-engine.test.mts` 的说明）。路由逻辑不碰子进程，
 * 所以假引擎能完整覆盖它；真引擎的进程行为由那一套单独负责。
 */

/** 一次被记录下来的内置适配器调用。 */
const builtinCalls = []

function fakeEngine(providers = []) {
  const list = providers.map((provider) => ({
    providerId: provider.providerId,
    name: provider.name,
    info: { version: '1.0.0', sources: provider.sources ?? [], capabilities: provider.capabilities ?? [] }
  }))
  const calls = []
  return {
    calls,
    providersList: () => list,
    async request(providerId, capability, payload) {
      calls.push({ providerId, capability, payload })
      const provider = providers.find((item) => item.providerId === providerId)
      const answer = provider?.answers?.[capability]
      if (answer === undefined) {
        return { ok: false, error: { code: 'notSupported', message: `音源「${provider?.name}」不支持该能力：${capability}` } }
      }
      const value = typeof answer === 'function' ? answer(payload) : answer
      if (value && value.__fail) return { ok: false, error: { code: 'internal', message: value.__fail } }
      return { ok: true, data: value }
    },
    searchablePlatforms: () => []
  }
}

/** 记录每一次内置热词请求，而不是真的发出去。 */
function recordingHotWords(payload = { words: ['内置甲', '内置乙'] }) {
  const calls = []
  const source = new HotWordSource(async (url) => { calls.push(url); return JSON.stringify(payload) })
  return { calls, source }
}

function routerFor(engine, { allowBuiltin, hotWords = recordingHotWords().source }) {
  return new SearchRouter({ engine, hotWords, allowBuiltin: () => allowBuiltin })
}

function track(id, name = '曲目') {
  return { id, name, singer: '歌手', source: 'tx', interval: '03:00' }
}

/* ------------------------------------------------------------------ *
 * 闸门：关着的时候，内置适配器不可达
 * ------------------------------------------------------------------ */

test('闸门关着且没有音源时，搜索不发任何内置请求，并说明原因', async () => {
  const engine = fakeEngine()
  const router = routerFor(engine, { allowBuiltin: false })

  const page = await router.search('tx', '测试', 1)

  assert.deepEqual(page.list, [], '没有音源就不该有结果')
  assert.equal(page.servedBy, 'none')
  assert.equal(page.reason, 'noProvider')
  assert.ok(page.message, '空结果必须带一句能显示给用户的话')
  // 关键断言：不是"结果为空"，而是这条路根本没被走过。
  assert.equal(engine.calls.length, 0, '不应对任何音源发起请求')
})

test('闸门关着且没有音源时，热词也不发内置请求', async () => {
  const hot = recordingHotWords()
  const router = routerFor(fakeEngine(), { allowBuiltin: false, hotWords: hot.source })

  const result = await router.hotWords('all')

  assert.deepEqual(result.words, [])
  assert.equal(result.servedBy, 'none')
  assert.equal(result.reason, 'noProvider')
  assert.equal(hot.calls.length, 0, '内置热词端点一次都不该被问到')
})

test('闸门打开后，没有音源时才走内置适配器', async () => {
  const engine = fakeEngine()
  const router = routerFor(engine, { allowBuiltin: true })

  const page = await router.search('tx', '测试', 1)

  // 内置适配器此刻会真的发网络请求，这里只确认它被选中了：
  // `servedBy === 'builtin'` 表示路径选对，失败与否由网络决定。
  assert.ok(page.servedBy === 'builtin' || page.reason === 'builtinFailed', `走的应是内置路径，实际 ${page.servedBy}`)
})

/* ------------------------------------------------------------------ *
 * 路由：音源优先，且绝不退化成内置请求
 * ------------------------------------------------------------------ */

test('音源声明了搜索能力时，请求走音源而不是内置适配器', async () => {
  const engine = fakeEngine([
    {
      providerId: 'src_a',
      name: '聚合音源',
      sources: ['tx'],
      capabilities: ['searchTracks'],
      answers: { searchTracks: { list: [track('tx_1', '来自音源')], page: 1, total: 1 } }
    }
  ])
  // 闸门故意打开：即使内置可用，音源能服务时也必须优先。
  const router = routerFor(engine, { allowBuiltin: true })

  const page = await router.search('tx', '测试', 1)

  assert.equal(page.servedBy, 'provider')
  assert.equal(page.list.length, 1)
  assert.equal(page.list[0].name, '来自音源')
  assert.equal(engine.calls.length, 1)
  assert.equal(engine.calls[0].capability, 'searchTracks')
  assert.equal(engine.calls[0].providerId, 'src_a')
})

test('音源失败时返回失败，绝不回退成内置平台请求', async () => {
  const engine = fakeEngine([
    {
      providerId: 'src_a',
      name: '坏音源',
      sources: ['tx'],
      capabilities: ['searchTracks'],
      answers: { searchTracks: { __fail: '连接被重置' } }
    }
  ])
  const router = routerFor(engine, { allowBuiltin: true })

  const page = await router.search('tx', '测试', 1)

  // 这是 AC3 最容易被违反的一行：失败必须是失败本身。
  assert.equal(page.servedBy, 'none', '音源失败不得改走内置路径')
  assert.equal(page.reason, 'providerFailed')
  assert.ok(page.message?.includes('连接被重置'), '必须把音源的失败原因说出来')
})

test('音源声明了搜索能力但没列平台时，视为可服务所有已知平台', async () => {
  const engine = fakeEngine([
    { providerId: 'src_a', name: '全能音源', sources: [], capabilities: ['searchTracks'], answers: { searchTracks: { list: [track('tx_9')], page: 1 } } }
  ])
  const router = routerFor(engine, { allowBuiltin: false })

  const page = await router.search('wy', '测试', 1)

  assert.equal(page.servedBy, 'provider', '未声明平台不应让平台页签搜不了')
  assert.equal(engine.calls.length, 1)
})

test('音源只服务它声明过的平台，别的平台不打扰它', async () => {
  const engine = fakeEngine([
    { providerId: 'src_a', name: '只做QQ', sources: ['tx'], capabilities: ['searchTracks'], answers: { searchTracks: { list: [track('tx_1')], page: 1 } } }
  ])
  const router = routerFor(engine, { allowBuiltin: false })

  const page = await router.search('wy', '测试', 1)

  assert.equal(engine.calls.length, 0, '不该向只声明 tx 的音源问 wy')
  assert.equal(page.servedBy, 'none')
})

test('全部页签把多个音源的结果按轮转交错，而不是接成一串', async () => {
  const engine = fakeEngine([
    { providerId: 'src_a', name: 'A', sources: ['tx'], capabilities: ['searchTracks'], answers: { searchTracks: { list: [track('tx_1', 'A1'), track('tx_2', 'A2')], page: 1 } } },
    { providerId: 'src_b', name: 'B', sources: ['wy'], capabilities: ['searchTracks'], answers: { searchTracks: { list: [track('wy_1', 'B1')], page: 1 } } }
  ])
  const router = routerFor(engine, { allowBuiltin: false })

  const page = await router.search('all', '测试', 1)

  assert.equal(page.servedBy, 'provider')
  assert.deepEqual(page.list.map((item) => item.name), ['A1', 'B1', 'A2'], '应是 A1、B1、A2 而不是 A1、A2、B1')
  assert.equal(page.providers?.length, 2)
})

/* ------------------------------------------------------------------ *
 * 热词
 * ------------------------------------------------------------------ */

test('音源提供热词时走音源，内置端点不被问到', async () => {
  const hot = recordingHotWords()
  const engine = fakeEngine([
    { providerId: 'src_a', name: '热词音源', sources: ['tx'], capabilities: ['getHotWords'], answers: { getHotWords: { words: ['甲词', '乙词'] } } }
  ])
  const router = routerFor(engine, { allowBuiltin: true, hotWords: hot.source })

  const result = await router.hotWords('tx')

  assert.equal(result.servedBy, 'provider')
  assert.deepEqual(result.words.map((word) => word.text), ['甲词', '乙词'])
  assert.equal(hot.calls.length, 0, '音源能答时不该再问内置端点')
})

test('热词结果会过滤空串与超长词，并去重', async () => {
  const engine = fakeEngine([
    {
      providerId: 'src_a',
      name: '脏热词音源',
      sources: ['tx'],
      capabilities: ['getHotWords'],
      answers: { getHotWords: { words: ['甲', '', '甲', 'x'.repeat(100), '乙'] } }
    }
  ])
  const router = routerFor(engine, { allowBuiltin: false })

  const result = await router.hotWords('tx')

  assert.deepEqual(result.words.map((word) => word.text), ['甲', '乙'])
})

test('热词音源失败且闸门关着时，不回退到内置端点', async () => {
  const hot = recordingHotWords()
  const engine = fakeEngine([
    { providerId: 'src_a', name: '坏热词音源', sources: ['tx'], capabilities: ['getHotWords'], answers: { getHotWords: { __fail: '超时' } } }
  ])
  const router = routerFor(engine, { allowBuiltin: false, hotWords: hot.source })

  const result = await router.hotWords('tx')

  assert.equal(result.servedBy, 'none')
  assert.equal(hot.calls.length, 0)
})

test('热词只问声明了目标平台的音源', async () => {
  const engine = fakeEngine([
    { providerId: 'src_a', name: '只做QQ', sources: ['tx'], capabilities: ['getHotWords'], answers: { getHotWords: { words: ['QQ词'] } } }
  ])
  const router = routerFor(engine, { allowBuiltin: false })

  const result = await router.hotWords('wy')

  assert.equal(engine.calls.length, 0, '不该把 QQ 的热词当成网易云的')
  assert.equal(result.servedBy, 'none')
})

/* ------------------------------------------------------------------ *
 * 平台页签
 * ------------------------------------------------------------------ */

test('可搜索平台来自正在运行且声明了搜索能力的音源', async () => {
  const engine = fakeEngine([
    { providerId: 'src_a', name: 'A', sources: ['tx', 'wy'], capabilities: ['searchTracks'] },
    // 声明了平台但没声明搜索能力：它不是搜索页签的来源。
    { providerId: 'src_b', name: 'B', sources: ['kg'], capabilities: ['getMusicUrl'] }
  ])
  const router = routerFor(engine, { allowBuiltin: false })

  assert.deepEqual(router.searchablePlatforms().sort(), ['tx', 'wy'])
})

test('空关键词直接返回空，不打扰任何一方', async () => {
  const engine = fakeEngine([
    { providerId: 'src_a', name: 'A', sources: ['tx'], capabilities: ['searchTracks'], answers: { searchTracks: { list: [track('tx_1')], page: 1 } } }
  ])
  const router = routerFor(engine, { allowBuiltin: false })

  const page = await router.search('tx', '   ', 1)

  assert.deepEqual(page.list, [])
  assert.equal(engine.calls.length, 0)
})
