import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createPinia, setActivePinia } from 'pinia'
import { PlaylistSearchAdapter } from './online/playlist-search.js'
import { OnlinePlatformRegistry } from './online/platform-registry.js'
import { usePlaylistSearchStore } from './renderer/stores/playlist-search.js'
const json = data => new Response(JSON.stringify(data))
const row = (id = '7739249772') => ({ dissid: id, dissname: '轻音乐&#32;&#124;&#32;放松&#x5fc3;情', creator: { name: 'Creator&#32;&amp;&#32;Co' }, song_count: 90, imgurl: 'http://qpic.y.qq.com/music_cover/test/300' })
const payload = (rows = [row()], page = 0, total = 56355) => ({ code: 0, subcode: 0, data: { list: rows, page_no: page, num_per_page: 20, sum: total } })

test('QQ uses the observed HTTPS legacy endpoint, full query and headers, native IDs and decoded text', async () => {
  const controller = new AbortController()
  const adapter = new PlaylistSearchAdapter(async (raw, init) => {
    const u = new URL(raw)
    assert.equal(u.origin, 'https://c.y.qq.com')
    assert.equal(u.pathname, '/soso/fcgi-bin/client_music_search_songlist')
    assert.equal(u.searchParams.get('query'), '轻音乐 & #')
    for (const [key, value] of Object.entries({ page_no: '0', num_per_page: '20', format: 'json', remoteplace: 'txt.yqq.playlist', inCharset: 'utf8', outCharset: 'utf-8' })) assert.equal(u.searchParams.get(key), value)
    assert.deepEqual(init.allowedHosts, ['c.y.qq.com'])
    assert.equal(init.signal, controller.signal)
    assert.equal(init.headers.Referer, 'http://y.qq.com/portal/search.html')
    assert.match(init.headers['User-Agent'], /MSIE 9\.0/)
    assert.equal(init.headers.Cookie, undefined)
    return json(payload([row('9007199254740993')]))
  })
  const result = await adapter.search('tx', ' 轻音乐 & # ', 1, controller.signal)
  assert.equal(result.items[0].id, '9007199254740993')
  assert.equal(result.items[0].name, '轻音乐 | 放松心情')
  assert.equal(result.items[0].creator, 'Creator & Co')
  assert.equal(result.items[0].source, 'tx')
  assert.equal(result.items[0].trackCount, 90)
  assert.equal(result.items[0].coverUrl, 'https://qpic.y.qq.com/music_cover/test/300')
})

test('QQ sparse pages use declared page slots, preserve ordering and stop after page10 without extra fetches', async () => {
  let calls = 0
  const adapter = new PlaylistSearchAdapter(async raw => {
    calls++
    const page = Number(new URL(raw).searchParams.get('page_no'))
    return json(payload(Array.from({ length: page === 0 ? 15 : 17 }, (_, i) => row(String(1000 + page * 20 + i))), page))
  })
  const first = await adapter.search('tx', 'x', 1), second = await adapter.search('tx', 'x', 2), last = await adapter.search('tx', 'x', 10)
  assert.equal(first.items.length, 15); assert.equal(first.hasMore, true)
  assert.equal(second.items.length, 17); assert.equal(second.items[0].id, '1020')
  assert.equal(last.hasMore, false); assert.equal(last.truncated, true)
  assert.equal(calls, 3)
})

test('QQ accepts explicit empty data but rejects errors, wrong pagination, unsafe IDs and missing structure', async () => {
  const empty = await new PlaylistSearchAdapter(async () => json(payload([], 0, 0))).search('tx', 'nothing')
  assert.deepEqual(empty.items, []); assert.equal(empty.total, 0); assert.equal(empty.hasMore, false)
  const bad = [
    { ...payload(), code: -3003 }, { ...payload(), subcode: 1 }, { code: 0, data: {} },
    payload([row()], 1), { ...payload(), data: { ...payload().data, num_per_page: 50 } },
    { ...payload(), data: { ...payload().data, sum: undefined } }, payload([], 0, 100),
    payload([row(Number.MAX_SAFE_INTEGER + 1)]), payload([row('1'), row('1')]),
    payload(Array.from({ length: 21 }, (_, i) => row(String(i + 1)))),
    payload([{ ...row(), dissname: '' }]), payload([row()], 0, -1),
  ]
  for (const value of bad) await assert.rejects(new PlaylistSearchAdapter(async () => json(value)).search('tx', 'x'), error => error.failure?.code === 'schemaChanged')
})

test('QQ only admits known artwork hosts; invalid entity codepoints cannot crash text decoding', async () => {
  for (const cover of ['https://127.0.0.1/a', 'https://qq.com/a', 'https://qpic.y.qq.com.evil.test/a', 'https://u:p@qpic.y.qq.com/a']) {
    const result = await new PlaylistSearchAdapter(async () => json(payload([{ ...row(), imgurl: cover, dissname: 'safe&#x110000;' }]))).search('tx', 'x')
    assert.equal(result.items[0].coverUrl, undefined)
    assert.ok(result.items[0].name.startsWith('safe'))
  }
})

test('QQ cancellation never fetches and rate limiting retains Retry-After', async () => {
  let calls = 0; const controller = new AbortController(); controller.abort()
  const adapter = new PlaylistSearchAdapter(async () => { calls++; return json(payload()) })
  await assert.rejects(adapter.search('tx', 'x', 1, controller.signal)); assert.equal(calls, 0)
  await assert.rejects(new PlaylistSearchAdapter(async () => new Response('{}', { status: 429, headers: { 'Retry-After': '30' } })).search('tx', 'x'), error => error.failure?.code === 'rateLimited' && error.failure.retryAfterMs === 30000)
})

test('QQ catalog admission and Pinia search work without LX sources or static unavailable gates', async t => {
  const registry = new OnlinePlatformRegistry({ sourcesByScript: () => [], isScriptEnabled: () => false })
  assert.equal(registry.allows('tx', 'playlistSearch'), true)
  const oldWindow = globalThis.window; t.after(() => { globalThis.window = oldWindow })
  let calls = 0
  globalThis.window = { jj: { music: { cancel() {} }, playlistSearch: { search: async source => {
    assert.equal(source, 'tx'); calls++
    return { data: { source, keyword: 'x', page: 1, items: [{ source, id: '1', name: 'QQ result' }], hasMore: false, truncated: false }, cacheState: 'fresh' }
  } } } }
  setActivePinia(createPinia())
  const store = usePlaylistSearchStore(); await store.open('tx'); store.current.keyword = 'x'; await store.submit()
  assert.equal(calls, 1); assert.equal(store.current.items[0].id, '1'); assert.equal(store.current.error, '')
})