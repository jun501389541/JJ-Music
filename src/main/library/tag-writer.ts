/**
 * Tag writing.
 *
 * ## Scope, and why it is limited on purpose
 *
 * The library on this machine is 98% FLAC. FLAC stores tags as Vorbis comments,
 * and `music-metadata` is a **reader only** — there is no general-purpose
 * writer for Vorbis comments in the dependency set.
 *
 * Writing them correctly means rewriting the metadata block while preserving
 * the audio frames and the padding block, which is a format-specific job. Doing
 * it badly risks corrupting a user's music files, so this module is explicit
 * about what it supports:
 *
 *   - **MP3 / ID3v2** — full write support via `node-id3` (title, artist,
 *     album, year, track, genre, cover, and lyrics as a `USLT` text frame).
 *     `SYLT` is deliberately *not* written: the library appends that frame
 *     instead of replacing it, so a second timed write would leave the old one
 *     winning on read — see `writeMp3`.
 *   - **FLAC** — implemented directly here for the fields we need, writing the
 *     Vorbis comment block and the picture block. The rewrite preserves every
 *     audio frame and only replaces those two blocks.
 *   - **OGG / Opus** — *not* writable, despite also using Vorbis comments. They
 *     sit inside Ogg pages, so any edit means re-splitting packets across pages
 *     and recomputing each page's CRC; that is a different job from FLAC's
 *     flat block chain, and getting it wrong yields a file that no longer
 *     decodes. `music-metadata` still reads them, and the settings page says so.
 *
 * Every write goes through `backupOnce()`, which keeps a `.bak` copy the first
 * time a file is modified. Tag writing is destructive by nature; a user who
 * dislikes the result must be able to get their file back.
 */
import { existsSync } from 'node:fs'
import { copyFile, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { extname } from 'node:path'
import NodeID3 from 'node-id3'
import type { TagPatch, TagWriteResult } from '@shared/library-types'

// The patch shape is declared in `@shared/library-types` because the renderer
// needs it too. Re-exported so main-process callers can import it from here.
export type { TagPatch }

/** Alias kept for brevity inside this module. */
type WriteResult = TagWriteResult

/**
 * The formats this module has a writer for — the ceiling, not the setting.
 *
 * `tagWritableFormats` in settings can only narrow this list, never extend it,
 * so a renderer that writes that key cannot make the app modify a container it
 * has no tested writer for.
 */
export const WRITABLE_TAG_FORMATS = ['.mp3', '.flac']

/**
 * Formats the app may modify in place.
 *
 * `allowed` is the user's whitelist; entries are matched loosely so `.mp3`,
 * `mp3` and `MP3` all mean the same thing.
 */
export function canWriteTags(filePath: string, allowed: string[] = WRITABLE_TAG_FORMATS): boolean {
  const ext = extname(filePath).toLowerCase()
  if (!WRITABLE_TAG_FORMATS.includes(ext)) return false
  if (!Array.isArray(allowed)) return false
  // A set, because `allowed` is renderer-supplied: normalising it per call would
  // make a bulk write over a library quadratic in the size of a list this app
  // never bounds. Entries the user cannot write are dropped here either way.
  const normalised = new Set<string>()
  for (const item of allowed) {
    if (typeof item !== 'string') continue
    normalised.add((item.startsWith('.') ? item : `.${item}`).toLowerCase())
  }
  return normalised.has(ext)
}

/** A line-start LRC timestamp, which is all the exporter needs to know. */
const LRC_TIMESTAMP = /\[\d{1,3}:\d{2}(?:[.:]\d{1,3})?\]/

/** True when the text carries per-line LRC timestamps. */
export function lyricHasTimestamps(text: string): boolean {
  return LRC_TIMESTAMP.test(text)
}

/**
 * Keep a one-time backup beside the original.
 *
 * Only the first modification creates a backup, so repeated edits do not
 * overwrite the user's pristine copy with an already-modified one.
 */
async function backupOnce(filePath: string): Promise<string | undefined> {
  const backupPath = `${filePath}.bak`
  if (existsSync(backupPath)) return undefined
  try {
    await copyFile(filePath, backupPath)
    return backupPath
  } catch {
    throw new Error('无法创建标签备份，未修改原文件')
  }
}

/**
 * What "the file is not ours to replace right now" looks like on Windows.
 *
 * An open handle makes `rename` fail with EPERM rather than EBUSY, and an
 * antivirus or the search indexer touching the file mid-write can answer EACCES.
 * All three are worth waiting a few hundred milliseconds for; anything else is a
 * real error and retrying it only delays the message.
 */
const LOCK_CODES = new Set(['EPERM', 'EBUSY', 'EACCES'])
const RENAME_TRIES = 4
const RENAME_BACKOFF_MS = 150

const wait = (ms: number): Promise<void> => new Promise(resolve => { setTimeout(resolve, ms) })

/** Write tags atomically: temp file in the same directory, then rename. */
async function replaceFile(filePath: string, data: Buffer): Promise<void> {
  const tmp = `${filePath}.jjtmp`
  await writeFile(tmp, data)
  let code = ''
  for (let attempt = 0; attempt < RENAME_TRIES; attempt++) {
    try {
      await rename(tmp, filePath)
      return
    } catch (error) {
      code = (error as NodeJS.ErrnoException).code ?? ''
      if (!LOCK_CODES.has(code)) break
      // Back off between tries: the caller has already been asked to put the file
      // down, and a player releasing a stream is a matter of frames, not seconds.
      if (attempt < RENAME_TRIES - 1) await wait(RENAME_BACKOFF_MS * (attempt + 1))
    }
  }
  /*
   * The temp file is the new tags and nothing else. Keeping it would leave a
   * multi-megabyte orphan in the user's music folder for every failed write —
   * and the original is untouched either way, so nothing is lost by removing it.
   */
  await unlink(tmp).catch(() => undefined)
  if (LOCK_CODES.has(code)) {
    // Marked so the one case with an actionable user message can be turned into a
    // note, while every other failure keeps propagating as an error.
    throw Object.assign(new Error(
      '文件正被其他程序占用，无法替换（通常是这首歌正在播放）。已停止播放并重试仍未成功——请暂停或切到其他曲目后再试一次。'
    ), { locked: true, code })
  }
  throw new Error(`替换标签文件失败：${code || '未知错误'}`)
}

/* ------------------------------------------------------------------ *
 * MP3 (ID3v2)
 * ------------------------------------------------------------------ */

async function writeMp3(filePath: string, patch: TagPatch): Promise<WriteResult> {
  const tags: NodeID3.Tags = {}

  if (patch.title) tags.title = patch.title
  if (patch.artist) tags.artist = patch.artist
  if (patch.album) tags.album = patch.album
  if (patch.albumArtist) tags.performerInfo = patch.albumArtist
  if (patch.year) tags.year = String(patch.year)
  if (patch.trackNo) tags.trackNumber = String(patch.trackNo)
  if (patch.genre) tags.genre = patch.genre
  if (patch.lyrics) {
    // `USLT` only, and deliberately not `SYLT` even when the text is timed.
    //
    // Measured against a real file (`.cache/probe-sylt.cjs`): `node-id3`'s
    // `update()` treats array-valued frames as *append*, so a second synced
    // write leaves two `SYLT` frames and a reader takes the first — the stale
    // one. `synchronisedLyrics: []` does not delete them either. Since the LRC
    // text itself keeps the line timings, and this app (and the players that
    // parse `[mm:ss]` out of a lyric string) read them from the text, the frame
    // would buy nothing and cost a growing, wrong-ordered tag.
    tags.unsynchronisedLyrics = { language: 'chi', text: patch.lyrics }
  }
  if (patch.cover) {
    tags.image = {
      mime: patch.cover.mimeType,
      type: { id: 3, name: 'front cover' },
      description: 'Cover',
      imageBuffer: Buffer.from(patch.cover.data)
    }
  }

  /*
   * `node-id3` writes in place and answers `true`, or an Error describing why it
   * could not. A locked file is the common reason on Windows — the same song the
   * user is tagging is the one playing — so it gets the same short backoff as the
   * FLAC rename, and the same plain-language note instead of a silent false.
   */
  let last: true | Error | unknown = true
  for (let attempt = 0; attempt < RENAME_TRIES; attempt++) {
    last = NodeID3.update(tags, filePath)
    if (last === true) return { written: true, note: '已写入 ID3v2 标签' }
    if (attempt < RENAME_TRIES - 1) await wait(RENAME_BACKOFF_MS * (attempt + 1))
  }
  return {
    written: false,
    note: `文件正被其他程序占用，无法写入标签${last instanceof Error && last.message ? `（${last.message}）` : ''}。通常是这首歌正在播放——请暂停或切到其他曲目后再试一次。`
  }
}

/* ------------------------------------------------------------------ *
 * FLAC (Vorbis comments)
 * ------------------------------------------------------------------ */

/** Map our patch fields onto the Vorbis comment keys the ecosystem uses. */
function toVorbisComments(patch: TagPatch): Array<[string, string]> {
  const out: Array<[string, string]> = []
  const push = (key: string, value: string | number | undefined): void => {
    if (value === undefined || value === '') return
    out.push([key, String(value)])
  }
  push('TITLE', patch.title)
  push('ARTIST', patch.artist)
  push('ALBUM', patch.album)
  push('ALBUMARTIST', patch.albumArtist)
  push('DATE', patch.year)
  push('TRACKNUMBER', patch.trackNo)
  push('GENRE', patch.genre)
  // `LYRICS` is the de-facto key; `UNSYNCEDLYRICS` is the older one. Both are
  // written so any reader finds it. Vorbis comments have no synchronised-lyrics
  // frame at all, so the LRC timestamps stay inside the text — which is what the
  // players that read these keys (and the ecosystem's own taggers) expect.
  push('LYRICS', patch.lyrics)
  push('UNSYNCEDLYRICS', patch.lyrics)
  return out
}

/**
 * Build a Vorbis comment block.
 *
 * Layout (little-endian):
 *   vendor_length:u32, vendor:string,
 *   comment_count:u32, then for each: length:u32, "KEY=value"
 */
function buildVorbisComment(vendor: string, comments: Array<[string, string]>): Buffer {
  const parts: Buffer[] = []

  const vendorBuf = Buffer.from(vendor, 'utf8')
  const vendorLength = Buffer.alloc(4)
  vendorLength.writeUInt32LE(vendorBuf.length, 0)
  parts.push(vendorLength, vendorBuf)

  const count = Buffer.alloc(4)
  count.writeUInt32LE(comments.length, 0)
  parts.push(count)

  for (const [key, value] of comments) {
    const entry = Buffer.from(`${key.toUpperCase()}=${value}`, 'utf8')
    const length = Buffer.alloc(4)
    length.writeUInt32LE(entry.length, 0)
    parts.push(length, entry)
  }

  return Buffer.concat(parts)
}

/** Parse an existing Vorbis comment block into key/value pairs. */
function parseVorbisComment(block: Buffer): {
  vendor: string
  comments: Array<[string, string]>
} {
  let offset = 0
  const vendorLength = block.readUInt32LE(offset)
  offset += 4
  const vendor = block.subarray(offset, offset + vendorLength).toString('utf8')
  offset += vendorLength

  const count = block.readUInt32LE(offset)
  offset += 4

  const comments: Array<[string, string]> = []
  for (let i = 0; i < count && offset + 4 <= block.length; i += 1) {
    const length = block.readUInt32LE(offset)
    offset += 4
    if (offset + length > block.length) break
    const entry = block.subarray(offset, offset + length).toString('utf8')
    offset += length
    const eq = entry.indexOf('=')
    if (eq > 0) comments.push([entry.slice(0, eq), entry.slice(eq + 1)])
  }

  return { vendor, comments }
}

/**
 * Rewrite a FLAC file's VORBIS_COMMENT block.
 *
 * FLAC layout: `fLaC`, then a chain of metadata blocks each with a 4-byte
 * header (1 bit last-block, 7 bits type, 24-bit length). Type 4 is
 * VORBIS_COMMENT. We keep every other block byte-for-byte and rebuild only the
 * comment block, then append the untouched audio frames.
 */
async function writeFlac(filePath: string, patch: TagPatch): Promise<WriteResult> {
  const file = await readFile(filePath)
  if (file.length < 8 || file.subarray(0, 4).toString('latin1') !== 'fLaC') {
    return { written: false, note: '不是有效的 FLAC 文件' }
  }

  const additions = toVorbisComments(patch)
  if (additions.length === 0 && !patch.cover) return { written: false, note: '没有需要写入的字段' }

  const blocks: Array<{ type: number; data: Buffer; last: boolean }> = []
  let offset = 4

  while (offset + 4 <= file.length) {
    const header = file[offset]
    const isLast = (header & 0x80) !== 0
    const type = header & 0x7f
    const length = (file[offset + 1] << 16) | (file[offset + 2] << 8) | file[offset + 3]
    const dataStart = offset + 4
    const dataEnd = dataStart + length
    if (dataEnd > file.length) throw new Error('FLAC 元数据块不完整，未修改原文件')

    blocks.push({ type, data: file.subarray(dataStart, dataEnd), last: isLast })
    offset = dataEnd
    if (isLast) break
  }

  if (blocks.length === 0) return { written: false, note: 'FLAC 元数据块解析失败' }
  if(blocks[0].type!==0 || blocks[0].data.length!==34 || !blocks[blocks.length-1].last) throw new Error('FLAC 元数据链无效，未修改原文件')

  // Audio frames are everything after the metadata chain.
  const audio = file.subarray(offset)

  // Merge into the existing comment block, replacing keys we are setting.
  const existingIndex = blocks.findIndex((b) => b.type === 4)
  const replacing = new Set(additions.map(([key]) => key.toUpperCase()))

  let vendor = 'JJ Music'
  const merged: Array<[string, string]> = []

  if (existingIndex >= 0) {
    const parsed = parseVorbisComment(blocks[existingIndex].data)
    vendor = parsed.vendor || vendor
    for (const [key, value] of parsed.comments) {
      // Drop the keys being replaced, and drop the duplicate lyric key so we do
      // not accumulate one copy per edit.
      if (replacing.has(key.toUpperCase())) continue
      if (key.toUpperCase() === 'UNSYNCEDLYRICS' && patch.lyrics) continue
      merged.push([key, value])
    }
  }

  merged.push(...additions)

  const commentBlock = buildVorbisComment(vendor, merged)
  const newBlocks = blocks.filter((block, index) => index !== existingIndex && !(patch.cover && block.type === 6 && block.data.length >= 4 && block.data.readUInt32BE(0) === 3))
  newBlocks.push({ type: 4, data: commentBlock, last: false })
  if (patch.cover) {
    const u32 = (value: number): Buffer => { const b=Buffer.alloc(4);b.writeUInt32BE(value);return b }
    const mime=Buffer.from(patch.cover.mimeType,'ascii'), image=Buffer.from(patch.cover.data)
    const picture=Buffer.concat([u32(3),u32(mime.length),mime,u32(0),u32(0),u32(0),u32(0),u32(0),u32(image.length),image])
    if (picture.length > 0xffffff) throw Error('FLAC 封面超过元数据块大小限制')
    newBlocks.push({type:6,data:picture,last:false})
  }
  // VORBIS_COMMENT must precede the audio; ordering matters to some readers, so
  // sort by type with STREAMINFO (0) first, which is what the spec requires.
  newBlocks.sort((a, b) => a.type - b.type)

  const pieces: Buffer[] = [Buffer.from('fLaC', 'latin1')]
  newBlocks.forEach((block, index) => {
    if (block.data.length > 0xffffff) throw Error('FLAC 元数据块过大')
    const isLast = index === newBlocks.length - 1
    const header = Buffer.alloc(4)
    header[0] = (isLast ? 0x80 : 0) | (block.type & 0x7f)
    header[1] = (block.data.length >> 16) & 0xff
    header[2] = (block.data.length >> 8) & 0xff
    header[3] = block.data.length & 0xff
    pieces.push(header, block.data)
  })
  pieces.push(audio)

  await replaceFile(filePath, Buffer.concat(pieces))
  return {
    written: true,
    note: `已写入 Vorbis 注释（${merged.length} 个字段）`
  }
}

/* ------------------------------------------------------------------ *
 * Entry point
 * ------------------------------------------------------------------ */

/**
 * Write a tag patch to a file, creating a backup first.
 *
 * `dryRun` reports what would happen without touching the file, which the UI
 * uses to show a preview before the user commits.
 */
export async function writeTags(
  filePath: string,
  patch: TagPatch,
  options: { dryRun?: boolean; skipBackup?: boolean } = {}
): Promise<WriteResult> {
  if (!existsSync(filePath)) {
    return { written: false, note: '文件不存在' }
  }

  const ext = extname(filePath).toLowerCase()
  if (!canWriteTags(filePath)) {
    return {
      written: false,
      note: `${ext || '该'} 格式暂不支持写入标签（目前支持 MP3 与 FLAC）`
    }
  }

  if (options.dryRun) {
    const fields = Object.entries(patch)
      .filter(([, value]) => value !== undefined && value !== '')
      .map(([key]) => key)
    return { written: false, note: `将写入: ${fields.join(', ') || '(无)'}` }
  }

  const backupPath = options.skipBackup ? undefined : await backupOnce(filePath)

  /*
   * A refused replacement is reported, not thrown. The caller turns a
   * `written: false` into a note the user can read and act on; an exception would
   * surface as the Node text (`EPERM: operation not permitted, rename '…' -> '…'`)
   * over a file the user asked us to fix, which is the message that started this.
   *
   * Only that case. A FLAC chain that cannot be parsed or a picture over the block
   * limit is a fact about the file, and the downloader depends on the rejection to
   * leave such a file untouched and say why — swallowing those would turn a loud
   * failure into a silent one.
   */
  let result: WriteResult
  try {
    result =
      ext === '.mp3'
        ? await writeMp3(filePath, patch)
        : await writeFlac(filePath, patch)
  } catch (error) {
    if ((error as { locked?: boolean })?.locked !== true) throw error
    result = { written: false, note: error instanceof Error ? error.message : '标签写入失败' }
  }

  return backupPath ? { ...result, backupPath } : result
}
