import assert from 'node:assert/strict'
import { test } from 'node:test'
import { HotWordSource } from './online/hot-words.js'
import { OnlinePlatformRegistry } from './online/platform-registry.js'
import { SearchRouter } from './online/search-router.js'

const track = (source, id, name = id) => ({ id, name, singer: '歌手', source, interval: '03:00' })

function registry(platforms = []) {
  return new OnlinePlatformRegistry({
    sourcesByScript: () => platforms.map(id => ({
      apiId: `${id}-api`,
      sources: [{ id, name: id, actions: ['musicUrl'], qualitys: ['128k'] }]
    })),
    isScriptEnabled: () => true
  })
}

function hotWords() {
  const calls = []
  const source = new HotWordSource(async (url) => {
    calls.push(url)
    return JSON.stringify({ status: 'ok', tagvalue: [{ key: '今日热词' }, { key: '另一个热词' }] })
  })
  return { calls, source }
}

test('unsupported platforms cannot issue search or hot word requests', async () => {
  const hot = hotWords()
  const searchCalls = []
  const router = new SearchRouter({
    hotWords: hot.source,
    registry: registry(['kw']),
    searchOne: async (...args) => { searchCalls.push(args); return { list: [], total: 0 } }
  })

  const page = await router.search('missing', '测试')
  const words = await router.hotWords('mg')

  assert.equal(page.servedBy, 'none')
  assert.equal(page.reason, 'noProvider')
  assert.match(page.message ?? '', /未提供在线搜索服务/)
  assert.deepEqual(words.words, [])
  assert.equal(words.servedBy, 'none')
  assert.deepEqual(router.searchablePlatforms(), ['tx', 'wy', 'kw', 'kg', 'mg'])
  assert.deepEqual(searchCalls, [])
  assert.deepEqual(hot.calls, [])
})

test('a platform search trims the keyword while tabs come from app directory adapters', async () => {
  const hot = hotWords()
  const calls = []
  const router = new SearchRouter({
    hotWords: hot.source,
    registry: registry(['kw']),
    searchOne: async (...args) => { calls.push(args); return { list: [track('kw', 'kw_1')], total: 1, allPage: 3 } }
  })
  const signal = new AbortController().signal

  const page = await router.search('kw', '  测试  ', 3, signal)

  assert.equal(page.servedBy, 'builtin')
  assert.deepEqual(page.list.map((item) => item.id), ['kw_1'])
  assert.deepEqual(calls, [['kw', '测试', 3, signal]])
  assert.deepEqual(router.searchablePlatforms(), ['tx', 'wy', 'kw', 'kg', 'mg'])
})

test('aggregate search calls app directory adapters without requiring matching LX sources', async () => {
  const calls = []
  const router = new SearchRouter({
    hotWords: hotWords().source,
    registry: registry([]),
    searchOne: async (source) => {
      calls.push(source)
      return source === 'tx'
        ? { list: [track('tx', 'tx_1'), track('tx', 'tx_2')], total: 2, allPage: 4 }
        : Promise.reject(new Error('timeout'))
    }
  })

  const page = await router.search('all', '测试', 2)

  assert.equal(page.servedBy, 'builtin')
  assert.deepEqual(page.list.map((item) => item.id), ['tx_1', 'tx_2'])
  assert.equal(page.total, 2)
  assert.equal(page.allPage, 4)
  assert.deepEqual(calls, ['tx', 'wy', 'kw', 'kg', 'mg'])
  assert.deepEqual(page.failed, ['wy', 'kw', 'kg', 'mg'].map(source => ({ source, error: 'timeout' })))
})

test('consented directory search works when no playback source is installed', async () => {
  const calls = []
  const router = new SearchRouter({
    hotWords: hotWords().source,
    registry: registry([], true),
    searchOne: async source => {
      calls.push(source)
      return { list: [track(source, `${source}_1`)], total: 1, allPage: 1 }
    }
  })

  const page = await router.search('all', '曲名')
  assert.equal(page.servedBy, 'builtin')
  assert.equal(page.list.length, 5)
  assert.deepEqual(calls, ['tx', 'wy', 'kw', 'kg', 'mg'])
})

test('aggregate with no results and failures returns an actionable unavailable state', async () => {
  const router = new SearchRouter({
    hotWords: hotWords().source,
    registry: registry(['tx']),
    searchOne: async () => { throw new Error('connection refused') }
  })

  const page = await router.search('all', '测试')

  assert.equal(page.servedBy, 'none')
  assert.equal(page.reason, 'builtinFailed')
  assert.match(page.message ?? '', /tx.*connection refused/)
})

test('aggregate hot words use app adapters that publish hot words', async () => {
  const hot = hotWords()
  const router = new SearchRouter({ hotWords: hot.source, registry: registry(['kw', 'mg']) })

  const result = await router.hotWords('all')

  assert.equal(result.servedBy, 'builtin')
  assert.deepEqual(result.words.map((word) => word.text), ['今日热词', '另一个热词'])
  assert.equal(hot.calls.length, 4)
  assert.ok(hot.calls.some(url => /kuwo/.test(url)))
})

test('local and blank searches do not issue online adapter calls', async () => {
  const hot = hotWords()
  const calls = []
  const router = new SearchRouter({
    hotWords: hot.source,
    registry: registry(['kw']),
    searchOne: async (...args) => { calls.push(args); return { list: [] } }
  })

  const local = await router.search('local', '曲目')
  const blank = await router.search('kw', '   ')

  assert.equal(local.servedBy, 'none')
  assert.equal(blank.servedBy, 'none')
  assert.deepEqual(calls, [])
})
