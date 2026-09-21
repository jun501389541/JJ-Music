import assert from 'node:assert/strict'
import { test } from 'node:test'
import { existsSync } from 'node:fs'
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

/**
 * 从曲库移除 (需求 12). The whole point of this action is what it does *not*
 * do: the file stays on disk, and the next scan of its folder brings it back.
 * Both halves are asserted, because a silent exclusion list would look identical
 * to a working removal right up until a song refuses to reappear.
 */
test('removing a song forgets the index entry, keeps the file, and a rescan restores it', () => fixture(async dir => {
 const root=join(dir,'music')
 await mkdir(root,{recursive:true})
 const file=join(root,'song.flac')
 await writeFile(file,flacWithCover(Buffer.from('cover')))
 const library=new MusicLibrary(dir)
 await library.addFolder(root)
 const id=library.getAll()[0].id
 assert.equal(await library.removeTracks([id,'not-a-track']),1)
 assert.equal(library.getAll().length,0,'the index forgot it')
 assert.ok(existsSync(file),'the music file is exactly where it was')
 const restored=new MusicLibrary(dir)
 await restored.load()
 assert.equal(restored.getAll().length,0,'and it stays gone across a restart')
 const rescan=await restored.scan()
 assert.equal(rescan.added,1,'a rescan of the folder brings it back')
 assert.deepEqual(await readFile(file),flacWithCover(Buffer.from('cover')),'reading it again did not touch it')
}))

/*
 * 用户"缓存放太多就删掉"会清空封面目录，而索引里仍写着封面路径。增量扫描按
 * 大小+mtime 跳过文件，音频本身没变，所以它永远看不见这件事；界面则会把每条
 * 引用画成浏览器的破图而不是应用自己的占位音符。索引加载时就得把死引用抹掉，
 * 并把整份索引标成待刷新，让启动时的后台扫描重新抽取。
 */
test('清空封面目录后，索引在加载时自愈而不是留下满屏破图', () => fixture(async dir => {
  const root = join(dir, 'music')
  await mkdir(root, { recursive: true })
  await writeFile(join(root, 'song.flac'), flacWithCover(Buffer.from('cover')))
  const library = new MusicLibrary(dir)
  await library.addFolder(root)
  const indexed = library.getAll()[0]
  assert.ok(indexed.coverPath, '前置条件：索引里记着一条封面路径')
  await rm(indexed.coverPath, { force: true })

  const reopened = new MusicLibrary(dir)
  await reopened.load()
  assert.equal(reopened.getAll()[0].coverPath, undefined, '指向不存在文件的引用被抹掉')
  assert.equal(reopened.isStale(), true, '并且整份索引被标成待刷新')

  await reopened.scan()
  const after = new MusicLibrary(dir)
  await after.load()
  const restored = after.getAll()[0].coverPath
  assert.ok(restored, '重扫之后封面又回来了')
  assert.ok(existsSync(restored), '而且指向的是真实存在的文件')
}))

/*
 * 歌单封面是下载/挑选后存在封面目录里的，删掉封面目录后索引里会留下死引用；
 * 加载时必须丢掉它，否则卡片上是浏览器的破图而不是音符占位。
 */
test('歌单封面文件被删后，加载时丢掉这条引用', () => fixture(async dir => {
  const store = new PlaylistStore(dir)
  await store.load()
  const list = await store.create('带封面')
  const art = join(dir, 'covers', 'playlist.jpg')
  await mkdir(join(dir, 'covers'), { recursive: true })
  await writeFile(art, Buffer.from('jpegbytes'))
  await store.setCover(list.id, art)
  assert.equal((await new PlaylistStore(dir).list()).find(x => x.id === list.id).coverPath, art, '前置条件：封面确实记下了')

  await rm(art, { force: true })
  const reopened = new PlaylistStore(dir)
  await reopened.load()
  assert.equal((await reopened.list()).find(x => x.id === list.id).coverPath, undefined, '文件没了就不再引用它')
}))
