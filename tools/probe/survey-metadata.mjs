/**
 * Survey what metadata and lyrics actually exist in a local library.
 *
 * Before writing an embedded-lyric reader and a tag writer, it is worth knowing
 * which containers and tag formats are actually present. This walks a folder
 * and reports the real distribution.
 *
 * Usage: node tools/probe/survey-metadata.mjs [folder]
 */
import { readdir, stat } from 'node:fs/promises'
import { extname, join } from 'node:path'
import { parseFile } from 'music-metadata'

const folder = process.argv[2] ?? 'D:\\Music\\华语歌曲'

const byExt = new Map()
const byCodec = new Map()
let total = 0
let withEmbeddedLyrics = 0
let withSyncLyrics = 0
let withCover = 0
let withReplayGain = 0
let withIsrc = 0
let withTrackNo = 0
const lyricSamples = []
const tagKeyCounts = new Map()

/** Depth-limited walk. */
async function* walk(dir, depth = 0) {
  if (depth > 4) return
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) yield* walk(full, depth + 1)
    else if (entry.isFile() && /\.(mp3|flac|m4a|ogg|wav|ape|dsf|wma)$/i.test(entry.name)) yield full
  }
}

const started = Date.now()
for await (const file of walk(folder)) {
  total += 1
  const ext = extname(file).slice(1).toLowerCase()
  byExt.set(ext, (byExt.get(ext) ?? 0) + 1)

  try {
    const metadata = await parseFile(file, { duration: false, skipCovers: true })
    const common = metadata.common
    const format = metadata.format

    const codec = format.codec ?? '?'
    byCodec.set(codec, (byCodec.get(codec) ?? 0) + 1)

    if (common.picture?.length) withCover += 1
    if (common.track?.no) withTrackNo += 1
    if (common.isrc?.length) withIsrc += 1
    if (common.replaygain_track_gain) withReplayGain += 1

    // The field we care about for this task.
    const lyrics = common.lyrics
    if (Array.isArray(lyrics) && lyrics.length > 0) {
      withEmbeddedLyrics += 1
      const sync = lyrics.find((l) => Array.isArray(l.syncText) && l.syncText.length > 0)
      if (sync) {
        withSyncLyrics += 1
        if (lyricSamples.length < 3) {
          lyricSamples.push({
            file: file.split(/[\\/]/).pop(),
            contentType: sync.contentType,
            lines: sync.syncText.length,
            first: sync.syncText[0]
          })
        }
      } else if (lyricSamples.length < 3) {
        lyricSamples.push({
          file: file.split(/[\\/]/).pop(),
          contentType: lyrics[0].contentType,
          lines: 0,
          text: (lyrics[0].text ?? '').slice(0, 80)
        })
      }
    }

    // Which tag keys are present at all — informs what a tag editor can offer.
    for (const key of Object.keys(common)) {
      if (common[key] === undefined) continue
      tagKeyCounts.set(key, (tagKeyCounts.get(key) ?? 0) + 1)
    }
  } catch {
    /* unreadable file; already counted */
  }
}

const elapsed = Date.now() - started

console.log(`folder: ${folder}`)
console.log(`files:  ${total}   (${elapsed} ms)\n`)

console.log('--- 容器分布 ---')
for (const [ext, count] of [...byExt].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${ext.padEnd(6)} ${count}`)
}

console.log('\n--- 编解码器 ---')
for (const [codec, count] of [...byCodec].sort((a, b) => b[1] - a[1]).slice(0, 8)) {
  console.log(`  ${codec.padEnd(24)} ${count}`)
}

console.log('\n--- 标签覆盖 ---')
const pct = (n) => `${((n / Math.max(1, total)) * 100).toFixed(0)}%`
console.log(`  内嵌歌词      ${withEmbeddedLyrics} (${pct(withEmbeddedLyrics)})`)
console.log(`  ├ 逐行同步    ${withSyncLyrics} (${pct(withSyncLyrics)})`)
console.log(`  封面          ${withCover} (${pct(withCover)})`)
console.log(`  音轨号        ${withTrackNo} (${pct(withTrackNo)})`)
console.log(`  ISRC          ${withIsrc} (${pct(withIsrc)})`)
console.log(`  ReplayGain    ${withReplayGain} (${pct(withReplayGain)})`)

console.log('\n--- 常见标签键 ---')
for (const [key, count] of [...tagKeyCounts].sort((a, b) => b[1] - a[1]).slice(0, 16)) {
  console.log(`  ${key.padEnd(22)} ${count}`)
}

if (lyricSamples.length > 0) {
  console.log('\n--- 歌词样本 ---')
  for (const sample of lyricSamples) {
    console.log(`  ${sample.file}  type=${sample.contentType} lines=${sample.lines}`)
    if (sample.first) console.log(`    ${JSON.stringify(sample.first)}`)
    if (sample.text) console.log(`    ${sample.text}`)
  }
}
