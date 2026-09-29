import assert from 'node:assert/strict'
import { test } from 'node:test'
import { LibraryRouter } from './online/library-router.js'

/**
 * 歌单与榜单的路由与闸门（E5）。
 *
 * 这一套盯的与 `search-router.test.mts` 是同一件事，只是对象换成了歌单和榜单：
 * **内置平台适配器在用户没打开开关时根本不可达**，而且音源失败绝不会"悄悄"变成
 * 一次内置平台请求。两件事的失败方式都是"看起来一切正常"——返回结果、不报错、
 * 只是走了不该走的那条路——所以必须有断言证明那条路没被走过，而不只是结果为空。
 *
 * 用假引擎代替真的 `JjProviderEngine`：真引擎要 fork 子进程，而沙箱禁止 Node 派生
 * Node（见 `jj-provider-engine.test.mts` 的说明）。路由逻辑不碰子进程。
 */

function fakeEngine(providers = []) {
  const list = providers.map((provider) => ({
    providerId: provider.providerId,
    name: provider.name,
    info: {
      version: '1.0.0',
      sources: provider.sources ?? [],
      capabilities: provider.capabilities ?? []
    }
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
        return {
          ok: false,
          error: { code: 'notSupported', message: `音源「${provider?.name}」不支持该能力：${capability}` }
        }
      }
      const value = typeof answer === 'function' ? answer(payload) : answer
      if (value && value.__fail) return { ok: false, error: { code: 'internal', message: value.__fail } }
      return { ok: true, data: value }
    }
  }
}

/** 记录每一次内置导入，而不是真的发网络请求。 */
function recordingImport(tracks = [{ id: 'tx_1', name: '内置曲目', singer: '歌手', source: 'tx' }]) {
  const calls = []
  const fn = async (source, input) => {
    calls.push({ source, input })
    return { name: '内置歌单', source, sourceListId: '123', tracks, total: tracks.length, warnings: [] }
  }
  return { calls, fn }
}

function routerFor(engine, { allowBuiltin, importBuiltin } = {}) {
  const builtin = importBuiltin ?? recordingImport()
  return {
    builtin,
    router: new LibraryRouter({
      engine,
      allowBuiltin: () => allowBuiltin,
      importBuiltin: builtin.fn
    })
  }
}

function track(id, name = '曲目') {
  return { id, name, singer: '歌手', source: 'tx', interval: '03:00' }
}

/* ------------------------------------------------------------------ *
 * 闸门：关着的时候，内置适配器不可达
 * ------------------------------------------------------------------ */

test('闸门关着且没有音源时，歌单读取不发内置请求，并说明原因', async () => {
  const engine = fakeEngine()
  const { router, builtin } = routerFor(engine, { allowBuiltin: false })

  const page = await router.importTracks('tx', 'https://y.qq.com/n/ryqq/playlist/123', '123')

  assert.deepEqual(page.list, [], '没有音源就不该有曲目')
  assert.equal(page.servedBy, 'none')
  assert.equal(page.reason, 'noProvider')
  assert.ok(page.message, '空结果必须带一句能显示给用户的话')
  // 关键断言：不是"结果为空"，而是这条路根本没被走过。
  assert.equal(builtin.calls.length, 0, '内置导入一次都不该被调用')
  assert.equal(engine.calls.length, 0, '不应对任何音源发起请求')
})

test('闸门关着且没有音源时，榜单不发任何内置请求', async () => {
  const engine = fakeEngine()
  const { router, builtin } = routerFor(engine, { allowBuiltin: false })

  const result = await router.leaderboards()

  assert.deepEqual(result.list, [])
  assert.equal(result.servedBy, 'none')
  assert.equal(result.reason, 'noProvider')
  assert.ok(result.message)
  assert.equal(builtin.calls.length, 0)
  assert.equal(engine.calls.length, 0)
})

test('说明文案要区分「一个音源都没启用」和「启用的音源不会读歌单」', async () => {
  const empty = routerFor(fakeEngine(), { allowBuiltin: false })
  const none = await empty.router.importTracks('tx', '123', '123')
  assert.match(none.message, /尚未启用任何音源/, '没装音源时要指向音源管理')

  const engine = fakeEngine([
    { providerId: 'src_a', name: '只会搜索的音源', sources: ['tx'], capabilities: ['searchTracks'] }
  ])
  const loaded = routerFor(engine, { allowBuiltin: false })
  const unqualified = await loaded.router.importTracks('tx', '123', '123')
  assert.match(unqualified.message, /只会搜索的音源/, '要指出是哪个音源做不到')
  // 两种情况给同一句话，用户就无法知道该去装音源还是换音源。
  assert.notEqual(none.message, unqualified.message)
})

/* ------------------------------------------------------------------ *
 * 路由：音源优先，且绝不退化成内置请求
 * ------------------------------------------------------------------ */

test('音源声明了歌单能力时，读取走音源而不是内置适配器', async () => {
  const engine = fakeEngine([
    {
      providerId: 'src_a',
      name: '聚合音源',
      sources: ['tx'],
      capabilities: ['getPlaylist', 'getPlaylistTracks'],
      answers: {
        getPlaylist: { id: '123', name: '来自音源的歌单', coverUrl: 'https://example.test/c.jpg', total: 1 },
        getPlaylistTracks: { list: [track('tx_1', '来自音源')], page: 1, total: 1, hasMore: false }
      }
    }
  ])
  // 闸门故意打开：即使内置可用，音源能服务时也必须优先。
  const { router, builtin } = routerFor(engine, { allowBuiltin: true })

  const page = await router.importTracks('tx', 'https://y.qq.com/n/ryqq/playlist/123', '123')

  assert.equal(page.servedBy, 'provider')
  assert.equal(page.list.length, 1)
  assert.equal(page.list[0].name, '来自音源')
  assert.equal(page.name, '来自音源的歌单', '歌单头要来自 getPlaylist')
  assert.equal(page.coverUrl, 'https://example.test/c.jpg')
  assert.equal(builtin.calls.length, 0, '音源能服务时不该碰内置路径')
})

test('宿主把识别出的 ID 交给脚本，而不是用户粘贴的原始链接', async () => {
  const engine = fakeEngine([
    {
      providerId: 'src_a',
      name: '聚合音源',
      sources: ['tx'],
      capabilities: ['getPlaylist', 'getPlaylistTracks'],
      answers: {
        getPlaylist: { id: '123', name: '歌单' },
        getPlaylistTracks: { list: [track('tx_1')], page: 1 }
      }
    }
  ])
  const { router } = routerFor(engine, { allowBuiltin: false })
  const link = 'https://y.qq.com/n/ryqq/playlist/123?from=somewhere#anchor'

  await router.importTracks('tx', link, '123')

  // 这是本轮定下的裁决：识别归宿主，脚本只拿到 ID。脚本看到原始 URL 就等于
  // 知道了用户的浏览上下文，而宿主也失去了「链接与所选平台是否一致」这道校验。
  const called = engine.calls.filter((call) => call.capability === 'getPlaylistTracks')
  assert.equal(called.length, 1)
  assert.equal(called[0].payload.id, '123', '交给脚本的必须是解析出的 ID')
  assert.notEqual(called[0].payload.id, link, '不得把原始链接当作 ID 传下去')
})

test('音源失败时绝不退化到内置适配器，只报告失败', async () => {
  const engine = fakeEngine([
    {
      providerId: 'src_a',
      name: '坏掉的音源',
      sources: ['tx'],
      capabilities: ['getPlaylist', 'getPlaylistTracks'],
      answers: {
        getPlaylist: { id: '123', name: '歌单' },
        getPlaylistTracks: { __fail: '网络不可达' }
      }
    }
  ])
  // 闸门开着，正因为开着才有意义：内置路径此刻**可以**回答，但它不该被选中。
  const { router, builtin } = routerFor(engine, { allowBuiltin: true })

  const page = await router.importTracks('tx', '123', '123')

  assert.equal(page.servedBy, 'none')
  assert.equal(page.reason, 'providerFailed')
  assert.match(page.message, /坏掉的音源/)
  assert.match(page.message, /网络不可达/)
  assert.equal(builtin.calls.length, 0, 'AC3：音源失败不得静默回退成内置平台请求')
})

test('闸门打开后，没有音源时才走内置适配器', async () => {
  const engine = fakeEngine()
  const { router, builtin } = routerFor(engine, { allowBuiltin: true })

  const page = await router.importTracks('tx', 'https://y.qq.com/n/ryqq/playlist/123', '123')

  assert.equal(page.servedBy, 'builtin')
  assert.equal(builtin.calls.length, 1, '内置路径应被选中一次')
  assert.equal(page.list.length, 1)
})

test('内置适配器自己失败时，把它的原话带给用户', async () => {
  const failing = async () => {
    throw Error('歌单不存在、非公开或平台拒绝访问')
  }
  const { router } = routerFor(fakeEngine(), {
    allowBuiltin: true,
    importBuiltin: { calls: [], fn: failing }
  })

  const page = await router.importTracks('tx', '123', '123')

  assert.equal(page.servedBy, 'none')
  assert.equal(page.reason, 'builtinFailed')
  // 内置适配器已经把「不存在」「平台拒绝」「超 5000 上限」分开了，
  // 这里再改写一次只会把这些区分丢掉。
  assert.match(page.message, /歌单不存在、非公开或平台拒绝访问/)
})

/* ------------------------------------------------------------------ *
 * 平台匹配
 * ------------------------------------------------------------------ */

test('只交给服务该平台的音源', async () => {
  const engine = fakeEngine([
    {
      providerId: 'src_tx',
      name: 'QQ 音源',
      sources: ['tx'],
      capabilities: ['getPlaylist', 'getPlaylistTracks'],
      answers: {
        getPlaylist: { id: '123', name: 'QQ 歌单' },
        getPlaylistTracks: { list: [track('tx_1', 'QQ 曲目')], page: 1 }
      }
    },
    {
      providerId: 'src_wy',
      name: '网易音源',
      sources: ['wy'],
      capabilities: ['getPlaylist', 'getPlaylistTracks'],
      answers: {
        getPlaylist: { id: '123', name: '网易歌单' },
        getPlaylistTracks: { list: [track('wy_1', '网易曲目')], page: 1 }
      }
    }
  ])
  const { router } = routerFor(engine, { allowBuiltin: false })

  const page = await router.importTracks('tx', '123', '123')

  assert.equal(page.providerId, 'src_tx')
  assert.equal(page.list[0].name, 'QQ 曲目')
  const wyCalls = engine.calls.filter((call) => call.providerId === 'src_wy')
  assert.equal(wyCalls.length, 0, '不该把 QQ 歌单交给只服务网易的音源')
})

test('没声明平台的音源被视为服务所有平台', async () => {
  const engine = fakeEngine([
    {
      providerId: 'src_any',
      name: '通用音源',
      sources: [],
      capabilities: ['getPlaylist', 'getPlaylistTracks'],
      answers: {
        getPlaylist: { id: '123', name: '通用歌单' },
        getPlaylistTracks: { list: [track('tx_1')], page: 1 }
      }
    }
  ])
  const { router } = routerFor(engine, { allowBuiltin: false })

  const page = await router.importTracks('tx', '123', '123')
  assert.equal(page.servedBy, 'provider')
  assert.equal(page.providerId, 'src_any')
})

/* ------------------------------------------------------------------ *
 * 榜单
 * ------------------------------------------------------------------ */

test('榜单合并所有音源的榜单，并按 providerId 区分同名榜', async () => {
  const engine = fakeEngine([
    {
      providerId: 'src_a',
      name: '音源甲',
      sources: ['tx'],
      capabilities: ['getLeaderboard'],
      answers: {
        getLeaderboard: [
          { id: 'top500', name: '热歌榜' },
          { id: 'new', name: '新歌榜', coverUrl: 'https://example.test/b.jpg' }
        ]
      }
    },
    {
      providerId: 'src_b',
      name: '音源乙',
      sources: ['wy'],
      capabilities: ['getLeaderboard'],
      // 两个音源都叫 top500：这是真实情况，UI 必须能同时显示而不是互相覆盖。
      answers: { getLeaderboard: [{ id: 'top500', name: '飙升榜', updateFrequency: '每日' }] }
    }
  ])
  const { router } = routerFor(engine, { allowBuiltin: false })

  const result = await router.leaderboards()

  assert.equal(result.servedBy, 'provider')
  assert.equal(result.list.length, 3)
  const keys = result.list.map((board) => `${board.providerId}:${board.id}`)
  assert.equal(new Set(keys).size, 3, 'providerId + boardId 必须唯一')
  const second = result.list.find((board) => board.providerId === 'src_b')
  assert.equal(second.name, '飙升榜')
  assert.equal(second.source, 'wy')
  assert.equal(second.updateFrequency, '每日')
  assert.equal(result.list.find((board) => board.name === '新歌榜').coverUrl, 'https://example.test/b.jpg')
})

test('一个音源榜单失败不影响其他音源，但失败要被记录', async () => {
  const engine = fakeEngine([
    {
      providerId: 'src_ok',
      name: '好音源',
      sources: ['tx'],
      capabilities: ['getLeaderboard'],
      answers: { getLeaderboard: [{ id: 'top', name: '好榜' }] }
    },
    {
      providerId: 'src_bad',
      name: '坏音源',
      sources: ['wy'],
      capabilities: ['getLeaderboard'],
      answers: { getLeaderboard: { __fail: '接口改了' } }
    }
  ])
  const { router } = routerFor(engine, { allowBuiltin: false })

  const result = await router.leaderboards()

  assert.equal(result.servedBy, 'provider', '一个音源坏掉不该让整页消失')
  assert.equal(result.list.length, 1)
  assert.equal(result.failed.length, 1)
  assert.equal(result.failed[0].name, '坏音源')
  assert.match(result.failed[0].error, /接口改了/)
})

test('所有音源的榜单都失败时，报告失败而不是空榜单', async () => {
  const engine = fakeEngine([
    {
      providerId: 'src_a',
      name: '音源甲',
      sources: ['tx'],
      capabilities: ['getLeaderboard'],
      answers: { getLeaderboard: { __fail: '崩了' } }
    }
  ])
  const { router } = routerFor(engine, { allowBuiltin: false })

  const result = await router.leaderboards()

  assert.equal(result.servedBy, 'none')
  assert.equal(result.reason, 'providerFailed', '「音源坏了」与「没有榜单」要给不同原因')
  assert.match(result.message, /崩了/)
})

test('榜单曲目按 providerId 取，音源不存在时给出可恢复的提示', async () => {
  const engine = fakeEngine([
    {
      providerId: 'src_a',
      name: '音源甲',
      sources: ['tx'],
      capabilities: ['getLeaderboardTracks'],
      answers: { getLeaderboardTracks: { list: [track('tx_1', '榜内曲目')], page: 1, hasMore: true } }
    }
  ])
  const { router } = routerFor(engine, { allowBuiltin: false })

  const ok = await router.leaderboardTracks('src_a', 'top500', 1)
  assert.equal(ok.servedBy, 'provider')
  assert.equal(ok.list[0].name, '榜内曲目')
  assert.equal(ok.hasMore, true)

  // 被卸载或禁用的音源：必须明说，并且不得静默换成别的音源。
  const missing = await router.leaderboardTracks('src_gone', 'top500', 1)
  assert.equal(missing.servedBy, 'none')
  assert.equal(missing.reason, 'providerFailed')
  assert.match(missing.message, /src_gone/)
  assert.match(missing.message, /卸载|禁用/)
})

/* ------------------------------------------------------------------ *
 * 能力发现
 * ------------------------------------------------------------------ */

test('hasLeaderboards / playablePlatforms 只看运行中的音源声明了什么', () => {
  const none = routerFor(fakeEngine(), { allowBuiltin: true })
  assert.equal(none.router.hasLeaderboards(), false, '没人声明时不该假装有榜单')
  assert.deepEqual(none.router.playablePlatforms(), [])

  const engine = fakeEngine([
    {
      providerId: 'src_a',
      name: '音源甲',
      sources: ['tx', 'wy'],
      capabilities: ['getPlaylist', 'getLeaderboard']
    }
  ])
  const some = routerFor(engine, { allowBuiltin: false })
  assert.equal(some.router.hasLeaderboards(), true)
  assert.deepEqual(some.router.playablePlatforms().sort(), ['tx', 'wy'])
  assert.deepEqual(some.router.leaderboardPlatforms().sort(), ['tx', 'wy'])
})
