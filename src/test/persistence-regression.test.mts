import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, readFile, readdir, writeFile, mkdir, rm, rmdir } from 'node:fs/promises'
import { join, resolve, sep } from 'node:path'
import { tmpdir } from 'node:os'
import { writeJsonAtomic } from './store/json-file.js'
import { SettingsStore, PlaylistStore } from './store/settings-store.js'
import { MusicLibrary } from './library/music-library.js'

async function fixture(run) {
  const root = resolve(tmpdir())
  const dir = await mkdtemp(join(root, 'jj-regression-'))
  try { await run(dir) } finally {
    assert.ok(resolve(dir).startsWith(root + sep))
    assert.ok(dir.slice(root.length + 1).startsWith('jj-regression-'))
    await rm(dir, { recursive: true, force: true })
  }
}

test('concurrent JSON writes preserve submission order and leave no temporary files', () => fixture(async dir => {
  const path = join(dir, 'settings.json')
  await Promise.all(Array.from({ length: 30 }, (_, i) => writeJsonAtomic(path, { i })))
  assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), { i: 29 })
  assert.deepEqual(await readdir(dir), ['settings.json'])
}))

test('queued JSON values are snapshotted before caller mutation', () => fixture(async dir => {
  const path = join(dir, 'state.json')
  const value = { nested: { count: 1 } }
  const writing = writeJsonAtomic(path, value)
  value.nested.count = 2
  await writing
  assert.equal(JSON.parse(await readFile(path, 'utf8')).nested.count, 1)
}))

test('a failed write does not poison subsequent writes or leave scratch files', () => fixture(async dir => {
  const path = join(dir, 'state.json')
  await mkdir(path)
  await assert.rejects(writeJsonAtomic(path, { i: 0 }))
  await rmdir(path)
  await writeJsonAtomic(path, { i: 1 })
  assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), { i: 1 })
  assert.deepEqual(await readdir(dir), ['state.json'])
}))

test('concurrent settings and playlist operations survive reload', () => fixture(async dir => {
  const settings = new SettingsStore(dir)
  const playlists = new PlaylistStore(dir)
  await settings.load()
  await playlists.load()
  await Promise.all(Array.from({ length: 15 }, (_, i) => settings.update({ volume: i / 20 })))
  await Promise.all(Array.from({ length: 15 }, (_, i) => playlists.create(`list-${i}`)))
  assert.equal((await new SettingsStore(dir).load()).volume, 14 / 20)
  assert.equal((await new PlaylistStore(dir).list()).length, 17)
}))

// A tiny FLAC metadata fixture. No real library or copyrighted audio required.
function flacWithCover(image) {
  const streamInfo = Buffer.alloc(38)
  streamInfo[0] = 0
  streamInfo.writeUIntBE(34, 1, 3)
  streamInfo.writeUInt16BE(4096, 4)
  streamInfo.writeUInt16BE(4096, 6)
  streamInfo.writeBigUInt64BE((44100n << 44n) | (1n << 41n) | (15n << 36n), 14)
  const uint = value => { const b = Buffer.alloc(4); b.writeUInt32BE(value); return b }
  const mime = Buffer.from('image/png')
  const picture = Buffer.concat([uint(3), uint(mime.length), mime, uint(0), uint(1), uint(1), uint(24), uint(0), uint(image.length), image])
  const header = Buffer.alloc(4)
  header[0] = 0x86
  header.writeUIntBE(picture.length, 1, 3)
  return Buffer.concat([Buffer.from('fLaC'), streamInfo, header, picture])
}

test('cover changes refresh cache paths and identical images share a file', () => fixture(async dir => {
  const library = new MusicLibrary(dir)
  const first = join(dir, 'first.flac')
  const second = join(dir, 'second.flac')
  const artA = Buffer.from('png-fixture-a')
  const artB = Buffer.from('png-fixture-b')
  await writeFile(first, flacWithCover(artA))
  await writeFile(second, flacWithCover(artA))
  const a = await library.readTrack(first)
  const b = await library.readTrack(second)
  assert.ok(a.coverPath)
  assert.equal(a.coverPath, b.coverPath)
  await writeFile(first, flacWithCover(artB))
  const changed = await library.readTrack(first)
  assert.ok(changed.coverPath)
  assert.notEqual(changed.coverPath, a.coverPath)
  assert.deepEqual(await readFile(changed.coverPath), artB)
}))

test('overlapping library roots scan once and retain tracks covered by another root', () => fixture(async dir => {
 const root=join(dir,'music'), nested=join(root,'album')
 await mkdir(nested,{recursive:true})
 const file=join(nested,'song.flac')
 await writeFile(file,flacWithCover(Buffer.from('cover')))
 const library=new MusicLibrary(dir)
 await library.addFolder(root)
 await library.addFolder(nested)
 const scan=await library.scan()
 assert.equal(scan.scanned,1)
 await library.removeFolder(root)
 assert.equal(library.getAll().length,1)
 const restored=new MusicLibrary(dir)
 await restored.load()
 assert.equal(restored.getAll().length,1)
}))
