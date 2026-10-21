import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, mkdir, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { PendingAssetStore } from './library/pending-assets.js'
import { withPendingAssetWrite } from './library/pending-asset-write.js'

const entry = (lyric = 'old', kind = 'lyric') => ({ trackId: 'one', kind, name: 'song', singer: 'artist', path: 'fixture.mp3', lyric,
  ...(kind === 'cover' ? { image: { path: 'old.png', mimeType: 'image/png' } } : {}), origin: 'remote', at: 1 })
async function fixture(work) {
  const dir = await mkdtemp(join(tmpdir(), 'jj-pending-snapshot-'))
  const store = new PendingAssetStore(dir)
  try { await work(store, async () => new PendingAssetStore(dir).load(), dir) }
  finally { await store.flush(); assert.ok(resolve(dir).startsWith(resolve(tmpdir()) + sep)); await rm(dir, { recursive: true, force: true }) }
}

test('late cleanup of an old snapshot preserves a newer lyric and unrelated kinds on disk', async () => {
  await fixture(async (store, reopened) => {
    await store.add(entry())
    const old = await store.load()
    await store.add(entry('new'))
    await store.add(entry(undefined, 'cover'))
    await store.removeEntries(old)
    assert.equal(store.list().length, 2)
    assert.equal(store.list().find(item => item.kind === 'lyric').lyric, 'new')
    assert.deepEqual(await reopened(), store.list())
    await store.removeEntries(await store.load())
    assert.deepEqual(await reopened(), [])
  })
})

test('re-staging identical content with the same timestamp is still a new choice', async () => {
  await fixture(async (store, reopened) => {
    const chosen = entry()
    await store.add(chosen)
    const old = await store.load()
    await store.add(chosen)
    await store.removeEntries(old)
    assert.equal((await reopened()).length, 1)
    assert.notEqual(store.list()[0], old[0])
  })
})

test('late cover cleanup cannot delete a replacement pointing at another image', async () => {
  await fixture(async (store, reopened) => {
    await store.add(entry(undefined, 'cover'))
    const old = await store.load()
    await store.add({ ...old[0], image: { path: 'new.png', mimeType: 'image/png' } })
    await store.removeEntries(old)
    assert.equal((await reopened())[0]?.image.path, 'new.png')
  })
})

test('explicit fingerprint recording affects only the requested text and never alters pending entries', async () => {
  await fixture(async (store, reopened) => {
    await store.add(entry())
    const old = await store.load()
    await store.add(entry('new'))
    await store.removeEntries(old)
    await store.dismissEntries(old)
    assert.equal(await store.isDismissed('one', 'lyric', 'old'), true)
    assert.equal(await store.isDismissed('one', 'lyric', 'new'), false)
    assert.equal((await reopened())[0]?.lyric, 'new')
  })
})

test('stale atomic discard cannot mark an identical newly staged choice as rejected', async () => {
  await fixture(async (store, reopened) => {
    await store.add(entry())
    const old = await store.load()
    await store.add(old[0])
    assert.deepEqual(await store.discardEntries(old), [])
    assert.equal(await store.isDismissed('one', 'lyric', 'old'), false)
    assert.equal((await reopened()).length, 1)
  })
})

test('atomic discard consumes only matching snapshots and remembers exactly those decisions', async () => {
  await fixture(async (store, reopened) => {
    await store.add(entry())
    const chosen = await store.load()
    const removed = await store.discardEntries(chosen)
    assert.deepEqual(removed, chosen)
    assert.equal(await store.isDismissed('one', 'lyric', 'old'), true)
    assert.deepEqual(await reopened(), [])
  })
})

test('failed atomic discard preserves both the pending choice and its rejection state', async () => {
  await fixture(async (store, reopened, dir) => {
    await store.add(entry())
    const chosen = await store.load()
    const file = join(dir, 'library/pending-assets.json'), held = file + '.held'
    await rename(file, held)
    await mkdir(file)
    await writeFile(join(file, 'sentinel'), 'keep')
    await assert.rejects(store.discardEntries(chosen))
    assert.equal(await store.isDismissed('one', 'lyric', 'old'), false)
    assert.equal(store.list()[0], chosen[0])
    await rm(file, { recursive: true })
    await rename(held, file)
    assert.equal((await reopened())[0]?.lyric, 'old')
    await store.discardEntries(chosen)
    assert.deepEqual(await reopened(), [])
  })
})

test('a new choice staged while the production write lifecycle waits is retained', async () => {
  await fixture(async (store, reopened) => {
    await store.add(entry())
    let start, release
    const entered = new Promise(resolve => { start = resolve })
    const held = new Promise(resolve => { release = resolve })
    const writing = withPendingAssetWrite(store, 'one', ['lyric'], async () => {
      start(); await held; return { written: true }
    })
    await entered
    try { await store.add(entry('chosen during write')) }
    finally { release() }
    await writing
    assert.equal((await reopened())[0]?.lyric, 'chosen during write')
  })
})

test('a batch keeps its original snapshot even when a new choice was staged before this item starts', async () => {
  await fixture(async (store, reopened) => {
    await store.add(entry())
    const snapshot = await store.load()
    await store.add(entry('new before file IO'))
    await withPendingAssetWrite(store, 'one', ['lyric'], async () => ({ written: true }), { snapshot })
    assert.equal((await reopened())[0]?.lyric, 'new before file IO')
  })
})

test('an explicit empty batch snapshot cannot acquire cleanup authority for a later choice', async () => {
  await fixture(async (store, reopened) => {
    await store.add(entry('new while batch read local content'))
    await withPendingAssetWrite(store, 'one', ['lyric'], async () => ({ written: true }), { snapshot: [] })
    assert.equal((await reopened()).length, 1)
  })
})

test('successful unchanged snapshot cleanup only consumes written kinds of the selected track', async () => {
  await fixture(async (store, reopened) => {
    await store.add(entry())
    await store.add(entry(undefined, 'cover'))
    await store.add({ ...entry(), trackId: 'other' })
    await withPendingAssetWrite(store, 'one', ['lyric'], async () => ({ written: true }))
    const saved = await reopened()
    assert.equal(saved.length, 2)
    assert.ok(saved.some(item => item.trackId === 'one' && item.kind === 'cover'))
    assert.ok(saved.some(item => item.trackId === 'other'))
  })
})

for (const mode of ['dry-run', 'not-written', 'throw']) test(`${mode} never consumes a pending choice`, async () => {
  await fixture(async (store, reopened) => {
    await store.add(entry())
    const operation = withPendingAssetWrite(store, 'one', ['lyric'], async () => {
      if (mode === 'throw') throw new Error('controlled failure')
      return { written: mode !== 'not-written' }
    }, { dryRun: mode === 'dry-run' })
    if (mode === 'throw') await assert.rejects(operation, /controlled failure/)
    else await operation
    assert.equal((await reopened())[0]?.lyric, 'old')
  })
})
