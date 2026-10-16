import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, readFile, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { OnlineAssetCache } from './online/online-asset-cache.js'

const DAY = 86400_000
const identity = { platform: 'wy', capability: 'lyrics', identity: '123', adapterRevision: 'wy-1' }
const png = () => ({ data: Uint8Array.from([137,80,78,71,13,10,26,10,0,0,0,0]), mimeType: 'image/png' })
const tick = () => new Promise(r => setImmediate(r))
test('lyrics persist, expire at 30/180 days and failed refresh retains safe stale value', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'jj-online-assets-')); let now = 1000, calls = 0
  const cache = new OnlineAssetCache({ dataDir: dir, now: () => now }); await cache.load()
  const get = (c, work) => c.lyric(identity, work)
  assert.equal((await get(cache, async () => { calls++; return { lyric: '[00:01]old', token: 'private' } })).cacheState, 'fresh')
  await cache.flush()
  const text = await readFile(join(dir, 'cache/online/v1/lyrics.json'), 'utf8')
  assert.equal(text.includes('private'), false)
  const restored = new OnlineAssetCache({ dataDir: dir, now: () => now }); await restored.load()
  assert.equal((await get(restored, async () => { calls++; return { lyric: 'wrong' } })).data.lyric, '[00:01]old')
  assert.equal(calls, 1)
  now += 31 * DAY
  const stale = await get(restored, async () => { throw new SyntaxError('token=private') })
  assert.equal(stale.cacheState, 'stale'); assert.equal(stale.data.lyric, '[00:01]old'); assert.equal(stale.error.code, 'schemaChanged')
  now += 150 * DAY
  assert.equal((await get(restored, async () => { throw new Error() })).data, undefined)
})
test('near-quota persisted lyrics remain below the actual file limit and survive restart', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'jj-lyric-capacity-'))
  const c = new OnlineAssetCache({ dataDir: dir, lyricMaxBytes: 4096 }); await c.load()
  for (let i = 0; i < 30; i++) await c.lyric({ ...identity, identity: `id-${i}` }, async () => ({ lyric: 'x'.repeat(120) }))
  await c.flush()
  const text = await readFile(join(dir, 'cache/online/v1/lyrics.json'), 'utf8')
  assert.ok(Buffer.byteLength(text) <= 4096, `actual persisted bytes ${Buffer.byteLength(text)}`)
  const restored = new OnlineAssetCache({ dataDir: dir, lyricMaxBytes: 4096 }); await restored.load()
  let calls = 0
  assert.equal((await restored.lyric({ ...identity, identity: 'id-29' }, async () => { calls++; return { lyric: 'wrong' } })).data.lyric, 'x'.repeat(120))
  assert.equal(calls, 0)
})
test('empty, HTML, binary and oversized lyrics never overwrite successful lyrics', async () => {
  const c = new OnlineAssetCache()
  await c.lyric(identity, async () => ({ lyric: 'old' }))
  for (const lyric of ['', '<html>gateway</html>', '\u0000bad', 'x'.repeat(2*1024*1024+1)]) {
    const value = await c.lyric(identity, async () => ({ lyric }), { force: true })
    assert.equal(value.data.lyric, 'old'); assert.ok(value.error)
  }
})
test('versions, no-online reads, independent cancellation and invalidated late results', async () => {
  const c = new OnlineAssetCache(); let release, signal, calls = 0, current = true
  const loader = s => { signal = s; calls++; return new Promise(r => { release = r }) }
  const a = new AbortController(), b = new AbortController()
  const pa = c.lyric(identity, loader, { signal: a.signal, isCurrent: () => current })
  const pb = c.lyric(identity, loader, { signal: b.signal, isCurrent: () => current })
  await tick(); a.abort(); await assert.rejects(pa); assert.equal(signal.aborted, false)
  current = false; release({ lyric: 'old' }); assert.equal((await pb).data, undefined)
  current = true
  assert.equal((await c.lyric({ ...identity, adapterRevision: 'wy-2' }, async () => ({ lyric: 'new' }))).data.lyric, 'new')
  const denied = await c.lyric({ ...identity, identity: 'offline' }, async () => { calls++; return { lyric: 'network' } }, { allowNetwork: false })
  assert.equal(denied.data, undefined); assert.equal(calls, 1)
})
test('one cancelled subscriber cannot turn the remaining shared lyric into failure', async () => {
  const c = new OnlineAssetCache(), a = new AbortController(), b = new AbortController(); let release
  const loader = () => new Promise(r => { release = r })
  const first = c.lyric(identity, loader, { signal: a.signal })
  const second = c.lyric(identity, loader, { signal: b.signal })
  await tick(); a.abort(); await assert.rejects(first)
  release({ lyric: 'shared' }); assert.equal((await second).data.lyric, 'shared')
})
test('opt-out fetches without using or persisting the former fresh cache; offline issues no work', async () => {
  let enabled = true, calls = 0
  const c = new OnlineAssetCache({ enabled: () => enabled })
  await c.lyric(identity, async () => ({ lyric: 'old' }))
  enabled = false
  assert.equal((await c.lyric(identity, async () => { calls++; return { lyric: 'uncached' } })).data.lyric, 'uncached')
  assert.equal((await c.lyric(identity, async () => { calls++; return { lyric: 'none' } }, { allowNetwork: false })).data, undefined)
  enabled = true
  assert.equal((await c.lyric(identity, async () => { calls++; return { lyric: 'wrong' } })).data.lyric, 'old')
  assert.equal(calls, 1)
})
test('cover cache stores binary outside JSON, validates bytes, and never clears saved/user/pending resources', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'jj-cover-cache-')), c = new OnlineAssetCache({ dataDir: dir }); await c.load()
  await mkdir(join(dir, 'library/covers'), { recursive: true })
  const saved = join(dir, 'library/covers/manual.png'), pending = join(dir, 'library/pending-assets.json')
  await writeFile(saved, png().data); await writeFile(pending, '{"user":"pending"}')
  let calls = 0
  const coverIdentity = { ...identity, capability: 'cover', identity: 'cover-1' }
  assert.deepEqual((await c.cover(coverIdentity, async () => { calls++; return png() })).data.data, png().data)
  await c.flush()
  const restored = new OnlineAssetCache({ dataDir: dir }); await restored.load()
  assert.deepEqual((await restored.cover(coverIdentity, async () => { calls++; return png() })).data.data, png().data)
  assert.equal(calls, 1)
  const bad = await restored.cover(coverIdentity, async () => ({ data: new TextEncoder().encode('<html>error</html>'), mimeType: 'image/png' }), { force: true })
  assert.deepEqual(bad.data.data, png().data); assert.ok(bad.error)
  assert.equal((await readFile(join(dir, 'cache/online/v1/covers.json'), 'utf8')).includes('137,80,78'), false)
  await restored.clear(); await restored.flush()
  assert.deepEqual(new Uint8Array(await readFile(saved)), png().data); assert.match(await readFile(pending, 'utf8'), /pending/)
})
test('cover eviction removes only owned hashes and corruption rebuilds instead of serving invalid bytes', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'jj-cover-lru-'))
  const c = new OnlineAssetCache({ dataDir: dir, coverMaxBytes: 24 }); await c.load()
  const one = png(), two = png(), three = png(); two.data[11]=2; three.data[11]=3
  const id = n => ({ ...identity, capability: 'cover', identity: `cover-${n}` })
  await c.cover(id(1), async () => one); await c.cover(id(2), async () => two)
  await c.cover(id(1), async () => { throw new Error('should hit') })
  await c.cover(id(3), async () => three); await c.flush()
  let calls = 0
  assert.deepEqual((await c.cover(id(2), async () => { calls++; return two })).data.data, two.data)
  assert.equal(calls, 1)
})
