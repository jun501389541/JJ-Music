import assert from 'node:assert/strict'
import { test, mock } from 'node:test'
import { mkdtemp, readFile, rm, writeFile, stat } from 'node:fs/promises'
import { join, resolve, sep } from 'node:path'
import { tmpdir } from 'node:os'
import { DownloadManager } from './downloads/download-manager.js'
import { MusicLibrary } from './library/music-library.js'
import { DEFAULT_SETTINGS } from './store/settings-store.js'

const track = { id: 'wy_download', source: 'wy', name: 'Downloaded', singer: 'Artist', meta: { songmid: 'download' } }
function flac() {
  const bytes = Buffer.alloc(42); bytes.write('fLaC'); bytes[4] = 0x80; bytes[7] = 34
  bytes.writeUInt16BE(4096, 8); bytes.writeUInt16BE(4096, 10)
  bytes.writeBigUInt64BE((44100n << 44n) | (1n << 41n) | (15n << 36n) | 44100n, 18)
  return Buffer.concat([bytes, Buffer.from('fixture audio')])
}
async function wait(check) {
  const deadline = Date.now() + 1500
  while (Date.now() < deadline) { const value = check(); if (value) return value; await new Promise(resolve => setTimeout(resolve, 5)) }
  return check()
}
async function fixture(work) {
  const dir = await mkdtemp(join(tmpdir(), 'jj-download-library-'))
  const library = new MusicLibrary(dir)
  let downloads = 0, importer, trasher = async path => rm(path)
  const manager = new DownloadManager(dir, {
    settings: () => ({ ...DEFAULT_SETTINGS, downloadFolder: dir, downloadLyric: false, downloadEmbedLyric: false, downloadEmbedCover: false }), defaultFolder: dir,
    resolve: async () => ({ url: 'https://test/download', quality: 'flac' }), lyrics: async () => ({ lyric: '' }), cover: async () => '',
    fetch: async () => { downloads++; return new Response(flac()) }, trash: path => trasher(path),
    importFile: path => importer(path),
    removeLibraryFile: path => library.removeDownloadedFile(path)
  })
  importer = async path => (await library.importDownloadedFile(path)).id
  try { await work({ dir, manager, library, downloads: () => downloads, setImporter: fn => { importer = fn }, setTrash: fn => { trasher = fn } }) }
  finally { await manager.shutdown(); assert.ok(resolve(dir).startsWith(resolve(tmpdir()) + sep)); await rm(dir, { recursive: true, force: true }) }
}

test('completed download is indexed once and retains the original online identity', async () => {
  await fixture(async ({ manager, library }) => {
    const [id] = manager.add([track], 'flac')
    await wait(() => manager.list()[0]?.libraryStatus === 'imported')
    const task = manager.list()[0]
    assert.equal(task.status, 'completed')
    assert.equal(task.libraryStatus, 'imported')
    assert.equal(task.track.id, track.id)
    assert.equal(library.getAll().length, 1)
    assert.equal(task.localTrackId, library.getAll()[0].id)
    await manager.retryImport(id)
    assert.equal(library.getAll().length, 1)
  })
})
test('library failure preserves the file and retry imports it without downloading again', async () => {
  await fixture(async ({ manager, library, setImporter, downloads, dir }) => {
    setImporter(async () => { throw new Error('library temporarily locked') })
    const [id] = manager.add([track], 'flac')
    await wait(() => manager.list()[0]?.libraryStatus === 'failed')
    const failed = manager.list()[0]
    assert.equal(failed.status, 'completed')
    assert.match(failed.libraryError, /locked/)
    assert.equal((await stat(failed.path)).isFile(), true)
    const bytes = await readFile(failed.path)
    setImporter(async path => (await library.importDownloadedFile(path)).id)
    await manager.retryImport(id)
    assert.equal(manager.list()[0].libraryStatus, 'imported')
    assert.equal(downloads(), 1)
    assert.deepEqual(await readFile(failed.path), bytes)
    await manager.shutdown()
    const saved = JSON.parse(await readFile(join(dir, 'downloads.json'), 'utf8'))
    assert.equal(saved[0].libraryStatus, 'imported')
    assert.equal(saved[0].libraryError, undefined)
  })
})
test('simultaneous import retries share one operation', async () => {
  await fixture(async ({ manager, library, setImporter }) => {
    setImporter(async () => { throw new Error('initial failure') })
    const [id] = manager.add([track], 'flac')
    await wait(() => manager.list()[0]?.libraryStatus === 'failed')
    let calls = 0, release
    setImporter(path => { calls++; return new Promise(resolve => { release = async () => resolve((await library.importDownloadedFile(path)).id) }) })
    const a = manager.retryImport(id), b = manager.retryImport(id)
    await wait(() => !!release)
    await release()
    await Promise.all([a, b])
    assert.equal(calls, 1)
    assert.equal(library.getAll().length, 1)
  })
})
test('reloading interrupted and legacy completed imports never redownloads the file', async () => {
  await fixture(async ({ manager, dir, downloads }) => {
    await writeFile(join(dir, 'downloads.json'), JSON.stringify([
      { id: 'old', track, quality: 'flac', status: 'completed', path: join(dir, 'old.flac'), libraryStatus: 'importing' },
      { id: 'legacy', track, quality: 'flac', status: 'completed', path: join(dir, 'legacy.flac') }
    ]))
    await manager.load()
    assert.equal(manager.list()[0].status, 'completed')
    assert.equal(manager.list()[0].libraryStatus, 'failed')
    assert.equal(manager.list()[1].libraryStatus, 'pending')
    assert.equal(downloads(), 0)
  })
})
test('concurrent removal of completed records does not use stale array positions', async () => {
  await fixture(async ({ manager, dir }) => {
    await writeFile(join(dir, 'downloads.json'), JSON.stringify(['first', 'second'].map(id => ({ id, track, quality: 'flac', status: 'completed', path: join(dir, `${id}.flac`) }))))
    await manager.load()
    await Promise.all([manager.remove('first', false), manager.remove('second', false)])
    assert.deepEqual(manager.list(), [])
  })
})

test('removing only a record keeps the imported song, deleting the audio removes its index', async () => {
  await fixture(async ({ manager, library, dir }) => {
    const [first] = manager.add([track], 'flac')
    await wait(() => manager.list()[0]?.libraryStatus === 'imported')
    const kept = manager.list()[0].path
    await manager.remove(first, false)
    assert.equal(library.getAll().length, 1)
    assert.ok((await stat(kept)).isFile())
    const [second] = manager.add([track], 'flac')
    await wait(() => manager.list()[0]?.libraryStatus === 'imported')
    const deleted = manager.list()[0].path
    await manager.remove(second, true)
    assert.equal(library.getAll().length, 1)
    assert.equal(library.getAll()[0].path, kept)
    await assert.rejects(stat(deleted), error => error.code === 'ENOENT')
    const reloaded = new MusicLibrary(dir)
    await reloaded.load()
    assert.equal(reloaded.getAll().length, 1)
  })
})

test('removal waits for an active import and blocks new import retries', async () => {
  await fixture(async ({ manager, library, setImporter, setTrash }) => {
    setImporter(async () => { throw Error('initial failure') })
    const [id] = manager.add([track], 'flac')
    await wait(() => manager.list()[0]?.libraryStatus === 'failed')
    let release, trashed = false
    setImporter(path => new Promise((resolve, reject) => { release = async () => {
      try { resolve((await library.importDownloadedFile(path)).id) } catch (error) { reject(error) }
    } }))
    setTrash(async path => { trashed = true; await rm(path) })
    const importing = manager.retryImport(id)
    await wait(() => !!release)
    const removing = manager.remove(id, true)
    try {
      await assert.rejects(manager.retryImport(id), /移除/)
      await new Promise(resolve => setImmediate(resolve))
      assert.equal(trashed, false)
    } finally { await release(); await Promise.allSettled([importing, removing]) }
    assert.equal(trashed, true)
    assert.equal(library.getAll().length, 0)
    assert.deepEqual(manager.list(), [])
  })
})

test('a slow import makes removal time out without trashing audio or dropping its record', async () => {
  await fixture(async ({ manager, library, setImporter, setTrash }) => {
    setImporter(async () => { throw Error('initial failure') })
    const [id] = manager.add([track], 'flac')
    await wait(() => manager.list()[0]?.libraryStatus === 'failed')
    let release, trashed = false
    setImporter(path => new Promise(resolve => { release = async () => resolve((await library.importDownloadedFile(path)).id) }))
    setTrash(async () => { trashed = true })
    const importing = manager.retryImport(id)
    await wait(() => !!release)
    mock.timers.enable({ apis: ['setTimeout'] })
    try {
      const removing = manager.remove(id, true)
      const rejected = assert.rejects(removing, /记录和文件已保留/)
      mock.timers.tick(5000)
      await rejected
      assert.equal(trashed, false)
      assert.equal(manager.list().length, 1)
      assert.ok((await stat(manager.list()[0].path)).isFile())
    } finally { mock.timers.reset(); await release(); await importing }
  })
})

test('failed trash keeps both the download record and library entry', async () => {
  await fixture(async ({ manager, library, setTrash }) => {
    const [id] = manager.add([track], 'flac')
    await wait(() => manager.list()[0]?.libraryStatus === 'imported')
    setTrash(async () => { throw Error('trash unavailable') })
    await assert.rejects(manager.remove(id, true), /trash unavailable/)
    assert.equal(manager.list().length, 1)
    assert.equal(library.getAll().length, 1)
    assert.ok((await stat(manager.list()[0].path)).isFile())
  })
})
