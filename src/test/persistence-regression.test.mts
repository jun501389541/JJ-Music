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

/**
 * 损坏的配置文件必须留下证据，而不是被空状态盖掉。
 *
 * 每个 store 都是「读不出来就退回默认值，然后下一次改动写盘」。对**不存在**的文件
 * 这是对的；对**被截断**的文件这是毁灭性的：磁盘写满、异常退出、云盘同步到一半，
 * 都会让用户的歌单/设置在被替换成空的一份之后彻底消失，连一句提示都没有。
 *
 * 这里钉的是「原字节还在」和「恢复出来的就是原来那份」，因为把文件改名成
 * `.corrupt-*` 后仍然要求**用户自己**去 %APPDATA% 里找，等于没救。
 */
test('损坏的设置文件被留档，而不是被默认值静默覆盖', () => fixture(async dir => {
  const path = join(dir, 'settings.json')
  const damaged = '{"volume": 0.3, "showQualityBadge": tr'
  await writeFile(path, damaged)

  const store = new SettingsStore(dir)
  const loaded = await store.load()
  assert.equal(loaded.volume, 0.8, '读不出来就退回默认值，这一步没变')

  const [kept] = (await readdir(dir)).filter(name => name.startsWith('settings.json.corrupt-'))
  assert.ok(kept, '损坏的文件被改名留档，而不是原地留着等下一次写盘盖掉')
  assert.equal(await readFile(join(dir, kept), 'utf8'), damaged, '留档的是原始字节，一个字都没动')

  // 下一步照常工作：写入不会碰到那份留档，也不会再有第二份。
  await store.update({ volume: 0.42 })
  assert.equal((await new SettingsStore(dir).load()).volume, 0.42)
  assert.deepEqual(JSON.parse(await readFile(path, 'utf8')).volume, 0.42)
  assert.equal((await readdir(dir)).filter(name => name.includes('.corrupt-')).length, 1)
}))

test('损坏的曲库索引同样留档，重启后不会假装曲库是空的', () => fixture(async dir => {
  const index = join(dir, 'library')
  await mkdir(index, { recursive: true })
  const path = join(index, 'index.json')
  const damaged = '{"version": 3, "folders": ["D:\\\\Music"], "tracks": [{"pa'
  await writeFile(path, damaged)

  const library = new MusicLibrary(dir)
  await library.load()
  assert.equal(library.getAll().length, 0)
  const [kept] = (await readdir(index)).filter(name => name.startsWith('index.json.corrupt-'))
  assert.ok(kept, '索引被留档')
  assert.equal(await readFile(join(index, kept), 'utf8'), damaged)

  /*
   * 索引只剩空的一份，但曲库不会因此看起来是空的：`src/main/index.ts:338-346` 会把
   * `settings.json` 里的 libraryFolders 与索引里的目录取并集，缺的那个重新 addFolder
   * （顺带扫描）。这里钉住那条恢复链的起点——目录列表确实丢了，必须靠设置侧补回来。
   */
  assert.deepEqual(library.getFolders(), [], '索引里的目录列表也丢了，这正是要恢复的东西')
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

/**
 * 歌单音质档回填。这是唯一一处会**改写用户真实歌单数据**的新代码，所以钉得比较死：
 * 顺序不能变（歌单顺序是用户自己拖出来的）、`meta` 里原有的键不能丢（`songmid`/`hash`/
 * `albumId`/`copyrightId` 是各平台解析播放地址要用的，丢了那首歌就再也解不开）、
 * 重复调用必须是 0（第二次打开同一个歌单不该再问一遍平台）。
 */
const onlineTrack = (id, meta) => ({ id, source: 'wy', name: `n-${id}`, singer: 's', interval: '03:00', albumName: '', picUrl: '', meta })
const localTrack = id => ({ id, path: `C:/music/${id}.flac`, name: `n-${id}`, singer: 's', size: 1, mtimeMs: 1, duration: 180 })

async function seededList(dir) {
  const playlists = new PlaylistStore(dir)
  await playlists.load()
  const list = await playlists.create('忆')
  await playlists.addTracks(list.id, [
    onlineTrack('wy_1', { songmid: '1', albumId: 38789 }),
    onlineTrack('wy_2', { songmid: '2', copyrightId: 'c2' }),
    localTrack('local_3')
  ])
  return { playlists, id: list.id }
}

test('patchQualitys fills tiers without touching order or the other meta keys', () => fixture(async dir => {
  const { playlists, id } = await seededList(dir)
  const touched = await playlists.patchQualitys(id, [
    { id: 'wy_2', qualitys: [{ type: '128k', size: '4.20 MB' }, { type: 'flac', size: '27.10 MB' }] },
    { id: 'wy_1', qualitys: [{ type: 'flac24bit', size: '41.55 MB' }] }
  ])
  assert.equal(touched, 2)
  const items = await new PlaylistStore(dir).getItems(id)
  assert.deepEqual(items.map(t => t.id), ['wy_1', 'wy_2', 'local_3'], '顺序必须原样，回填不是重写')
  assert.deepEqual(items[0].meta, { songmid: '1', albumId: 38789, qualitys: [{ type: 'flac24bit', size: '41.55 MB' }] })
  assert.deepEqual(items[1].meta.qualitys, [{ type: '128k', size: '4.20 MB' }, { type: 'flac', size: '27.10 MB' }])
  assert.equal(items[1].meta.copyrightId, 'c2', 'meta 是按键合并的，不是整个替换')
  assert.equal(items[2].meta, undefined, '本地曲目没有 meta，也不该被造一个出来')
}))

test('patchQualitys is idempotent and never rewrites a list it cannot change', () => fixture(async dir => {
  const { playlists, id } = await seededList(dir)
  const patch = [{ id: 'wy_1', qualitys: [{ type: 'flac', size: '27.10 MB' }] }]
  assert.equal(await playlists.patchQualitys(id, patch), 1)
  // 第二次同样的值 → 0。这个 0 就是"打开过一次的歌单不再发请求"的落盘侧保证。
  assert.equal(await playlists.patchQualitys(id, patch), 0)
  assert.deepEqual(await readdir(dir), ['playlists.json'], '没改动就不该留下临时文件')
  // 空补丁、不存在的歌单、空歌单都不该写盘。
  assert.equal(await playlists.patchQualitys(id, []), 0)
  assert.equal(await playlists.patchQualitys('no-such-list', patch), 0)
  const empty = await playlists.create('空')
  assert.equal(await playlists.patchQualitys(empty.id, patch), 0)
  assert.deepEqual((await new PlaylistStore(dir).getItems(id)).map(t => t.id), ['wy_1', 'wy_2', 'local_3'])
}))
