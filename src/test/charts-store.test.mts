import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createPinia, setActivePinia } from 'pinia'
import { useChartsStore } from './renderer/stores/charts.js'
const board = source => ({ source, id: '1', name: `${source} board` })
const page = (source, number, period = 'v1') => ({ data: { source, id: '1', period, page: number, tracks: Array.from({ length: 20 }, (_, i) => ({ id: `${source}_${(number-1)*20+i}`, source, name: 'Fixture', singer: '', meta: { songmid: String((number-1)*20+i) } })), total: 60, hasMore: number < 3, truncated: false, partial: false }, cacheState: 'fresh' })
function setup() { setActivePinia(createPinia()); globalThis.window = { jj: { music: { cancel() {} }, charts: { list: async source => ({ data: [board(source)], cacheState: 'fresh' }), tracks: async (source, id, n) => page(source, n) } } }; return useChartsStore() }
test('platform switching preserves independent loaded pages and requires explicit load more', async () => {
  const store = setup()
  await store.open('wy'); await store.choose(board('wy'))
  assert.equal(store.tracks.length, 20)
  await store.loadMore(); assert.equal(store.tracks.length, 40)
  await store.open('tx'); await store.choose(board('tx'))
  assert.equal(store.tracks.length, 20); assert.equal(store.tracks[0].source, 'tx')
  await store.open('wy'); assert.equal(store.tracks.length, 40)
})
test('late platform results cannot overwrite a newer selection', async () => {
  const store = setup(); let release
  window.jj.charts.list = source => source === 'wy' ? new Promise(resolve => { release = resolve }) : Promise.resolve({ data: [board(source)], cacheState: 'fresh' })
  const first = store.open('wy'); await store.open('tx')
  release({ data: [board('wy')], cacheState: 'fresh' }); await first
  assert.equal(store.source, 'tx'); assert.equal(store.current.boards[0].source, 'tx')
})
test('page failure and period change preserve existing rows; refresh starts a new snapshot', async () => {
  const store = setup(); await store.open('wy'); await store.choose(board('wy'))
  window.jj.charts.tracks = async () => { throw Error('offline') }
  await store.loadMore(); assert.equal(store.tracks.length, 20); assert.match(store.current.message, /offline/)
  window.jj.charts.tracks = async (source, id, n) => ({ ...page(source, n, 'v2'), data: { ...page(source, n, 'v2').data, periodChanged: true, tracks: [] } })
  await store.retry(); assert.equal(store.tracks.length, 20); assert.equal(store.current.periodChanged, true)
  window.jj.charts.tracks = async (source, id, n) => page(source, n, 'v2')
  await store.refreshTracks(); assert.equal(store.tracks.length, 20); assert.equal(store.current.period, 'v2')
})
test('a later complete page cannot hide an earlier partial page or its retry action', async () => {
  const store = setup(); let complete = false
  window.jj.charts.tracks = async (source, id, n) => {
    const value = page(source, n)
    if (n === 1 && !complete) { value.data.partial = true; value.data.tracks = value.data.tracks.slice(0, 1) }
    return value
  }
  await store.open('wy'); await store.choose(board('wy')); await store.loadMore()
  assert.equal(store.tracks.length, 21)
  assert.equal(store.current.failedPage, 1)
  assert.ok(store.current.message, 'an earlier gap must remain visible')
  complete = true; await store.retry()
  assert.equal(store.tracks.length, 40, 'retrying page 1 must preserve the already loaded page 2')
  assert.equal(store.current.failedPage, 0)
})

test('new platforms including Migu own independent loaded pages', async () => {
  const store=setup()
  await store.open('kg');await store.choose(board('kg'));await store.loadMore()
  await store.open('kw');await store.choose(board('kw'));assert.equal(store.tracks.length,20)
  await store.open('kg');assert.equal(store.tracks.length,40)
  await store.open('mg');await store.choose(board('mg'));assert.equal(store.tracks.length,20);assert.equal(store.tracks[0].source,'mg');await store.open('kg');assert.equal(store.tracks.length,40)
})
