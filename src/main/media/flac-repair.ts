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
  /** Offset just past the whole metadata region (where audio frames begin). */
  audioAt: number
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
function locateEmptyMimePicture(head: Buffer, audioAt: number): PictureLayout | null {
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

      return { blockAt: offset, payloadAt, descLengthAt, dataAt, audioAt }
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

export interface FlacRepairResult {
  /** Path to serve: the repaired cache copy, or the original when untouched. */
  path: string
  /** True when a repair copy was produced. */
  repaired: boolean
  /** The MIME that was filled in, when a repair happened. */
  mime?: string
}

/**
 * Ensure a playable copy of a FLAC exists.
 *
 * Files whose picture MIME is already set are returned unchanged (the common
 * case, costing one small read). A file that needs repair gets a cache copy
 * under `cacheDir`, keyed by its path+mtime+size so a re-tagged file is not
 * served stale.
 */
export async function ensurePlayableFlac(
  filePath: string,
  cacheDir: string
): Promise<FlacRepairResult> {
  const region = readMetadataRegion(filePath)
  if (!region) return { path: filePath, repaired: false }

  const layout = locateEmptyMimePicture(region.head, region.audioAt)
  if (!layout) return { path: filePath, repaired: false }

  const stat = statSync(filePath)
  const key = createHash('sha1')
    .update(`${filePath}|${stat.size}|${stat.mtimeMs}`)
    .digest('hex')
    .slice(0, 16)
  const cached = join(cacheDir, `${key}.flac`)

  if (existsSync(cached)) return { path: cached, repaired: true }

  const mime = detectMime(region.head.subarray(layout.dataAt, layout.dataAt + 4))
  const mimeBytes = Buffer.from(mime, 'ascii')
  const mimeLengthField = Buffer.alloc(4)
  mimeLengthField.writeUInt32BE(mimeBytes.length)

  // New payload = picture type + [mimeLen][mime] + everything from descLen on.
  const payload = Buffer.concat([
    region.head.subarray(layout.payloadAt, layout.payloadAt + 4),
    mimeLengthField,
    mimeBytes,
    region.head.subarray(layout.descLengthAt)
  ])
  const blockHeader = Buffer.from(region.head.subarray(layout.blockAt, layout.payloadAt))
  blockHeader.writeUIntBE(payload.length, 1, 3)

  const newHead = Buffer.concat([
    region.head.subarray(0, layout.blockAt),
    blockHeader,
    payload
  ])

  mkdirSync(cacheDir, { recursive: true })
  // Write to a temp name first so a crash cannot leave a half-written cache
  // file that later looks like a valid cache hit.
  const tmp = `${cached}.${process.pid}.tmp`
  try {
    // Straightforward write-then-append rather than `pipeline(..., {end:false})`:
    // that option leaves the destination open for the caller, but `pipeline`
    // still waits for the destination to finish, which deadlocks.
    const handle = await open(tmp, 'w')
    try {
      await handle.write(newHead)
      // Append the audio frames verbatim; they are unchanged by the repair.
      for await (const chunk of createReadStream(filePath, { start: region.audioAt })) {
        await handle.write(chunk as Buffer)
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
