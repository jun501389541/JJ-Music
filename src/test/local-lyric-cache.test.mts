import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { resolveLocalLyric, primeLyricCache, clearLyricCache, clearAutomaticLyricCache, sidecarPathFor } from './library/lyric-service.js'
import { writeTags } from './library/tag-writer.js'

async function fixture(work) {
  const dir = await mkdtemp(join(tmpdir(), 'jj-local-lyric-'))
  const path = join(dir, 'test.mp3')
  const frame = Buffer.alloc(417); frame.set([0xff, 0xfb, 0x90, 0x64])
  await writeFile(path, Buffer.concat(Array.from({ length: 10 }, () => frame)))
  const track = { id: path, path, name: 'Test', singer: 'Artist' }
  try { await work(track) }
  finally { clearLyricCache(track.id); assert.ok(resolve(dir).startsWith(resolve(tmpdir()) + sep)); await rm(dir, { recursive: true, force: true }) }
}
test('automatic online lyric expired timestamp cannot outlive its resource cache', async () => {
  await fixture(async track => {
    primeLyricCache(track.id, { lyric: '[00:01]expired', source: 'online', synchronized: true,
      reliability: { cacheState: 'stale', fetchedAt: 1, expiresAt: 2, staleUntil: 3, servedBy: 'builtin', partial: false } })
    const resolved = await resolveLocalLyric(track, { allowOnline: false })
    assert.equal(resolved.source, 'none')
  })
})
test('pending user choice survives online cache expiration while current local tags still win', async () => {
  await fixture(async track => {
    primeLyricCache(track.id, { lyric: '[00:01]chosen', source: 'online', synchronized: true, asset: { origin: 'remote', pending: true },
      reliability: { cacheState: 'stale', fetchedAt: 1, expiresAt: 2, staleUntil: 3, servedBy: 'builtin', partial: false } })
    assert.equal((await resolveLocalLyric(track, { allowOnline: false })).lyric, '[00:01]chosen')
    assert.equal((await writeTags(track.path, { lyrics: '[00:01]local' })).written, true)
    assert.equal((await resolveLocalLyric(track, { allowOnline: false })).source, 'embedded')
  })
})
test('automatic cache maintenance preserves a pending choice', async () => {
  await fixture(async track => {
    primeLyricCache(track.id, { lyric: '[00:01]chosen', source: 'online', synchronized: true, asset: { origin: 'remote', pending: true } })
    clearAutomaticLyricCache()
    assert.equal((await resolveLocalLyric(track, { allowOnline: false })).lyric, '[00:01]chosen')
  })
})
test('source lifecycle invalidation preserves platform auto lyrics and confirmed pending choices',async()=>{
  for(const kind of ['platform','script','pending'])await fixture(async track=>{
    primeLyricCache(track.id,{lyric:'[00:01]kept',source:'online',synchronized:true,asset:{origin:'remote',provider:kind==='pending'?'script':kind,pending:kind==='pending'}})
    clearAutomaticLyricCache('script')
    const resolved=await resolveLocalLyric(track,{allowOnline:false})
    assert.equal(resolved.source,kind==='script'?'none':'online')
  })
})
test('a sidecar written during online lookup takes priority over the late network result', async () => {
  await fixture(async track => {
    let release, entered
    const waiting = new Promise(r => { entered = r })
    const fetchLyric = async () => { entered(); return new Promise(r => { release = r }) }
    const online = resolveLocalLyric(track, {}, {
      search: async () => [{ id: 'wy_1', source: 'wy', name: track.name, singer: track.singer, meta: { songmid: '1' } }], fetchLyric
    })
    await waiting
    await writeFile(sidecarPathFor(track.path), '[00:01]new sidecar')
    release({ lyric: '[00:01]old remote' })
    const resolved = await online
    assert.equal(resolved.source, 'sidecar'); assert.match(resolved.lyric, /new sidecar/)
  })
})
test('a new or edited sidecar immediately outranks already cached online lyrics', async () => {
  await fixture(async track => {
    primeLyricCache(track.id, { lyric: '[00:01]online', source: 'online', synchronized: true, asset: { origin: 'remote', pending: true } })
    assert.equal((await resolveLocalLyric(track, { allowOnline: false })).source, 'online')
    await writeFile(sidecarPathFor(track.path), '[00:01]first local')
    const first = await resolveLocalLyric(track, { allowOnline: false })
    assert.equal(first.source, 'sidecar')
    assert.equal(first.asset.pending, undefined)
    await writeFile(sidecarPathFor(track.path), '[00:01]edited local')
    assert.match((await resolveLocalLyric(track, { allowOnline: false })).lyric, /edited local/)
  })
})
test('deleting a cached sidecar falls back to current embedded lyrics', async () => {
  await fixture(async track => {
    assert.equal((await writeTags(track.path, { lyrics: '[00:01]embedded' })).written, true)
    await writeFile(sidecarPathFor(track.path), '[00:01]sidecar')
    assert.equal((await resolveLocalLyric(track, { allowOnline: false })).source, 'sidecar')
    await rm(sidecarPathFor(track.path))
    const result = await resolveLocalLyric(track, { allowOnline: false })
    assert.equal(result.source, 'embedded')
    assert.match(result.lyric, /embedded/)
  })
})
test('audio tag changes invalidate embedded cache even without a library rescan', async () => {
  await fixture(async track => {
    assert.equal((await writeTags(track.path, { lyrics: '[00:01]old text' })).written, true)
    assert.match((await resolveLocalLyric(track, { allowOnline: false })).lyric, /old text/)
    assert.equal((await writeTags(track.path, { lyrics: '[00:01]new text' })).written, true)
    assert.match((await resolveLocalLyric(track, { allowOnline: false })).lyric, /new text/)
  })
})
test('cached online lyrics stay marked pending and resolution never writes local files', async () => {
  await fixture(async track => {
    const before = await readFile(track.path)
    const cached = { lyric: '[00:01]cached', source: 'online', synchronized: true, asset: { origin: 'remote', pending: true } }
    primeLyricCache(track.id, cached)
    const resolved = await resolveLocalLyric(track, { allowOnline: false }, { search: async () => { throw Error('must not ask network') } })
    assert.equal(resolved.asset.pending, true)
    assert.deepEqual(await readFile(track.path), before)
    await assert.rejects(readFile(sidecarPathFor(track.path)), error => error.code === 'ENOENT')
  })
})

test('online picks cannot inherit the validity stamp of embedded lyrics', async () => {
  await fixture(async track => {
    await writeTags(track.path, { lyrics: '[00:01]original embedded' })
    assert.equal((await resolveLocalLyric(track, { allowOnline: false })).source, 'embedded')
    primeLyricCache(track.id, { lyric: '[00:01]picked online', source: 'online', synchronized: true, asset: { origin: 'remote', pending: true } })
    const result = await resolveLocalLyric(track, { allowOnline: false })
    assert.equal(result.source, 'embedded')
    assert.match(result.lyric, /original embedded/)
  })
})
