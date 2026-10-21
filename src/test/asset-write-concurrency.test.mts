import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { parseFile } from 'music-metadata'
import { exportAssets } from './library/asset-export.js'
import { PathTaskQueue, TaskGroup } from './library/path-task-queue.js'

async function fixture(work) {
  const dir = await mkdtemp(join(tmpdir(), 'jj-asset-serial-'))
  try { await work(dir) }
  finally { assert.ok(resolve(dir).startsWith(resolve(tmpdir()) + sep)); await rm(dir, { recursive: true, force: true }) }
}

for (const differentFormat of [false, true]) test(`concurrent noClobber sidecars preserve the first result (${differentFormat ? 'shared stem' : 'same audio'})`, async () => {
  await fixture(async dir => {
    const one = join(dir, 'song.mp3'), two = differentFormat ? join(dir, 'song.flac') : one
    const results = await Promise.all([
      exportAssets({ audioPath: one, patch: { lyrics: 'first choice' }, to: ['sidecar'], noClobber: true }),
      exportAssets({ audioPath: two, patch: { lyrics: 'second choice' }, to: ['sidecar'], noClobber: true })
    ])
    assert.equal(results.filter(result => result.written).length, 1)
    assert.equal(await readFile(join(dir, 'song.lrc'), 'utf8'), 'first choice')
  })
})

test('concurrent FLAC patches both succeed and retain independent fields and the original backup', async () => {
  await fixture(async dir => {
    const path = join(dir, 'song.flac')
    const original = Buffer.concat([Buffer.from('fLaC'), Buffer.from([0x80, 0, 0, 34]), Buffer.alloc(34), Buffer.from('audio')])
    await writeFile(path, original)
    const results = await Promise.all([
      exportAssets({ audioPath: path, patch: { title: 'new title' }, to: ['embedded'] }),
      exportAssets({ audioPath: path, patch: { artist: 'new artist' }, to: ['embedded'] })
    ])
    assert.ok(results.every(result => result.written && result.embeddedWritten))
    const tags = await parseFile(path)
    assert.equal(tags.common.title, 'new title')
    assert.equal(tags.common.artist, 'new artist')
    assert.deepEqual(await readFile(path + '.bak'), original)
    assert.equal((await readdir(dir)).some(name => name.endsWith('.jjtmp')), false)
  })
})

const gate = () => { let release; const promise = new Promise(resolve => { release = resolve }); return { promise, release } }

test('overlapping multi-path reservations keep order while independent paths run concurrently', async () => {
  const queue = new PathTaskQueue(), held = gate(), entered = gate(), events = []
  const first = queue.run(['a', 'b'], async () => { events.push('first'); entered.release(); await held.promise })
  await entered.promise
  const second = queue.run(['b', 'c'], async () => { events.push('second') })
  const third = queue.run(['c', 'd'], async () => { events.push('third') })
  await queue.run(['independent'], async () => { events.push('independent') })
  assert.deepEqual(events, ['first', 'independent'])
  held.release()
  await Promise.all([first, second, third])
  assert.deepEqual(events, ['first', 'independent', 'second', 'third'])
  await queue.flush()
})

test('a rejected task releases all paths and does not poison later tasks or flush', async () => {
  const queue = new PathTaskQueue(), events = []
  const first = queue.run(['one', 'two'], async () => { throw new Error('controlled failure') })
  const rejected = assert.rejects(first, /controlled failure/)
  const second = queue.run(['two', 'three'], async () => { events.push('continued') })
  await queue.flush()
  await Promise.all([rejected, second])
  assert.deepEqual(events, ['continued'])
})

test('flush waits for normalized-path tasks queued behind a held operation', async () => {
  const queue = new PathTaskQueue(), held = gate(), entered = gate(), events = []
  const first = queue.run(['folder/../song.flac'], async () => { entered.release(); await held.promise; events.push('first') })
  await entered.promise
  const alias = resolve('song.flac')
  const second = queue.run([process.platform === 'win32' ? alias.toUpperCase() : alias], async () => { events.push('second') })
  let flushed = false
  const draining = queue.flush().then(() => { flushed = true })
  await Promise.resolve()
  assert.equal(flushed, false)
  assert.deepEqual(events, [])
  held.release()
  await draining
  assert.deepEqual(events, ['first', 'second'])
  await Promise.all([first, second])
})

test('operation drain waits across preparation gaps before later file tasks are queued', async () => {
  const operations = new TaskGroup(), files = new PathTaskQueue(), prepare = gate(), entered = gate(), events = []
  const operation = operations.run(async () => {
    await files.run(['first'], async () => { events.push('first') })
    entered.release()
    await prepare.promise
    await files.run(['second'], async () => { events.push('second') })
  })
  await entered.promise
  await files.flush()
  let drained = false
  const draining = operations.flush().then(() => { drained = true })
  await Promise.resolve()
  assert.equal(drained, false, 'an empty file queue does not mean the whole operation is done')
  prepare.release()
  await Promise.all([operation, draining])
  assert.deepEqual(events, ['first', 'second'])
})
