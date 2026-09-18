/**
 * Repair for FLAC files Chromium refuses to decode.
 *
 * ## The bug
 *
 * A FLAC's PICTURE metadata block carries a MIME type string. Some taggers
 * write that field **empty**. Chromium's FFmpeg demuxer models an attached
 * picture as a video stream and needs the MIME to pick a decoder — with an
 * empty MIME it cannot build that stream and gives up on the *whole
 * container*:
 *
 *   DEMUXER_ERROR_COULD_NOT_OPEN: FFmpegDemuxer: open context failed
 *
 * The file looks fine everywhere else: `music-metadata` reads it (it only
 * parses STREAMINFO), the library indexes it with the correct title and
 * duration, and the bytes stream over `jjmedia://` perfectly. Only playback
 * fails — exactly the "shows in my library but won't play" report.
 *
 * Measured on a real library: 3 of 3357 FLAC files (0.1%) carry an empty MIME,
 * so this is a per-file defect rather than a systematic one. Verified fix: with
 * the MIME field set to `image/jpeg` the same file decodes and reports 218 s.
 *
 * ## Why a cached copy rather than a rewritten file
 *
 * The audio is intact and the picture is a valid JPEG; only a metadata string
 * is missing. Rewriting the user's file would be intrusive (the app's tag
 * writer deliberately refuses to touch files it cannot fully validate), so the
 * repair is written to a cache file and served from there — the original is
 * never modified.
 *
 * A cached copy (rather than patching bytes in the response stream) is what
 * keeps seeking working: inserting the MIME shifts every subsequent byte, so
 * range requests would otherwise be served at the wrong offsets.
 */

import { createReadStream, existsSync, mkdirSync, openSync, readSync, closeSync, statSync, renameSync, unlinkSync } from 'node:fs'
import { open } from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'
import { join } from 'node:path'
import { createHash } from 'node:crypto'

/** A FLAC metadata block header is 4 bytes: flags/type, then a 24-bit length. */
const BLOCK_HEADER = 4
const PICTURE_BLOCK_TYPE = 6
/** Metadata sits before the audio; this bound stops a malformed file being read whole. */
const MAX_METADATA_BYTES = 4 * 1024 * 1024

interface PictureLayout {
  /** Offset of the block header within the metadata region. */
  blockAt: number
  /** Offset of the payload (the picture-type field). */
  payloadAt: number
  /** Offset of `descLen` — i.e. immediately after the empty MIME field. */
  descLengthAt: number
  /** Offset of the image data. */
  dataAt: number
  /** The block's declared 24-bit length, so the payload slice stays in bounds. */
  blockLength: number
}

/**
 * Read a file's FLAC metadata region.
 *
 * Returns the bytes and the audio offset, or `null` when the file is not a FLAC
 * or its metadata is implausibly large.
 */
function readMetadataRegion(filePath: string): { head: Buffer; audioAt: number } | null {
  let fd: number
  try {
    fd = openSync(filePath, 'r')
  } catch {
    return null
  }
  try {
    const size = statSync(filePath).size
    const probe = Buffer.alloc(Math.min(size, MAX_METADATA_BYTES))
    const read = readSync(fd, probe, 0, probe.length, 0)
    const buf = probe.subarray(0, read)
    if (buf.length < 8 || buf.toString('ascii', 0, 4) !== 'fLaC') return null

    let offset = 4
    for (let guard = 0; guard < 64; guard += 1) {
      if (offset + BLOCK_HEADER > buf.length) return null
      const header = buf[offset]
      const last = (header & 0x80) !== 0
      const length = buf.readUIntBE(offset + 1, 3)
      offset += BLOCK_HEADER + length
      if (last) {
        return offset <= buf.length ? { head: buf.subarray(0, offset), audioAt: offset } : null
      }
    }
    return null
  } finally {
    closeSync(fd)
  }
}

/** Locate the PICTURE block's fields, only when its MIME is empty. */
function locateEmptyMimePicture(head: Buffer): PictureLayout | null {
  let offset = 4
  while (offset + BLOCK_HEADER <= head.length) {
    const header = head[offset]
    const last = (header & 0x80) !== 0
    const type = header & 0x7f
    const length = head.readUIntBE(offset + 1, 3)
    const payloadAt = offset + BLOCK_HEADER

    if (type === PICTURE_BLOCK_TYPE) {
      if (payloadAt + 8 > head.length) return null
      const mimeLength = head.readUInt32BE(payloadAt + 4)
      if (mimeLength !== 0) return null // a MIME is present: nothing to repair

      const descLengthAt = payloadAt + 8 // the empty MIME occupies no bytes
      if (descLengthAt + 4 > head.length) return null
      const descLength = head.readUInt32BE(descLengthAt)
      const dataAt = descLengthAt + 4 + descLength + 16 + 4
      if (dataAt > head.length) return null

      return { blockAt: offset, payloadAt, descLengthAt, dataAt, blockLength: length }
    }

    offset += BLOCK_HEADER + length
    if (last) return null
  }
  return null
}

/** Identify the image format from its magic bytes, so the MIME is truthful. */
function detectMime(data: Buffer): string {
  if (data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4e && data[3] === 0x47) return 'image/png'
  if (data[0] === 0x47 && data[1] === 0x49 && data[2] === 0x46) return 'image/gif'
  if (data[0] === 0x42 && data[1] === 0x4d) return 'image/bmp'
  return 'image/jpeg' // FLAC covers are overwhelmingly JPEG
}

/**
 * Write a whole buffer, looping on short writes.
 *
 * `FileHandle.write` is allowed to write fewer bytes than asked (the write may
 * be interrupted), and ignoring `bytesWritten` silently truncates the output —
 * which for a 600 KB metadata buffer meant a corrupt cache file. Regular files
 * usually write in full, but "usually" is not a contract.
 */
async function writeAll(handle: FileHandle, data: Buffer): Promise<void> {
  let written = 0
  while (written < data.length) {
    const { bytesWritten } = await handle.write(data, written)
    if (bytesWritten <= 0) throw new Error(`flac-repair: short write at offset ${written}`)
    written += bytesWritten
  }
}

export interface FlacRepairResult {
  /** Path to serve: the repaired cache copy, or the original when untouched. */
  path: string
  /** True when a repair copy was produced. */
  repaired: boolean
  /** The MIME that was filled in, when a repair happened. */
  mime?: string
}

/**
 * Bump when the repair output changes shape.
 *
 * ## Why a cache version is not optional
 *
 * The key used to be `sha1(path|size|mtime)` alone. When the repair algorithm
 * was fixed, every previously-cached entry kept the *same* key — the source
 * file had not changed — so the fixed code happily reused copies produced by
 * the broken algorithm. On a real machine that is exactly what happened: the
 * file still would not play after the fix because the corrupt cache entry was
 * served again, and every test passed because tests always ran against a fresh
 * temporary directory, where no stale entry existed.
 *
 * Versioning the key means a change in this file's output invalidates every
 * older entry, which is the property the un-versioned key silently lacked.
 */
const CACHE_VERSION = 2

/**
 * Validate a cached copy before trusting it.
 *
 * `existsSync` is not sufficient: a partially written or algorithmically stale
 * file is still a file. Walking the block chain and confirming the audio starts
 * at a frame sync costs one small read and turns "cache poisoning is invisible"
 * into "a bad entry repairs itself".
 */
function isUsableCache(filePath: string): boolean {
  let fd: number
  try {
    fd = openSync(filePath, 'r')
  } catch {
    return false
  }
  try {
    const size = statSync(filePath).size
    if (size <= 0) return false
    let offset = 4
    const magic = Buffer.alloc(4)
    if (readSync(fd, magic, 0, 4, 0) < 4 || magic.toString('ascii') !== 'fLaC') return false
    for (let guard = 0; guard < 64; guard += 1) {
      const header = Buffer.alloc(BLOCK_HEADER)
      if (readSync(fd, header, 0, BLOCK_HEADER, offset) < BLOCK_HEADER) return false
      const last = (header[0] & 0x80) !== 0
      const type = header[0] & 0x7f
      if (type > 6) return false // 7..126 are invalid block types
      const length = header.readUIntBE(1, 3)
      offset += BLOCK_HEADER + length
      if (offset > size) return false
      if (last) break
    }
    // The audio must begin on a frame sync word, or the chain ended wrongly.
    const frame = Buffer.alloc(2)
    if (readSync(fd, frame, 0, 2, offset) < 2) return false
    return frame[0] === 0xff && (frame[1] & 0xfc) === 0xf8
  } catch {
    return false
  } finally {
    closeSync(fd)
  }
}

/**
 * Ensure a playable copy of a FLAC exists.
 *
 * Files whose picture MIME is already set are returned unchanged (the common
 * case, costing one small read). A file that needs repair gets a cache copy
 * under `cacheDir`.
 */
export async function ensurePlayableFlac(
  filePath: string,
  cacheDir: string
): Promise<FlacRepairResult> {
  const region = readMetadataRegion(filePath)
  if (!region) return { path: filePath, repaired: false }

  const layout = locateEmptyMimePicture(region.head)
  if (!layout) return { path: filePath, repaired: false }

  const stat = statSync(filePath)
  const key = createHash('sha1')
    .update(`v${CACHE_VERSION}|${filePath}|${stat.size}|${stat.mtimeMs}`)
    .digest('hex')
    .slice(0, 16)
  const cached = join(cacheDir, `${key}.flac`)

  // Trust the cache only after confirming the bytes are a coherent FLAC.
  // A bad entry is deleted rather than served, so it regenerates below.
  if (existsSync(cached)) {
    if (isUsableCache(cached)) return { path: cached, repaired: true }
    try { unlinkSync(cached) } catch { /* regenerate regardless */ }
  }

  const mime = detectMime(region.head.subarray(layout.dataAt, layout.dataAt + 4))
  const mimeBytes = Buffer.from(mime, 'ascii')
  const mimeLengthField = Buffer.alloc(4)
  mimeLengthField.writeUInt32BE(mimeBytes.length)

  // New payload = picture type + [mimeLen][mime] + the rest of THIS block.
  //
  // The slice must stop at the block's own end: `head` continues past the
  // picture into any following blocks (this file had PADDING after it), and an
  // unbounded slice would swallow them into the picture payload — corrupting
  // the block chain so thoroughly that Chromium still refuses the file, just
  // with a different error. Found by byte-comparing the copy against the
  // original: the block length came out 25084 larger than it should be, the
  // exact size of the trailing PADDING block.
  const pictureEnd = layout.payloadAt + layout.blockLength
  if (pictureEnd > region.head.length) {
    // The declared block length runs past the metadata region: a malformed
    // file we do not know how to repair. Serve the original untouched.
    return { path: filePath, repaired: false }
  }
  const payload = Buffer.concat([
    region.head.subarray(layout.payloadAt, layout.payloadAt + 4),
    mimeLengthField,
    mimeBytes,
    region.head.subarray(layout.descLengthAt, pictureEnd)
  ])
  const blockHeader = Buffer.from(region.head.subarray(layout.blockAt, layout.payloadAt))
  blockHeader.writeUIntBE(payload.length, 1, 3)

  // The repaired metadata region: everything before the picture block, the
  // grown picture block, then the remaining blocks (PADDING etc.) unchanged.
  // Missing that tail would silently drop trailing blocks — the first version
  // of this repair lost the file's PADDING block exactly that way.
  const newHead = Buffer.concat([
    region.head.subarray(0, layout.blockAt),
    blockHeader,
    payload,
    region.head.subarray(pictureEnd)
  ])

  mkdirSync(cacheDir, { recursive: true })
  // Write to a temp name first so a crash cannot leave a half-written cache
  // file that later looks like a valid cache hit.
  const tmp = `${cached}.${process.pid}.tmp`
  try {
    const handle = await open(tmp, 'w')
    try {
      await writeAll(handle, newHead)
      // Append the audio frames verbatim; they are unchanged by the repair.
      for await (const chunk of createReadStream(filePath, { start: region.audioAt })) {
        await writeAll(handle, chunk as Buffer)
      }
    } finally {
      await handle.close()
    }
    renameSync(tmp, cached)
  } catch {
    try { unlinkSync(tmp) } catch { /* best effort */ }
    // Repair is an enhancement: fall back to the original file rather than
    // failing playback outright.
    return { path: filePath, repaired: false }
  }

  return { path: cached, repaired: true, mime }
}
