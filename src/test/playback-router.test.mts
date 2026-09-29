import assert from 'node:assert/strict'
import { test } from 'node:test'
import { PlaybackError, PlaybackRouter } from './sources/playback-router.js'

/**
 * 播放归属路由（E4）。
 *
 * 这一套盯的是 AC2 在播放侧的承诺：**搜索结果里的音源归属必须一路活到播放**，
 * 不能让平台 A 的曲目被平台 B 的脚本播放。这条承诺的失败方式是"看起来一切正常"
 * ——有声音、不报错，只是用了错的音源、错的 ID。
 *
 * 三个必须守住的性质：
 *   1. 带 `providerId` 的曲目走 JJ 引擎，**不会被交给 LX 引擎**；
 *   2. 不带 `providerId` 的旧曲目走 LX 引擎，**不被当成错误**（历史曲库的常态）；
 *   3. `providerId` 指向已消失的音源时报错，**绝不静默改换另一个音源**。
 *
 * 这里用假引擎代替真的 `SourceEngine` / `JjProviderEngine`：真引擎要 fork 子进程，
 * 而沙箱禁止 Node 派生 Node（见 `jj-provider-engine.test.mts` 的说明）。路由决策
 * 不碰子进程，所以假引擎能完整覆盖它。
 */

/** 记录调用并给出预设答案的假 JJ 引擎。 */
function fakeEngine(providers = []) {
  const calls = []
  return {
    calls,
    providerFor(track) {
      const declared = track.providerId
      if (typeof declared === 'string' && declared.length > 0) return declared
      return null
    },
    supports(providerId, capability) {
      const provider = providers.find((item) => item.providerId === providerId)
      return Boolean(provider?.capabilities?.includes(capability))
    },
    async request(providerId, capability, payload) {
      calls.push({ providerId, capability, payload })
      const provider = providers.find((item) => item.providerId === providerId)
      if (!provider) {
        return {
          ok: false,
          error: {
            code: 'notFound',
            message: `找不到音源实例「${providerId}」。它可能已被卸载或禁用；可重新选择一个音源播放，或为该曲目重新匹配在线音源。`
          }
        }
      }
      const answer = provider.answers?.[capability]
      if (answer === undefined) {
        return {
          ok: false,
          error: { code: 'notSupported', message: `音源「${provider.name}」不支持该能力：${capability}` }
        }
      }
      const value = typeof answer === 'function' ? answer(payload) : answer
      if (value && value.__fail) {
        return { ok: false, error: { code: value.__code ?? 'internal', message: value.__fail } }
      }
      return { ok: true, data: value }
    }
  }
}

/** 记录调用并给出预设答案的假 LX 引擎。 */
function fakeSourceEngine(answers = {}) {
  const calls = []
  return {
    calls,
    supports(source, action) {
      return Boolean(answers.supports?.includes(`${source}:${action}`))
    },
    async getMusicUrl(source, track, preferred, strict) {
      calls.push({ method: 'getMusicUrl', source, preferred, strict })
      const answer = answers.musicUrl
      if (answer === undefined) throw new Error(`音源「${source}」已停止或没有可用的音源支持该平台`)
      if (answer.__throw) throw new Error(answer.__throw)
      return answer
    },
    async getLyric(source, track, signal) {
      calls.push({ method: 'getLyric', source })
      return answers.lyric ?? { lyric: '' }
    },
    async getPic(source, track, signal) {
      calls.push({ method: 'getPic', source })
      return answers.pic ?? ''
    }
  }
}

function routerFor({ engine = fakeEngine(), sourceEngine = fakeSourceEngine() } = {}) {
  return { router: new PlaybackRouter({ sourceEngine, jjEngine: engine }), engine, sourceEngine }
}

function track(id, extra = {}) {
  return { id, name: '曲目', singer: '歌手', source: 'tx', interval: '03:00', ...extra }
}

/* ------------------------------------------------------------------ *
 * 归属已经在 track 上：有 providerId 走 JJ，没有走 LX
 * ------------------------------------------------------------------ */

test('带 providerId 的曲目交给 JJ 引擎，LX 引擎一次都不被调用', async () => {
  const engine = fakeEngine([
    { providerId: 'src_a', name: '甲音源', capabilities: ['getMusicUrl'], answers: { getMusicUrl: { list: [{ url: 'https://a.example/1.mp3' }] } } }
  ])
  const sourceEngine = fakeSourceEngine({ musicUrl: { url: 'https://lx.example/1.mp3', quality: '128k' } })
  const { router } = routerFor({ engine, sourceEngine })

  const result = await router.musicUrl(track('tx_1', { providerId: 'src_a' }), '320k')

  assert.equal(result.url, 'https://a.example/1.mp3')
  assert.equal(result.apiId, 'src_a', '播放结果必须报出是哪个音源答的')
  assert.equal(sourceEngine.calls.length, 0, 'LX 引擎绝不能被碰——这正是 AC2 要防的串用')
  assert.equal(engine.calls.length, 1)
  assert.equal(engine.calls[0].capability, 'getMusicUrl')
})

test('不带 providerId 的旧曲目回落 LX 引擎，且不被当成错误', async () => {
  const engine = fakeEngine()
  const sourceEngine = fakeSourceEngine({ musicUrl: { url: 'https://lx.example/old.mp3', quality: '128k' } })
  const { router } = routerFor({ engine, sourceEngine })

  const result = await router.musicUrl(track('tx_old'), '128k')

  assert.equal(result.url, 'https://lx.example/old.mp3')
  assert.equal(sourceEngine.calls.length, 1, '旧曲目必须走既有路径，否则升级即回归')
  assert.equal(engine.calls.length, 0)

  // 关键：strict 必须原样透传，LX 引擎的严格模式是下载路径依赖的。
  assert.equal(sourceEngine.calls[0].strict, false)
  await router.musicUrl(track('tx_old'), '128k', true)
  assert.equal(sourceEngine.calls[1].strict, true, 'strict 参数在路由层不能被丢掉')
})

test('providerId 为空串与 undefined 等价，都走 LX 引擎', async () => {
  const sourceEngine = fakeSourceEngine({ musicUrl: { url: 'https://lx.example/x.mp3', quality: '128k' } })
  const { router } = routerFor({ sourceEngine })

  for (const providerId of [undefined, '', null]) {
    const result = await router.musicUrl(track('tx_1', { providerId }), '128k')
    assert.equal(result.url, 'https://lx.example/x.mp3')
  }
  assert.equal(sourceEngine.calls.length, 3)
})

/* ------------------------------------------------------------------ *
 * 音源消失：指名报错，绝不静默改换
 * ------------------------------------------------------------------ */

test('providerId 指向已卸载的音源时报错，且不回落任何其他音源', async () => {
  const engine = fakeEngine()
  const sourceEngine = fakeSourceEngine({ musicUrl: { url: 'https://lx.example/other.mp3', quality: '128k' } })
  const { router } = routerFor({ engine, sourceEngine })

  await assert.rejects(
    () => router.musicUrl(track('tx_1', { providerId: 'src_gone' }), '320k'),
    (error) => {
      assert.ok(error instanceof PlaybackError)
      assert.equal(error.reason, 'providerMissing')
      assert.equal(error.providerId, 'src_gone')
      // 引擎原文必须保留：它是完整的可操作消息，重写只会让它更含糊。
      assert.match(error.message, /找不到音源实例「src_gone」/)
      assert.match(error.message, /重新匹配/)
      return true
    }
  )

  assert.equal(sourceEngine.calls.length, 0, '静默兜底到另一个音源会让用户以为原音源还在用')
})

test('音源在线但不支持该能力时归因为 unsupported，LX 引擎仍不被调用', async () => {
  const engine = fakeEngine([{ providerId: 'src_a', name: '甲音源', capabilities: ['getLyric'], answers: {} }])
  const sourceEngine = fakeSourceEngine({ musicUrl: { url: 'https://lx.example/1.mp3', quality: '128k' } })
  const { router } = routerFor({ engine, sourceEngine })

  await assert.rejects(
    () => router.musicUrl(track('tx_1', { providerId: 'src_a' }), '320k'),
    (error) => {
      assert.equal(error.reason, 'unsupported')
      assert.match(error.message, /不支持该能力/)
      return true
    }
  )
  assert.equal(sourceEngine.calls.length, 0)
})

test('音源请求失败时归因为 failed/playerDead，且错误码映射保留', async () => {
  const engine = fakeEngine([
    { providerId: 'src_a', name: '甲音源', capabilities: ['getMusicUrl'], answers: { getMusicUrl: { __fail: '音源「甲音源」已停止', __code: 'internal' } } }
  ])
  const { router } = routerFor({ engine })

  await assert.rejects(
    () => router.musicUrl(track('tx_1', { providerId: 'src_a' }), '320k'),
    (error) => {
      assert.equal(error.reason, 'providerDead')
      assert.match(error.message, /已停止/)
      return true
    }
  )
})

/* ------------------------------------------------------------------ *
 * 播放地址形状
 * ------------------------------------------------------------------ */

test('音源返回空列表时报 notFound，而不是把空 URL 交给播放器', async () => {
  const engine = fakeEngine([
    { providerId: 'src_a', name: '甲音源', capabilities: ['getMusicUrl'], answers: { getMusicUrl: { list: [] } } }
  ])
  const { router } = routerFor({ engine })

  await assert.rejects(
    () => router.musicUrl(track('tx_1', { providerId: 'src_a' }), '320k'),
    (error) => {
      assert.equal(error.reason, 'notFound')
      assert.match(error.message, /没有返回可用的播放地址/)
      return true
    }
  )
})

test('音源既给 list 也给顶层 url 时，以 list 首行优先', async () => {
  const engine = fakeEngine([
    {
      providerId: 'src_a',
      name: '甲音源',
      capabilities: ['getMusicUrl'],
      answers: { getMusicUrl: { list: [{ url: 'https://a.example/list.mp3' }], url: 'https://a.example/top.mp3' } }
    }
  ])
  const { router } = routerFor({ engine })

  const result = await router.musicUrl(track('tx_1', { providerId: 'src_a' }), '320k')
  assert.equal(result.url, 'https://a.example/list.mp3')
})

test('音源给出的质量优先于请求的质量', async () => {
  const engine = fakeEngine([
    {
      providerId: 'src_a',
      name: '甲音源',
      capabilities: ['getMusicUrl'],
      answers: { getMusicUrl: { list: [{ url: 'https://a.example/1.mp3' }], quality: '128k' } }
    }
  ])
  const { router } = routerFor({ engine })

  const result = await router.musicUrl(track('tx_1', { providerId: 'src_a' }), '320k')
  assert.equal(result.quality, '128k', '音源实际给了什么质量就报什么，不能把请求的质量当作答案')
})

/* ------------------------------------------------------------------ *
 * 歌词与封面：空答案是正常的，音源缺失不是
 * ------------------------------------------------------------------ */

test('歌词走音源；音源没有歌词时返回空串而不是报错', async () => {
  const engine = fakeEngine([
    { providerId: 'src_a', name: '甲音源', capabilities: ['getLyric'], answers: { getLyric: { lyric: '第一行' } } }
  ])
  const { router } = routerFor({ engine })

  const withLyric = await router.lyric(track('tx_1', { providerId: 'src_a' }))
  assert.equal(withLyric.lyric, '第一行')

  const engine2 = fakeEngine([
    { providerId: 'src_b', name: '乙音源', capabilities: ['getLyric'], answers: { getLyric: {} } }
  ])
  const { router: router2 } = routerFor({ engine: engine2 })
  const empty = await router2.lyric(track('tx_1', { providerId: 'src_b' }))
  assert.equal(empty.lyric, '', '很多真实曲目没有歌词，空答案不是失败')
})

test('旧曲目的歌词仍走 LX 引擎', async () => {
  const sourceEngine = fakeSourceEngine({ lyric: { lyric: '旧路径歌词' } })
  const { router } = routerFor({ sourceEngine })

  const result = await router.lyric(track('tx_old'))
  assert.equal(result.lyric, '旧路径歌词')
  assert.equal(sourceEngine.calls[0].method, 'getLyric')
})

test('封面：音源没给封面时返回空串，但音源缺失仍然报错', async () => {
  const engine = fakeEngine([
    { providerId: 'src_a', name: '甲音源', capabilities: ['getPic'], answers: { getPic: {} } }
  ])
  const { router } = routerFor({ engine })
  assert.equal(await router.pic(track('tx_1', { providerId: 'src_a' })), '')

  const { router: router2 } = routerFor({ engine: fakeEngine() })
  await assert.rejects(
    () => router2.pic(track('tx_1', { providerId: 'src_gone' })),
    (error) => {
      assert.equal(error.reason, 'providerMissing')
      return true
    }
  )
})

/* ------------------------------------------------------------------ *
 * 能力查询：一个"这曲目能不能做 X"的问题只能有一个答案
 * ------------------------------------------------------------------ */

test('supports 对带戳曲目问音源，对旧曲目问 LX 引擎', () => {
  const engine = fakeEngine([{ providerId: 'src_a', name: '甲音源', capabilities: ['getMusicUrl', 'getLyric'] }])
  const sourceEngine = fakeSourceEngine({ supports: ['tx:musicUrl'] })
  const { router } = routerFor({ engine, sourceEngine })

  assert.equal(router.supports(track('tx_1', { providerId: 'src_a' }), 'getMusicUrl'), true)
  assert.equal(router.supports(track('tx_1', { providerId: 'src_a' }), 'getPic'), false)

  assert.equal(router.supports(track('tx_old'), 'getMusicUrl'), true)
  assert.equal(router.supports(track('tx_old'), 'getLyric'), false)
})

test('supports 对旧曲目问搜索类能力时返回 false，而不是假装可以', () => {
  const sourceEngine = fakeSourceEngine({ supports: ['tx:musicUrl', 'tx:lyric', 'tx:pic'] })
  const { router } = routerFor({ sourceEngine })

  // 搜索/热词/歌单/榜单从来不是 LX 动作，旧路径无从回答。
  for (const capability of ['searchTracks', 'getHotWords', 'getPlaylist', 'getLeaderboard']) {
    assert.equal(router.supports(track('tx_old'), capability), false, `${capability} 不是 LX 动作`)
  }
})

test('ownerOf 报出归属，供下载器与界面记录是谁服务的', () => {
  const { router } = routerFor({})
  assert.equal(router.ownerOf(track('tx_1', { providerId: 'src_a' })), 'src_a')
  assert.equal(router.ownerOf(track('tx_old')), null)
})
