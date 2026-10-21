import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { PendingAssetStore } from './library/pending-assets.js'

const entry = id => ({ trackId: id, kind: 'lyric', name: 'song', singer: 'artist', path: 'fixture.mp3', lyric: 'chosen', origin: 'remote', at: 1 })
async function fixture(work) {
  const dir = await mkdtemp(join(tmpdir(), 'jj-pending-read-'))
  const file = join(dir, 'library/pending-assets.json')
  await mkdir(join(dir, 'library'))
  const store = new PendingAssetStore(dir)
  try { await work({ dir, file, store }) }
  finally { await store.flush(); assert.ok(resolve(dir).startsWith(resolve(tmpdir()) + sep)); await rm(dir, { recursive: true, force: true }) }
}

for (const bytes of ['{"entries":[', 'null', '{"entries":{}}', '{"unknown":"do not overwrite"}', '{"entries":[],"dismissed":{}}']) {
  test(`unusable queue bytes remain untouched and refuse subsequent mutations: ${bytes}`, async () => {
    await fixture(async ({ file, store }) => {
      await writeFile(file, bytes)
      await assert.rejects(store.load(), /待写入.*(损坏|格式)/)
      await assert.rejects(store.add(entry('new')), /待写入/)
      await assert.rejects(store.clear(), /待写入/)
      assert.equal(await readFile(file, 'utf8'), bytes)
      assert.deepEqual(await readdir(join(file, '..')), ['pending-assets.json'])
    })
  })
}

test('a failed read and concurrent add cannot poison the loaded state; repairing the path permits retry', async () => {
  await fixture(async ({ dir, file, store }) => {
    await mkdir(file)
    await writeFile(join(file, 'sentinel'), 'keep')
    const results = await Promise.allSettled([store.load(), store.add(entry('new'))])
    assert.ok(results.every(result => result.status === 'rejected'))
    assert.match(results[0].reason.message, /待写入.*读取/)
    assert.equal(await readFile(join(file, 'sentinel'), 'utf8'), 'keep')
    await rm(file, { recursive: true })
    await writeFile(file, JSON.stringify({ entries: [entry('saved')], dismissed: [] }))
    await store.add(entry('new'))
    assert.deepEqual(await new PendingAssetStore(dir).load(), [entry('saved'), entry('new')])
  })
})

test('repairing corrupt JSON allows the same store to recover original pending and dismissal state', async () => {
  await fixture(async ({ dir, file, store }) => {
    await writeFile(file, 'broken')
    await assert.rejects(store.load(), /待写入/)
    const prepared = new PendingAssetStore(join(dir, 'prepared'))
    await prepared.add(entry('saved'))
    await prepared.dismissEntries([entry('rejected')])
    await writeFile(file, await readFile(join(dir, 'prepared/library/pending-assets.json')))
    assert.deepEqual(await store.load(), [entry('saved')])
    assert.equal(await store.isDismissed('rejected', 'lyric', 'chosen'), true)
    await store.add(entry('new'))
    assert.deepEqual(await new PendingAssetStore(dir).load(), [entry('saved'), entry('new')])
  })
})

test('a missing queue is still a valid first run', async () => {
  await fixture(async ({ dir, store }) => {
    assert.deepEqual(await store.load(), [])
    await store.add(entry('new'))
    assert.deepEqual(await new PendingAssetStore(dir).load(), [entry('new')])
  })
})

test('BOM and legacy array queues remain supported', async () => {
  await fixture(async ({ file, store }) => {
    await writeFile(file, '\ufeff' + JSON.stringify([entry('saved')]))
    assert.deepEqual(await store.load(), [entry('saved')])
  })
})

test('startup can continue while corrupt pending data remains protected and repairable', async () => {
  await fixture(async ({ file, store }) => {
    await writeFile(file, 'broken-private-content')
    const warnings = []
    await store.loadForStartup(message => warnings.push(message))
    assert.equal(warnings.length, 1)
    assert.match(warnings[0], /待写入.*原文件已保留/)
    assert.equal(warnings[0].includes('broken-private-content'), false)
    await assert.rejects(store.add(entry('new')), /待写入/)
    assert.equal(await readFile(file, 'utf8'), 'broken-private-content')
    await writeFile(file, JSON.stringify([entry('saved')]))
    await store.loadForStartup(message => warnings.push(message))
    assert.equal(warnings.length, 1)
    assert.deepEqual(await store.load(), [entry('saved')])
  })
})
