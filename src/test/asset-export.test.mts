/**
 * Asset destinations: sidecar naming, the writable-format whitelist, the one
 * writer that decides where a cover or lyric lands, and the queue of fetched
 * assets not yet committed.
 *
 * ## What this pins that nothing else did
 *
 * The behaviour most likely to silently regress is the *negative* one: a write
 * that must not happen. Unchecking a format has to leave the user's file
 * untouched; a staging file must not grow a sidecar in a temp folder; an
 * automatic pass must not eat a `.lrc` the user wrote by hand. Each of those is
 * asserted by reading the bytes afterwards, not by trusting the returned note.
 *
 * The MP3 section is the other half: it writes a synchronised lyric and then a
 * plain one into a real file, because `node-id3` *merges* frames — if the old
 * SYLT survives, this app (which prefers synchronised text) would keep showing
 * the lyric the user just replaced. That case cannot be checked against a
 * synthetic file, so it is skipped — loudly — when no real library is present.
 *
 * Usage: node out/test/asset-export.test.mjs [library-folder]
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const load = (rel) => import(pathToFileURL(join(repoRoot, 'out', 'test', rel)).href)

const {
  coverSidecarCandidates,
  coverSidecarPathFor,
  findCoverSidecar,
  imageExtensionForMime,
  imageMimeFor,
  sidecarPathFor
} = await load('library/asset-files.js')
const { exportAssets, mergeAssets } = await load('library/asset-export.js')
const { WRITABLE_TAG_FORMATS, canWriteTags, lyricHasTimestamps } = await load('library/tag-writer.js')
const { PendingAssetStore } = await load('library/pending-assets.js')
const { MusicLibrary } = await load('library/music-library.js')

let passed = 0
let failed = 0
let skipped = 0

function check(name, ok, detail = '') {
  if (ok) {
    passed += 1
    console.log(`  PASS  ${name}`)
  } else {
    failed += 1
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

function skip(name, why) {
  skipped += 1
  console.log(`  SKIP  ${name} (${why})`)
}

const scratch = mkdtempSync(join(tmpdir(), 'jj-assets-'))
const PNG = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c6300010000050001' +
    '0d0a2db40000000049454e44ae426082',
  'hex'
)

console.log('='.repeat(72))
console.log('资产写入：命名、格式白名单、落点与待写入队列')
console.log('='.repeat(72))

/* ------------------------------------------------------------------ *
 * 1. Sidecar naming
 * ------------------------------------------------------------------ */

console.log('\n--- 1. 同目录文件的命名 ---')

check('.lrc 与原文件同名同目录', sidecarPathFor(join('M', 'Song.flac')) === join('M', 'Song.lrc'))
check('封面 sidecar 按音频名生成', coverSidecarPathFor(join('M', 'Song.flac'), 'image/png') === join('M', 'Song.png'))
check('未知的 mime 退回 .jpg', imageExtensionForMime('image/bmp') === '.jpg' && imageExtensionForMime(undefined) === '.jpg')
check('扩展名反查 mime', imageMimeFor('.PNG') === 'image/png' && imageMimeFor('webp') === 'image/webp' && imageMimeFor('.txt') === undefined)

const candidates = coverSidecarCandidates(join('M', 'Song.flac'))
check('先找这首歌自己的名字', candidates.slice(0, 4).join() === [join('M', 'Song.jpg'), join('M', 'Song.jpeg'), join('M', 'Song.png'), join('M', 'Song.webp')].join(), candidates.slice(0, 4).join(' | '))
check('cover.jpg 也在读取名单里，且排在同名封面之后', candidates.indexOf(join('M', 'cover.jpg')) === 4, `${candidates.indexOf(join('M', 'cover.jpg'))}`)
check('名单里至少有 5 个约定名 × 4 种扩展名', candidates.length >= 24, `${candidates.length}`)

const dir = join(scratch, 'naming')
put(join(dir, 'keep.txt'), 'x')
put(join(dir, 'Song.flac'), 'not really flac')
put(join(dir, 'cover.jpg'), PNG)
check('只有 cover.jpg 时用它', findCoverSidecar(join(dir, 'Song.flac'))?.path === join(dir, 'cover.jpg'))
put(join(dir, 'Song.png'), PNG)
check('同名封面优先于 cover.jpg', findCoverSidecar(join(dir, 'Song.flac'))?.path === join(dir, 'Song.png'))
check('同名封面的 mime 由扩展名给出', findCoverSidecar(join(dir, 'Song.flac'))?.mimeType === 'image/png')
// A folder with images in it *should* find them for any track inside, so the
// negative case needs a folder of its own — otherwise this checks nothing.
put(join(scratch, 'bare', 'nothing.flac'), 'not really flac')
check('目录里确实没有封面时返回空', findCoverSidecar(join(scratch, 'bare', 'nothing.flac')) === null)

/* ------------------------------------------------------------------ *
 * 2. The writable-format whitelist
 * ------------------------------------------------------------------ */

console.log('\n--- 2. 可改写格式白名单 ---')

check('默认允许 MP3 与 FLAC', canWriteTags('a.mp3') && canWriteTags('a.flac') && WRITABLE_TAG_FORMATS.length === 2)
check('白名单能收窄', !canWriteTags('a.mp3', ['.flac']) && canWriteTags('a.flac', ['.flac']))
check('白名单不能放宽（这是天花板）', !canWriteTags('a.wav', ['.wav', '.mp3']) && !canWriteTags('a.ogg', ['.ogg']))
check('写法宽松也算数：缺前缀点与大写', canWriteTags('a.mp3', ['MP3']) && canWriteTags('A.MP3', ['.MP3']))
check('坏输入不炸', !canWriteTags('a.mp3', null) && !canWriteTags('a.mp3', [42, undefined]))
check('带时间轴的判断只认 LRC 时间戳', lyricHasTimestamps('[00:12.40]词') && !lyricHasTimestamps('纯文本歌词'))

/* ------------------------------------------------------------------ *
 * 3. exportAssets: where a write lands
 * ------------------------------------------------------------------ */

console.log('\n--- 3. 统一的写入动作 ---')

const trackDir = join(scratch, 'track')
const audio = join(trackDir, 'Song.flac')
put(audio, 'fake flac body')

const sidecarWrite = await exportAssets({
  audioPath: audio,
  patch: { lyrics: '[00:01.00]第一行\r\n[00:02.00]第二行' },
  to: ['sidecar']
})
check('sidecar 目标写出同名 .lrc', existsSync(sidecarPathFor(audio)))
check('返回体说清楚写到了哪里', sidecarWrite.landed.join() === '同目录文件' && sidecarWrite.paths.join() === sidecarPathFor(audio), sidecarWrite.landed.join())
check('写入的词按 LF 落盘（跨播放器兼容）', !readFileSync(sidecarPathFor(audio), 'utf8').includes('\r'))
check('provenance 记着带时间轴', sidecarWrite.assets?.lyrics?.main?.[0]?.origin === 'sidecar' && sidecarWrite.assets.lyrics.main[0].synced === true)

// A format the app cannot modify must not be touched, and must say so.
const wavDir = join(scratch, 'wav')
const wav = join(wavDir, 'Only.wav')
put(wav, 'original wav bytes')
const before = readFileSync(wav)
const refused = await exportAssets({ audioPath: wav, patch: { lyrics: '[00:01.00]词' }, to: ['embedded'] })
check('不能改写的格式一个字节都不动', readFileSync(wav).equals(before))
check('它改存同名文件并说明原因', refused.landed.join() === '同目录文件' && refused.notes.some((n) => n.includes('不支持写入标签')), JSON.stringify(refused.notes))
check('提示语是将来时还是过去时：已写入', refused.note.startsWith('已写入'), refused.note)

const previewBefore = existsSync(sidecarPathFor(wav)) ? readFileSync(sidecarPathFor(wav), 'utf8') : null
const preview = await exportAssets({ audioPath: wav, patch: { lyrics: '[00:09.00]词' }, to: ['embedded'], dryRun: true })
check(
  '预览说将来时、且不落盘',
  preview.note.startsWith('将写入') &&
    (previewBefore === null ? !existsSync(sidecarPathFor(wav)) : readFileSync(sidecarPathFor(wav), 'utf8') === previewBefore),
  `${preview.note} / ${existsSync(sidecarPathFor(wav))}`
)
// `paths` 是"真的改过的文件"，将来时由 note 表达；调用方靠它决定要不要重读文件、
// 要不要清掉待写入条目，预览里填上路径就等于让预览去改索引。
check('预览不列出任何"已改过"的文件', preview.paths.length === 0, JSON.stringify(preview.paths))

// 标题/艺术家这类文本字段只有标签装得下，所以"写入位置=同名文件"也不能让它们静默消失。
const metaOnly = await exportAssets({ audioPath: wav, patch: { title: '新标题', artist: '新歌手' }, to: ['sidecar'] })
check(
  '文本字段仍然会试着走标签那一路，即使设置里只要同名文件',
  metaOnly.notes.some((n) => n.includes('文本字段未写入')),
  JSON.stringify(metaOnly.notes)
)
check('它一个文件都没改', metaOnly.paths.length === 0 && !metaOnly.embeddedWritten, JSON.stringify(metaOnly.paths))

// Downloads write a staging file; a sidecar must never appear next to it.
const stageDir = join(scratch, 'stage')
const staged = join(stageDir, '.jj-task.flac')
put(staged, 'staged bytes')
const stagedResult = await exportAssets({
  audioPath: staged,
  stagingPath: staged,
  patch: { lyrics: '[00:01.00]词' },
  to: ['embedded', 'sidecar']
})
check('暂存文件旁不生成 sidecar', !existsSync(sidecarPathFor(staged)))
check('并说明为什么留到定名之后', stagedResult.notes.some((n) => n.includes('尚未定名')), JSON.stringify(stagedResult.notes))

// An automatic pass must not overwrite a lyric file the user placed.
put(sidecarPathFor(audio), '用户自己写的词')
const clobbered = await exportAssets({ audioPath: audio, patch: { lyrics: '[00:01.00]自动抓的' }, to: ['sidecar'], noClobber: true })
check('自动写入不覆盖同名 .lrc', readFileSync(sidecarPathFor(audio), 'utf8') === '用户自己写的词')
check('它改口说未覆盖', !clobbered.written && clobbered.notes.some((n) => n.includes('未覆盖')), JSON.stringify(clobbered.notes))

// ...and the explicit one does overwrite, which is the whole point of the flag.
const explicit = await exportAssets({ audioPath: audio, patch: { lyrics: '[00:01.00]用户选的' }, to: ['sidecar'] })
check('显式写入会覆盖（noClobber 关掉后）', explicit.written && readFileSync(sidecarPathFor(audio), 'utf8').includes('用户选的'))

const nothing = await exportAssets({ audioPath: audio, patch: { lyrics: '   ' }, to: ['sidecar'] })
check('空白歌词什么都不做', !nothing.written && nothing.paths.length === 0 && nothing.note === '未写入任何内容', nothing.note)

const coverWrite = await exportAssets({ audioPath: audio, patch: { cover: { data: new Uint8Array(PNG), mimeType: 'image/png' } }, to: ['sidecar'] })
check('封面写成同名 png', existsSync(join(trackDir, 'Song.png')) && coverWrite.paths[0] === join(trackDir, 'Song.png'))
check('封面的 provenance 记着 mime', coverWrite.assets?.cover?.[0]?.provider === 'image/png')

/* ------------------------------------------------------------------ *
 * 4. Provenance merging
 * ------------------------------------------------------------------ */

console.log('\n--- 4. 来源链合并 ---')

const merged = mergeAssets({ lyrics: { main: [{ origin: 'embedded', synced: true }] } }, coverWrite.assets)
check('合并保留既有来源', merged.lyrics?.main?.[0]?.origin === 'embedded')
check('封面新来源并进同一条链', merged.cover?.[0]?.origin === 'sidecar')
const bothWays = mergeAssets({ cover: [{ origin: 'embedded' }] }, { cover: [{ origin: 'sidecar' }] })
check('同目录文件排在文件内嵌之前（解析优先级）', bothWays.cover.map((e) => e.origin).join('>') === 'sidecar>embedded', bothWays.cover.map((e) => e.origin).join('>'))
const deduped = mergeAssets({ cover: [{ origin: 'sidecar', provider: 'image/jpeg' }] }, { cover: [{ origin: 'sidecar', provider: 'image/png' }] })
check('同一来源被替换而不是叠加', deduped.cover.length === 1 && deduped.cover[0].provider === 'image/png')

/* ------------------------------------------------------------------ *
 * 5. The scanner records what it finds
 * ------------------------------------------------------------------ */

console.log('\n--- 5. 扫描器记录资产来源 ---')

const libraryDir = join(scratch, 'library')
const musicDir = join(libraryDir, 'music')
put(join(musicDir, 'Only.flac'), 'fake')
put(join(musicDir, 'Only.lrc'), '[00:01.00]一行词')
put(join(musicDir, 'cover.jpg'), PNG)
const library = new MusicLibrary(libraryDir)
await library.load()
await library.addFolder(musicDir)
const indexed = library.getAll().find((track) => track.name === 'Only')
check('同名 .lrc 记在链首', indexed?.assets?.lyrics?.main?.[0]?.origin === 'sidecar', JSON.stringify(indexed?.assets?.lyrics?.main))
check('文件内没有封面时，cover.jpg 被收进记录', indexed?.assets?.cover?.[0]?.origin === 'sidecar')
check('并且直接由该文件提供图片（不再抽一份缓存）', indexed?.coverPath === join(musicDir, 'cover.jpg'), indexed?.coverPath)

/* ------------------------------------------------------------------ *
 * 6. The 待写入 queue
 * ------------------------------------------------------------------ */

console.log('\n--- 6. 待写入队列 ---')

const pending = new PendingAssetStore(libraryDir)
await pending.load()
check('初始为空', pending.list().length === 0)
await pending.add({ trackId: 't1', kind: 'lyric', name: '甲', singer: '乙', path: audio, lyric: '[00:01.00]词', synced: true, origin: 'remote', provider: 'search', at: 1 })
await pending.add({ trackId: 't2', kind: 'lyric', name: '丙', singer: '丁', path: audio, lyric: '词', origin: 'remote', at: 2 })
check('两条都在册', pending.list().length === 2 && pending.list()[0].trackId === 't1')
await pending.add({ trackId: 't1', kind: 'lyric', name: '甲', singer: '乙', path: audio, lyric: '换了一条', origin: 'remote', at: 9 })
check('同一曲同一类只留最新一条（不累积）', pending.list().length === 2 && pending.list().find((e) => e.trackId === 't1').at === 9)
await pending.add({ trackId: 't1', kind: 'cover', name: '甲', singer: '乙', path: audio, image: { path: join(musicDir, 'cover.jpg'), mimeType: 'image/jpeg' }, origin: 'remote', at: 3 })
check('一首歌可以有两条（词与图互不覆盖）', pending.list().length === 3)

const reopened = new PendingAssetStore(libraryDir)
const loadedEntries = await reopened.load()
check('重启后队列还在', loadedEntries.length === 3, `${loadedEntries.length}`)
check('队列文件就在数据目录里', existsSync(join(libraryDir, 'library', 'pending-assets.json')))

await reopened.removeEntries(loadedEntries.filter((entry) => entry.trackId === 't1'))
check('删除指定条目后只剩别的', (await reopened.load()).length === 1)
const reread = new PendingAssetStore(libraryDir)
check('删除真的落盘了', (await reread.load()).length === 1)

// Garbage on disk must not be trusted.
put(join(libraryDir, 'library', 'pending-assets.json'), JSON.stringify([
  { trackId: 'ok', kind: 'lyric', name: 'n', singer: 's', path: audio, lyric: '词', origin: 'remote', at: 1 },
  { kind: 'lyric', path: audio, lyric: '词', at: 1 },
  { trackId: 'no-file', kind: 'lyric', name: 'n', singer: 's', path: '', lyric: '词', at: 1 },
  { trackId: 'no-lyric', kind: 'lyric', name: 'n', singer: 's', path: audio, at: 1 },
  { trackId: 'cover-less-image', kind: 'cover', name: 'n', singer: 's', path: audio, at: 1 },
  { trackId: 'no-time', kind: 'lyric', name: 'n', singer: 's', path: audio, lyric: '词' },
  'not an object'
]))
const validated = new PendingAssetStore(libraryDir)
const kept = await validated.load()
check('坏数据一条条挡掉', kept.length === 1 && kept[0].trackId === 'ok', JSON.stringify(kept.map((e) => e.trackId)))

/* ------------------------------------------------------------------ *
 * 7. Real files: what a tag write actually leaves behind
 * ------------------------------------------------------------------ */

console.log('\n--- 7. 真实文件的标签往返 ---')

const libraryFolder = process.argv[2] ?? 'D:\\Music\\华语歌曲'

if (!existsSync(libraryFolder)) {
  skip('MP3 / FLAC 标签往返', `找不到曲库样本目录 ${libraryFolder}`)
  skip('带时间轴标签的遮蔽问题', '同上')
} else {
  const { readEmbeddedLyric } = await load('library/embedded-lyrics.js')
  const { parseFile } = await import('music-metadata')
  const samples = await pickSamples(libraryFolder, readEmbeddedLyric)

  if (!samples.plainMp3) {
    skip('MP3 写入往返', '样本目录里没有 MP3')
  } else {
    const copy = join(scratch, 'plain.mp3')
    put(copy, readFileSync(samples.plainMp3))
    const wroteSynced = await exportAssets({
      audioPath: copy,
      patch: { lyrics: '[00:00.50]带时间轴的一行\n[00:12.75]第二行' },
      to: ['embedded'],
      writableFormats: ['.mp3']
    })
    check('MP3 内嵌写入成功', wroteSynced.written && wroteSynced.landed.join() === '文件内嵌', wroteSynced.note)
    const readBack = await readEmbeddedLyric(copy)
    check('写进去的时间轴读得回来', (readBack?.lyric ?? '').includes('带时间轴的一行') && readBack?.synchronized === true, JSON.stringify(readBack?.synchronized))

    // Two writes must not accumulate: `node-id3` appends multi-value frames, which
    // is the reason the writer keeps to the single-valued plain-text frame.
    await exportAssets({ audioPath: copy, patch: { lyrics: '第二次写的纯文本' }, to: ['embedded'], writableFormats: ['.mp3'] })
    const frames = (await parseFile(copy, { duration: false, skipCovers: true })).common.lyrics ?? []
    check('反复写歌词不会堆出多份标签', frames.length === 1, `${frames.length} 份`)
    check('读到的就是第二次写的那条', ((await readEmbeddedLyric(copy))?.lyric ?? '').includes('第二次写的纯文本'))
  }

  if (!samples.plainMp3) {
    skip('带时间轴标签的遮蔽问题', '样本目录里没有 MP3')
  } else {
    // Built rather than hunted for: whether a given file already carries a
    // `SYLT` frame is a fact about the sample, while what must hold afterwards
    // is a fact about the app. The frame writer works fine — it is *deleting*
    // one that `node-id3` cannot do, which is what this pins.
    const NodeID3 = (await import('node-id3')).default
    const copy = join(scratch, 'synced.mp3')
    put(copy, readFileSync(samples.plainMp3))
    // `write`, not `update`: the sample may carry its own lyric tags, and this
    // fixture has to start from exactly one timed frame holding known text.
    NodeID3.write(
      {
        unsynchronisedLyrics: { language: 'chi', text: '[00:00.50]旧的时间轴歌词' },
        synchronisedLyrics: [
          {
            language: 'chi',
            timeStampFormat: NodeID3.TagConstants.TimeStampFormat.MILLISECONDS,
            contentType: NodeID3.TagConstants.SynchronisedLyrics.ContentType.LYRICS,
            shortText: 'Lyrics',
            synchronisedText: [
              { text: '旧的时间轴歌词', timeStamp: 500 },
              { text: '旧的最后一行', timeStamp: 12000 }
            ]
          }
        ]
      },
      copy
    )
    const before = await readEmbeddedLyric(copy)
    check('样本现在带着真正的 SYLT 时间轴标签', before?.synchronized === true && (before.lyric ?? '').includes('旧的时间轴歌词'), JSON.stringify(before?.lyric))

    const wrote = await exportAssets({
      audioPath: copy,
      patch: { lyrics: '新写的纯文本歌词' },
      to: ['embedded'],
      writableFormats: ['.mp3']
    })
    const after = await readEmbeddedLyric(copy)
    // 调用方判断"要不要重读这个文件"用的是 embeddedWritten，不是界面文案；
    // 文案改一个字就让刷新静默失效，是这轮审查看出来的耦合。
    check('真的改了标签时 embeddedWritten 为真', wrote.embeddedWritten === true && wrote.paths.join() === copy, JSON.stringify(wrote.paths))
    // The known limit: the tag was written, and the timed frame still wins on
    // read. So the write has to arrive with a warning that says so…
    check('旧的时间轴标签仍然优先被读到（这是已知边界）', (after?.lyric ?? '').includes('旧的时间轴歌词'), JSON.stringify(after?.lyric))
    check('写入时如实提醒了这一点', wrote.notes.some((note) => note.includes('带时间轴') && note.includes('同目录文件')), JSON.stringify(wrote.notes))
    // …and the escape it points at has to work: a sidecar outranks both tags.
    await exportAssets({ audioPath: copy, patch: { lyrics: '新写的纯文本歌词' }, to: ['sidecar'] })
    const { resolveLocalLyric } = await load('library/lyric-service.js')
    const resolved = await resolveLocalLyric({ id: copy, path: copy, name: '旧的时间轴歌词', singer: '测试', assets: { lyrics: { main: [{ origin: 'embedded', synced: true }] } } }, { allowOnline: false })
    check('改用同目录文件后，新歌词赢了', resolved.source === 'sidecar' && resolved.lyric.includes('新写的纯文本歌词'), `${resolved.source} / ${resolved.lyric.slice(0, 24)}`)
  }

  if (!samples.flac) {
    skip('FLAC Vorbis 注释往返', '样本目录里没有 FLAC')
  } else {
    const copy = join(scratch, 'real.flac')
    put(copy, readFileSync(samples.flac))
    const wrote = await exportAssets({
      audioPath: copy,
      patch: { lyrics: '[00:01.00]FLAC 的一行' },
      to: ['embedded'],
      writableFormats: ['.flac']
    })
    check('FLAC 内嵌写入成功', wrote.written, wrote.note)
    check('FLAC 读回带时间轴的词（LRC 文本存在 LYRICS 里）', ((await readEmbeddedLyric(copy))?.lyric ?? '').includes('FLAC 的一行'))
    check('备份留在原目录（.bak 只留第一份）', existsSync(`${copy}.bak`))
    const size = statSync(`${copy}.bak`).size
    await exportAssets({ audioPath: copy, patch: { lyrics: '[00:02.00]第二次' }, to: ['embedded'], writableFormats: ['.flac'] })
    check('第二次写入不会覆盖那份备份', statSync(`${copy}.bak`).size === size)
    const plain = await exportAssets({ audioPath: copy, patch: { lyrics: 'FLAC 的纯文本' }, to: ['embedded'], writableFormats: ['.flac'] })
    check('FLAC 换写成纯文本不需要警告（没有第二种标签可读）', !plain.notes.some((note) => note.includes('带时间轴')), JSON.stringify(plain.notes))
  }
}

/**
 * Find sample files to write into.
 *
 * The synced-lyric MP3 has to be *searched* for: the point of that section is a
 * tag we cannot delete, so a sample without it proves nothing.
 */
async function pickSamples(folder, readEmbedded) {
  const found = { plainMp3: null, syncedMp3: null, flac: null }
  const queue = [folder]
  let inspected = 0
  while (queue.length && inspected < 120) {
    const current = queue.pop()
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name)
      if (entry.isDirectory()) {
        queue.push(path)
        continue
      }
      if (!found.flac && /\.flac$/i.test(entry.name)) found.flac = path
      if (/\.mp3$/i.test(entry.name)) {
        if (!found.plainMp3) found.plainMp3 = path
        if (!found.syncedMp3 && inspected < 60) {
          inspected += 1
          const lyric = await readEmbedded(path).catch(() => null)
          if (lyric?.synchronized) found.syncedMp3 = path
        }
      }
      if (found.flac && found.plainMp3 && found.syncedMp3) return found
    }
  }
  return found
}

/* ------------------------------------------------------------------ *
 * Summary
 * ------------------------------------------------------------------ */

rmSync(scratch, { recursive: true, force: true })

console.log('\n' + '='.repeat(72))
console.log(`${passed} 通过 / ${failed} 失败${skipped ? ` / ${skipped} 跳过` : ''}`)
console.log('='.repeat(72))
if (failed) process.exitCode = 1

/** Write a file, creating its folder: most fixtures here are one level deep. */
function put(path, content) {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, content)
}
