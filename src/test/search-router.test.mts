import assert from 'node:assert/strict'
import { test } from 'node:test'
import { HotWordSource } from './online/hot-words.js'
import { SearchRouter } from './online/search-router.js'

const track = (source, id, name = id) => ({
  id,
  name,
  singer: '歌手',
  source,
  interval: '03:00'
})

function hotWords() {
  const calls = []
  const source = new HotWordSource(async (url) => {
    calls.push(url)
    return JSON.stringify({ data: { hotkey: [{ k: '今日热词' }, { k: '另一个热词' }] } })
  })
  return { calls, source }
}

test('global gate closed means search, hot words, and platform tabs stay unavailable', async () => {
  const hot = hotWords()
  const searchCalls = []
  const router = new SearchRouter({
    hotWords: hot.source,
    allowBuiltin: () => false,
    searchOne: async (...args) => {
      searchCalls.push(args)
      return { list: [], total: 0 }
    }
  })

  const page = await router.search('tx', '测试')
  const words = await router.hotWords('tx')

  assert.equal(page.servedBy, 'none')
  assert.equal(page.reason, 'noProvider')
  assert.match(page.message ?? '', /不可用/)
  assert.deepEqual(words.words, [])
  assert.equal(words.servedBy, 'none')
  assert.deepEqual(router.searchablePlatforms(), [])
  assert.deepEqual(searchCalls, [])
  assert.deepEqual(hot.calls, [])
})

test('enabled single-platform search uses the built-in adapter and trims the keyword', async () => {
  const hot = hotWords()
  const calls = []
  const router = new SearchRouter({
    hotWords: hot.source,
    allowBuiltin: () => true,
    searchOne: async (...args) => {
      calls.push(args)
      return { list: [track('tx', 'tx_1')], total: 1, allPage: 3 }
    }
  })
  const signal = new AbortController().signal

  const page = await router.search('tx', '  测试  ', 2, signal)

  assert.equal(page.servedBy, 'builtin')
  assert.deepEqual(page.list.map((item) => item.id), ['tx_1'])
  assert.deepEqual(calls, [['tx', '测试', 2, signal]])
  assert.deepEqual(router.searchablePlatforms().sort(), ['kg', 'kw', 'mg', 'tx', 'wy'])
})

test('aggregate search interleaves platform rows and reports partial failures', async () => {
  const hot = hotWords()
  const router = new SearchRouter({
    hotWords: hot.source,
    allowBuiltin: () => true,
    searchEverywhere: async () => [
      { source: 'tx', list: [track('tx', 'tx_1'), track('tx', 'tx_2')], total: 2, allPage: 4 },
      { source: 'wy', list: [track('wy', 'wy_1')], total: 1, error: 'timeout' }
    ]
  })

  const page = await router.search('all', '测试', 2)

  assert.equal(page.servedBy, 'builtin')
  assert.deepEqual(page.list.map((item) => item.id), ['tx_1', 'wy_1', 'tx_2'])
  assert.equal(page.total, 3)
  assert.equal(page.allPage, 4)
  assert.deepEqual(page.failed, [{ source: 'wy', error: 'timeout' }])
})

test('aggregate with no results and failures returns an actionable unavailable state', async () => {
  const hot = hotWords()
  const router = new SearchRouter({
    hotWords: hot.source,
    allowBuiltin: () => true,
    searchEverywhere: async () => [{ source: 'tx', list: [], error: 'connection refused' }]
  })

  const page = await router.search('all', '测试')

  assert.equal(page.servedBy, 'none')
  assert.equal(page.reason, 'builtinFailed')
  assert.match(page.message ?? '', /tx.*connection refused/)
})

test('hot words are read from the built-in cache only when the gate is open', async () => {
  const hot = hotWords()
  const router = new SearchRouter({ hotWords: hot.source, allowBuiltin: () => true })

  const result = await router.hotWords('tx')

  assert.equal(result.servedBy, 'builtin')
  assert.deepEqual(result.words.map((word) => word.text), ['今日热词', '另一个热词'])
  assert.equal(hot.calls.length, 1)
})

test('local and blank searches do not issue online adapter calls', async () => {
  const hot = hotWords()
  const calls = []
  const router = new SearchRouter({
    hotWords: hot.source,
    allowBuiltin: () => true,
    searchOne: async (...args) => {
      calls.push(args)
      return { list: [] }
    }
  })

  const local = await router.search('local', '曲目')
  const blank = await router.search('tx', '   ')

  assert.equal(local.servedBy, 'none')
  assert.equal(blank.servedBy, 'none')
  assert.deepEqual(calls, [])
})
