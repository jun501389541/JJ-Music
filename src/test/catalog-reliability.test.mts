import assert from 'node:assert/strict'
import { test } from 'node:test'
import { CatalogReliability } from './online/catalog-reliability.js'
import { CapabilityHealth } from './online/capability-health.js'
import { OnlineDiagnostics } from './online/online-diagnostics.js'
import { ResourceCache } from './online/resource-cache.js'
import { SearchRouter } from './online/search-router.js'
import { OnlineEntityDetails } from './online/entity-details.js'
import { HotWordSource } from './online/hot-words.js'
import { OnlinePlatformRegistry } from './online/platform-registry.js'
import { searchOnline } from './online/search.js'
const registry = () => new OnlinePlatformRegistry({ sourcesByScript: () => [], isScriptEnabled: () => false })
const track = { id: 'wy_1', name: 'sample', singer: 'artist', source: 'wy', meta: { songmid: '1', qualitys: [] } }
test('HTTP 200 error envelopes and malformed required rows fail rather than caching empty success', async () => {
  const original = globalThis.fetch
  try {
    for (const [source, payload] of [['tx', { code: 0, data: {} }], ['wy', { code: 200, result: {} }], ['tx', { data: { song: { list: [{}] } } }]]) {
      globalThis.fetch = async () => new Response(JSON.stringify(payload))
      await assert.rejects(searchOnline(source, 'sample'), /格式/)
    }
    for (const [source, payload] of [['tx', { data: { song: { list: [], totalnum: 0 } } }], ['wy', { code: 200, result: { songCount: 0 } }]]) {
      globalThis.fetch = async () => new Response(JSON.stringify(payload))
      assert.deepEqual((await searchOnline(source, 'sample')).list, [])
    }
  } finally { globalThis.fetch = original }
})
test('production router returns stale data with safe failure and platform state', async () => {
  let now = 1000, fail = false, calls = 0
  const diagnostics = new OnlineDiagnostics()
  const reliability = new CatalogReliability({ searchCache: new ResourceCache({ now: () => now }), diagnostics })
  const router = new SearchRouter({ registry: registry(), hotWords: new HotWordSource(async () => '{}'), reliability,
    searchOne: async source => { calls++; if (fail) throw new SyntaxError('private'); return { list: [{ ...track, source }], total: 1, allPage: 1 } } })
  for (const platform of ['wy', 'tx']) {
    assert.equal((await router.search(platform, 'private')).reliability.cacheState, 'fresh')
    assert.equal((await router.search(platform, 'private')).list.length, 1)
  }
  assert.equal(calls, 2)
  now += 6 * 60_000; fail = true
  const stale = await router.search('wy', 'private')
  assert.equal(stale.list.length, 1); assert.equal(stale.reliability.cacheState, 'stale')
  assert.equal(stale.reliability.error.code, 'schemaChanged'); assert.match(stale.message, /较旧/)
  assert.equal(JSON.stringify(diagnostics.export()).includes('private'), false)
  const firstFailure = await router.search('tx', 'other')
  assert.equal(firstFailure.servedBy, 'none'); assert.equal(firstFailure.reliability.cacheState, 'miss')
})
test('entity snapshot survives failure/restart and access gating precedes cached read', async () => {
  let stored, now = 1000, fail = false, allowed = true
  const makeCache = () => new ResourceCache({ now: () => now, read: async () => stored, write: async v => { stored = v } })
  const cache = makeCache()
  const reliability = new CatalogReliability({ detailCache: cache })
  const options = { reliability, allows: () => allowed, searchTracks: async () => ({ list: [] }),
    fetchText: async () => { if (fail) throw new SyntaxError('private'); return JSON.stringify({ code: 200, artist: { id: 7, name: 'Artist' }, songs: [{ id: 1, name: 'sample', ar: [{ id: 7, name: 'Artist' }] }], total: 1, more: false }) } }
  const detail = new OnlineEntityDetails(options)
  assert.equal((await detail.artistPage('wy', '7')).status, 'available')
  await cache.flush(); assert.ok(stored.entries.length)
  now += 2 * 60 * 60_000; fail = true
  const restored = makeCache(); await restored.load()
  const newer = new OnlineEntityDetails({ ...options, reliability: new CatalogReliability({ detailCache: restored }) })
  const stale = await newer.artistPage('wy', '7')
  assert.equal(stale.status, 'available'); assert.equal(stale.reliability.cacheState, 'stale'); assert.equal(stale.tracks.length, 1)
  allowed = false
  assert.equal((await newer.artistPage('wy', '7')).status, 'unavailable')
})
test('malformed entity rows retain successful snapshot; limited albums remain displayable but not cached', async () => {
  let now = 1000, malformed = false, writes = 0, albumCalls = 0
  const details = new OnlineEntityDetails({ allows: () => true, searchTracks: async () => ({ list: [] }),
    reliability: new CatalogReliability({ detailCache: new ResourceCache({ now: () => now, write: async () => { writes++ } }) }),
    fetchText: async url => {
      if (url.includes('/album/')) {
        albumCalls++
        return JSON.stringify({ code: 200, album: { id: 9, name: 'Album' }, songs: Array.from({ length: 501 }, (_, i) => ({ id: i + 1, name: `song${i}` })) })
      }
      return JSON.stringify({ code: 200, artist: { id: 7, name: 'Artist' }, songs: malformed ? [{}] : [{ id: 1, name: 'Song', ar: [{ id: 7, name: 'Artist' }] }], total: 1, more: false })
    } })
  assert.equal((await details.artistPage('wy', '7')).tracks.length, 1)
  now += 2 * 60 * 60_000; malformed = true
  const stale = await details.artistPage('wy', '7')
  assert.equal(stale.tracks.length, 1); assert.equal(stale.reliability.error.code, 'schemaChanged')
  const album = await details.albumPage('wy', '9')
  assert.equal(album.status, 'available'); assert.equal(album.truncated, true); assert.equal(album.tracks.length, 20)
  await details.albumPage('wy', '9'); assert.equal(albumCalls, 2)
})
test('real HTTP boundary preserves 429 wait evidence without treating ordinary 403 as expiry', async () => {
  const original = globalThis.fetch
  try {
    let now=0
    const r = new CatalogReliability({health:new CapabilityHealth({now:()=>now})})
    globalThis.fetch = async () => new Response('{}', { status: 429, headers: { 'Retry-After': '60' } })
    const limited = await r.search('tx', 'test', 1, signal => searchOnline('tx', 'test', 1, signal))
    assert.equal(limited.error.code, 'rateLimited'); assert.equal(limited.error.httpStatus, 429); assert.equal(limited.error.retryAfterMs, 60_000)
    // A different query cannot bypass the same capability's service wait.
    const waiting=await r.search('tx','waiting',1,()=>{throw Error('must not run while rate limited')})
    assert.equal(waiting.error.code,'rateLimited')
    now+=60_000
    globalThis.fetch = async () => new Response('{}', { status: 403 })
    const denied = await r.search('tx', 'other', 1, signal => searchOnline('tx', 'other', 1, signal))
    assert.equal(denied.error.code, 'unknown'); assert.equal(denied.error.httpStatus, 403)
  } finally { globalThis.fetch = original }
})
test('malformed result never replaces success, revisions and clear invalidate generations', async () => {
  let revision = 'wy-1', calls = 0
  const r = new CatalogReliability({ revision: () => revision })
  const get = (work, force = false) => r.search('wy', 'query', 1, work, undefined, force)
  assert.deepEqual((await get(async () => { calls++; return { list: [] } })).data.list, [])
  revision = 'wy-2'
  const bad = await get(async () => { calls++; return { list: 'invalid' } })
  assert.equal(bad.error.code, 'schemaChanged'); assert.equal(bad.data, undefined)
  assert.equal(calls, 2)
  r.clear()
  assert.equal((await get(async () => ({ list: [] }))).cacheState, 'fresh')
})
