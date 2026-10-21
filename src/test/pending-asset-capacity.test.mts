import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { PendingAssetStore } from './library/pending-assets.js'

const entry = (id, lyric = 'chosen', at = 1) => ({ trackId: String(id), kind: 'lyric', name: 'song', singer: 'artist', path: 'fixture.mp3', lyric, origin: 'remote', at })
async function fixture(seed, work) {
  const dir = await mkdtemp(join(tmpdir(), 'jj-pending-cap-'))
  const file = join(dir, 'library/pending-assets.json')
  await mkdir(join(dir, 'library'))
  await writeFile(file, JSON.stringify({ entries: seed, dismissed: [] }))
  const store = new PendingAssetStore(dir)
  try { await work({ dir, file, store }) }
  finally { assert.ok(resolve(dir).startsWith(resolve(tmpdir()) + sep)); await rm(dir, { recursive: true, force: true }) }
}

test('entry capacity rejects a new choice without evicting saved choices, including after restart', async () => {
  const seed = Array.from({ length: 500 }, (_, n) => entry(n, `chosen-${n}`, n))
  await fixture(seed, async ({ dir, file, store }) => {
    const before = await readFile(file)
    await assert.rejects(store.add(entry('overflow')), /待写入.*(上限|已满)/)
    assert.deepEqual(store.list(), seed)
    assert.deepEqual(await readFile(file), before)
    assert.deepEqual(await new PendingAssetStore(dir).load(), seed)
    await store.add(entry(0, 'replacement', 0))
    assert.equal(store.list().length, 500)
    assert.equal(store.list().find(item => item.trackId === '0').lyric, 'replacement')
  })
})

test('explicit reselection atomically restores a discarded choice and only resets its rejection', async () => {
  await fixture([], async ({ store, dir }) => {
    const chosen = { ...entry('chosen'), tlyric: 'old translation' }
    await store.add(chosen)
    await store.discardEntries(await store.load())
    await store.dismissEntries([entry('other'), entry('chosen', 'another rejected text')])
    assert.equal(await store.isDismissed('chosen', 'lyric', 'chosen'), true)
    await store.add({ ...chosen, tlyric: 'new translation' }, { explicitChoice: true })
    const restarted = new PendingAssetStore(dir)
    assert.equal((await restarted.load())[0].tlyric, 'new translation')
    assert.equal(await restarted.isDismissed('chosen', 'lyric', 'chosen'), false)
    assert.equal(await restarted.isDismissed('other', 'lyric', 'chosen'), true)
    assert.equal(await restarted.isDismissed('chosen', 'lyric', 'another rejected text'), true)
  })
})

test('failed explicit reselection keeps the discarded decision and full queue', async () => {
  const seed = Array.from({ length: 500 }, (_, n) => entry(n, 'saved', n))
  await fixture(seed, async ({ store, file }) => {
    await store.dismissEntries([entry('returning')])
    const before = await readFile(file)
    await assert.rejects(store.add(entry('returning'), { explicitChoice: true }), /待写入.*上限/)
    assert.equal(await store.isDismissed('returning', 'lyric', 'chosen'), true)
    assert.deepEqual(await readFile(file), before)
    assert.deepEqual(store.list(), seed)
  })
})

test('supplemental lyric text shares the existing entry and aggregate limits without losing choices', async () => {
  await fixture([entry('saved')], async ({ store, file, dir }) => {
    await store.load()
    const before = await readFile(file)
    for (const field of ['tlyric', 'rlyric', 'lxlyric']) {
      await assert.rejects(store.add({ ...entry('oversized'), [field]: 'x'.repeat(200000) }), /待写入.*上限/)
      assert.deepEqual(await readFile(file), before)
      assert.deepEqual(store.list(), [entry('saved')])
    }
    const chosen = { ...entry('complete'), tlyric: 'translation', rlyric: 'romanization', lxlyric: 'extended' }
    await store.add(chosen)
    assert.deepEqual(await new PendingAssetStore(dir).load(), [entry('saved'), chosen])
  })
  const seed = Array.from({ length: 10 }, (_, n) => ({ ...entry(n, 'x'.repeat(100000), n), tlyric: 't'.repeat(100000) }))
  await fixture(seed, async ({ store, file }) => {
    const before = await readFile(file)
    await assert.rejects(store.add(entry('over-total')), /待写入.*上限/)
    assert.deepEqual(await readFile(file), before)
    assert.deepEqual(store.list(), seed)
  })
})

test('aggregate lyric cap refuses overflowing replacement and permits a smaller replacement', async () => {
  const seed = Array.from({ length: 10 }, (_, n) => entry(n, 'x'.repeat(200000), n))
  seed.push(entry('small', '', 10))
  await fixture(seed, async ({ store, file }) => {
    const before = await readFile(file)
    await assert.rejects(store.add(entry('small', 'extra', 10)), /待写入.*(上限|已满)/)
    assert.deepEqual(store.list(), seed)
    assert.deepEqual(await readFile(file), before)
    await store.add(entry(0, 'shorter', 0))
    await store.add(entry('small', 'now fits', 10))
    assert.equal(store.list().length, 11)
  })
})

test('legacy queues already above the cap are never trimmed on a new add', async () => {
  const seed = Array.from({ length: 501 }, (_, n) => entry(n, 'saved', n))
  await fixture(seed, async ({ store, file }) => {
    const before = await readFile(file)
    await assert.rejects(store.add(entry('new')), /待写入.*(上限|已满)/)
    assert.deepEqual(store.list(), seed)
    assert.deepEqual(await readFile(file), before)
  })
})

test('failed persistence retains committed memory and disk, then later changes can succeed', async () => {
  await fixture([entry('saved')], async ({ dir, file, store }) => {
    await store.load()
    const held = file + '.held'
    await rename(file, held)
    await mkdir(file) // A directory at the target makes atomic rename fail on every platform.
    await writeFile(join(file, 'sentinel'), 'keep')
    await assert.rejects(store.add(entry('saved', 'uncommitted')))
    assert.equal(store.list()[0].lyric, 'chosen')
    assert.equal((JSON.parse(await readFile(held, 'utf8'))).entries[0].lyric, 'chosen')
    await rm(file, { recursive: true })
    await rename(held, file)
    await store.add(entry('later'))
    assert.deepEqual(await new PendingAssetStore(dir).load(), [entry('saved'), entry('later')])
  })
})

test('concurrent first loads cannot let an add overwrite existing choices', async () => {
  await fixture([entry('saved')], async ({ dir, store }) => {
    await Promise.all([store.load(), store.add(entry('new'))])
    assert.deepEqual(await new PendingAssetStore(dir).load(), [entry('saved'), entry('new')])
  })
})

test('concurrent additions compete for the final slot without evicting either prior data or the winner', async () => {
  const seed = Array.from({ length: 499 }, (_, n) => entry(n, 'saved', n))
  await fixture(seed, async ({ dir, store }) => {
    await store.load()
    const results = await Promise.allSettled([store.add(entry('a', 'a', 600)), store.add(entry('b', 'b', 601))])
    assert.equal(results.filter(result => result.status === 'fulfilled').length, 1)
    assert.equal(results.filter(result => result.status === 'rejected').length, 1)
    const saved = await new PendingAssetStore(dir).load()
    assert.equal(saved.length, 500)
    assert.deepEqual(saved.slice(0, 499), seed)
    assert.deepEqual(store.list(), saved)
  })
})

test('oversized single lyrics report rejection instead of silently pretending to stage', async () => {
  await fixture([entry('saved')], async ({ store, file }) => {
    const before = await readFile(file)
    await assert.rejects(store.add(entry('saved', 'x'.repeat(200001))), /待写入.*上限/)
    assert.deepEqual(await store.load(), [entry('saved')])
    assert.deepEqual(await readFile(file), before)
  })
})

test('failed queued removals and dismissals do not change committed user decisions', async () => {
  await fixture([entry('saved')], async ({ store, file }) => {
    const snapshots = await store.load()
    const held = file + '.held'
    await rename(file, held)
    await mkdir(file)
    await writeFile(join(file, 'sentinel'), 'keep')
    const results = await Promise.allSettled([
      store.removeEntries(snapshots),
      store.dismissEntries([entry('saved')]),
      store.clear()
    ])
    assert.ok(results.every(result => result.status === 'rejected'))
    assert.deepEqual(store.list(), [entry('saved')])
    assert.equal(await store.isDismissed('saved', 'lyric', 'chosen'), false)
  })
})

test('lifecycle flush drains changes that have not reached the atomic file writer yet', async () => {
  await fixture([entry('saved')], async ({ dir, store }) => {
    const operations = [store.add(entry('first')), store.add(entry('second'))]
    // Attach a handler even if the expected missing-flush failure happens first.
    const complete = Promise.allSettled(operations)
    try {
      await store.flush()
      assert.deepEqual(await new PendingAssetStore(dir).load(), [entry('saved'), entry('first'), entry('second')])
    } finally { await complete }
  })
})
