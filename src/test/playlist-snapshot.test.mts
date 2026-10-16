import assert from 'node:assert/strict'
import { test } from 'node:test'
import { importPlaylist } from './online/playlist-import.js'
import { LibraryRouter } from './online/library-router.js'
import { OnlinePlatformRegistry } from './online/platform-registry.js'
import { ResourceCache } from './online/resource-cache.js'
const response = body => new Response(JSON.stringify(body))
test('legal empty playlist is distinguishable from missing/malformed required rows', async () => {
  const empty = await importPlaylist('wy', '123', async () => response({ code: 200, playlist: { name: 'Empty', tracks: [], trackIds: [], trackCount: 0 } }))
  assert.equal(empty.complete, true); assert.deepEqual(empty.tracks, []); assert.equal(empty.total, 0)
  await assert.rejects(importPlaylist('tx', '123', async () => response({ code: 0, cdlist: [{ dissname: 'broken', total_song_num: 0 }] })))
})
test('missing details, invalid rows, duplicate pages and declared count gaps are not complete snapshots', async () => {
  const partial = await importPlaylist('wy', '123', async url => url.includes('/api/song/detail') ? response({ songs: [] }) : response({ code: 200, playlist: { name: 'Partial', tracks: [{ id: 1, name: 'Song' }], trackIds: [{ id: 1 }, { id: 2 }], trackCount: 2 } }))
  assert.equal(partial.complete, false)
  const duplicate = await importPlaylist('kw', '123', async () => response({ result: 'ok', title: 'Repeated', total: 2, musiclist: [{ id: 1, name: 'Song' }] }))
  assert.equal(duplicate.complete, false)
})
test('cancellation and intent budget bound even a fake fetch that ignores its signal', async () => {
  const c = new AbortController(); c.abort(); let calls = 0
  await assert.rejects(importPlaylist('wy', '123', async () => { calls++; return response({}) }, () => {}, { signal: c.signal }))
  assert.equal(calls, 0)
  await assert.rejects(importPlaylist('wy', '123', () => new Promise(() => {}), () => {}, { budgetMs: 10 }))
})
test('non-paged snapshots require total evidence and WY detail identities must match the declared set', async () => {
  const row = id => ({ id, name: `Song ${id}` })
  const mismatch = await importPlaylist('wy', '123', async url => response(url.includes('/api/song/detail')
    ? { songs: [row(3)] }
    : { code: 200, playlist: { tracks: [row(1)], trackIds: [{ id: 1 }, { id: 2 }], trackCount: 2 } }))
  assert.equal(mismatch.complete, false, 'matching counts cannot prove matching membership')
  const missingTotal = await importPlaylist('tx', '123', async () => response({ code: 0, cdlist: [{ songlist: [{ mid: 'one', title: 'One' }] }] }))
  assert.equal(missingTotal.complete, false, 'a truncated non-paged response must not self-certify')
  const missingWyTotal = await importPlaylist('wy', '123', async () => response({ code: 200, playlist: { tracks: [row(1)] } }))
  assert.equal(missingWyTotal.complete, false)
})
test('remote snapshot cache keeps complete success on failure and never stores partial as complete', async () => {
  let now = 1000, calls = 0, mode = 'good'
  const registry = new OnlinePlatformRegistry({ sourcesByScript: () => [], isScriptEnabled: () => false })
  const router = new LibraryRouter({ registry, cache: new ResourceCache({ now: () => now }), importBuiltin: async () => {
    calls++; if (mode === 'fail') throw new SyntaxError('private')
    return { name: 'Remote', source: 'wy', sourceListId: '123', complete: mode !== 'partial', tracks: [{ id: 'wy_1', source: 'wy', name: 'One', singer: '', meta: { songmid: '1' } }], total: 1, warnings: [] }
  } })
  await router.readSnapshot('wy', '123'); await router.readSnapshot('wy', '123'); assert.equal(calls, 1)
  now += 31 * 60_000; mode = 'fail'
  const stale = await router.readSnapshot('wy', '123')
  assert.equal(stale.cacheState, 'stale'); assert.equal(stale.data.tracks.length, 1); assert.equal(stale.error.code, 'schemaChanged')
  mode = 'partial'; const part = await router.readSnapshot('wy', '123', undefined, true)
  assert.equal(part.partial, true)
  mode = 'fail'; assert.equal((await router.readSnapshot('wy', '123', undefined, true)).data.complete, true)
})
test('cache opt-out still permits complete explicit refresh without retaining snapshots', async () => {
  let calls = 0
  const registry = new OnlinePlatformRegistry({ sourcesByScript: () => [], isScriptEnabled: () => false })
  const router = new LibraryRouter({ registry, enabled: () => false, importBuiltin: async () => {
    calls++; return { name: 'Empty', source: 'wy', sourceListId: '123', tracks: [], total: 0, complete: true, warnings: [] }
  } })
  assert.equal((await router.readSnapshot('wy', '123')).partial, false)
  assert.equal((await router.readSnapshot('wy', '123')).partial, false)
  assert.equal(calls, 2)
})
