/**
 * Test of the FLAC repair path used when a source file's cover has an empty
 * MIME type and Chromium refuses to open the container.
 *
 * ## What this covers that the earlier checks did not
 *
 * The first two repair attempts were verified by calling the module and by
 * serving through the protocol, and both passed — yet the file still would not
 * play on a real machine. Two gaps caused that:
 *
 *   1. the protocol layer whitelisted the repaired copy but never served it
 *      (the file actually read is derived from the request URL), and
 *   2. the cache was trusted via `existsSync`, so entries written by the broken
 *      algorithm kept being served after the algorithm was fixed. Every earlier
 *      test ran against a fresh temporary cache directory, where no stale entry
 *      existed, so that bug could not appear.
 *
 * So this test builds real FLAC files, drives `serveMedia` with the same
 * substitute plumbing the app uses, and asserts on the *bytes that leave the
 * protocol layer* — plus explicit cases for stale and corrupt cache entries,
 * which is the failure mode that reached the user.
 *
 * Run with:  node out/test/flac-repair.test.mjs
 */
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const { ensurePlayableFlac } = await import('./media/flac-repair.js')
const { serveMedia } = await import('./media/media-response.js')

let passed = 0
let failed = 0
function check(name, condition, detail = '') {
  if (condition) {
    passed += 1
    console.log(`  PASS  ${name}`)
  } else {
    failed += 1
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

console.log('\nFLAC repair')

/* ------------------------------------------------------------------ *
 * Fixtures
 * ------------------------------------------------------------------ */

/** Build a FLAC with the given metadata blocks and a minimal audio payload. */
function buildFlac({ pictureMime, withPadding = true, paddingBytes = 512 }) {
  const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32BE(n >>> 0); return b }
  const block = (type, payload, last = false) => {
    const header = Buffer.alloc(4)
    header[0] = (last ? 0x80 : 0) | type
    header.writeUIntBE(payload.length, 1, 3)
    return Buffer.concat([header, payload])
  }

  // STREAMINFO: 44.1 kHz, 2ch, 16-bit (the repair does not decode it).
  const streamInfo = Buffer.alloc(34)
  streamInfo.writeUInt16BE(4096, 0)
  streamInfo.writeUInt16BE(4096, 2)
  streamInfo[10] = 0x0a
  streamInfo[11] = 0xc4
  streamInfo[12] = 0x40

  const vendor = Buffer.from('vendor', 'ascii')
  const commentPayload = Buffer.concat([u32(vendor.length), vendor, u32(0)])

  // A tiny but structurally real JPEG (SOI .. EOI).
  const jpeg = Buffer.concat([
    Buffer.from([0xff, 0xd8, 0xff, 0xe0]),
    u32(16),
    Buffer.from('JFIF\0', 'ascii'),
    Buffer.from([0xff, 0xd9])
  ])
  const mimeBytes = Buffer.from(pictureMime, 'ascii')
  const picturePayload = Buffer.concat([
    u32(3),
    u32(mimeBytes.length), mimeBytes,
    u32(0),                       // empty description
    u32(1), u32(1), u32(24), u32(0),
    u32(jpeg.length), jpeg
  ])

  return Buffer.concat([
    Buffer.from('fLaC', 'ascii'),
    block(0, streamInfo),
    block(4, commentPayload),
    block(6, picturePayload),
    // PADDING is the final metadata block: a repair that slices to the end of
    // the metadata region instead of the picture's own end will swallow it.
    block(1, Buffer.alloc(withPadding ? paddingBytes : 0), true),
    // Audio, starting immediately after the metadata as a real encoder writes it.
    Buffer.from([0xff, 0xf8, 0x59, 0xa8]),
    Buffer.alloc(4096, 0xa5)
  ])
}

/**
 * Walk the metadata chain the way a decoder would.
 *
 * Defensive by design: it is used on deliberately corrupt fixtures, so it must
 * report a bad chain rather than throw. A helper that crashes on the input it
 * exists to describe turns a clear failure into a stack trace.
 */
function walkChain(buf) {
  let offset = 4
  const blocks = []
  let overran = false
  for (let guard = 0; guard < 64; guard += 1) {
    if (offset + 4 > buf.length) { overran = true; break }
    const header = buf.subarray(offset, offset + 4)
    const last = (header[0] & 0x80) !== 0
    const type = header[0] & 0x7f
    const length = buf.readUIntBE(offset + 1, 3)
    blocks.push({ type, length, last, at: offset })
    offset += 4 + length
    if (offset > buf.length) { overran = true; break }
    if (last) break
  }
  const frame = offset + 4 <= buf.length ? buf.subarray(offset, offset + 4) : Buffer.alloc(4)
  return {
    blocks,
    audioAt: offset,
    overran,
    syncOk: !overran && frame[0] === 0xff && (frame[1] & 0xfc) === 0xf8,
    typesValid: !overran && blocks.every((b) => b.type <= 6)
  }
}

/** The URL the renderer would use for a local file. */
function mediaUrl(filePath) {
  return 'jjmedia://local/' + filePath.replace(/\\/g, '/').split('/').map(encodeURIComponent).join('/')
}

const workDir = mkdtempSync(join(tmpdir(), 'flac-repair-test-'))
const cacheDir = join(workDir, 'cache')
const brokenPath = join(workDir, 'broken.flac')
const healthyPath = join(workDir, 'healthy.flac')

try {
  writeFileSync(brokenPath, buildFlac({ pictureMime: '' }))
  writeFileSync(healthyPath, buildFlac({ pictureMime: 'image/jpeg' }))

  /* ---------------------------------------------------------------- *
   * 1. Detection and repair
   * ---------------------------------------------------------------- */
  const healthy = await ensurePlayableFlac(healthyPath, cacheDir)
  check('a file whose cover already has a MIME is served unchanged',
    healthy.path === healthyPath && healthy.repaired === false)

  const repaired = await ensurePlayableFlac(brokenPath, cacheDir)
  check('an empty cover MIME produces a repaired copy',
    repaired.repaired === true && repaired.path !== brokenPath, repaired.path)
  check('the MIME filled in is detected from the image bytes',
    repaired.mime === 'image/jpeg', String(repaired.mime))

  /* ---------------------------------------------------------------- *
   * 2. The repaired bytes are structurally correct
   *
   * These are the assertions that would have caught the two corruption bugs:
   * an unbounded payload slice that swallowed the PADDING block, and a rebuilt
   * metadata region that dropped everything after the picture.
   * ---------------------------------------------------------------- */
  const copy = readFileSync(repaired.path)
  const original = readFileSync(brokenPath)
  const chain = walkChain(copy)
  const mimeLength = 'image/jpeg'.length

  check('every metadata block type is valid (<= 6)',
    chain.typesValid, chain.blocks.map((b) => `t${b.type}`).join(','))
  check('the audio starts on a frame sync word', chain.syncOk)
  check('the repaired copy is exactly the original plus the MIME bytes',
    copy.length === original.length + mimeLength,
    `${copy.length} vs ${original.length + mimeLength}`)
  check('blocks following the picture (PADDING) are preserved',
    chain.blocks.some((b) => b.type === 1),
    chain.blocks.map((b) => `t${b.type}(${b.length})`).join(' -> '))
  check('the last metadata block is still flagged last',
    chain.blocks[chain.blocks.length - 1].last === true)

  // Byte-for-byte reconstruction from the original.
  const pictureAt = chain.blocks[0].at + 4 + chain.blocks[0].length + 4 + chain.blocks[1].length
  const mimeLenAt = pictureAt + 4 + 4 // block header + picture type
  const descLenAt = mimeLenAt + 4
  const expected = Buffer.concat([
    original.subarray(0, mimeLenAt),
    (() => { const b = Buffer.alloc(4); b.writeUInt32BE(mimeLength); return b })(),
    Buffer.from('image/jpeg', 'ascii'),
    original.subarray(descLenAt)
  ])
  expected.writeUIntBE(original.readUIntBE(pictureAt + 1, 3) + mimeLength, pictureAt + 1, 3)
  check('the repaired copy matches a byte-for-byte reconstruction', copy.equals(expected))

  check('the original file is not modified', readFileSync(brokenPath).equals(original))
  check('the audio bytes are carried over unchanged',
    copy.subarray(chain.audioAt).equals(original.subarray(walkChain(original).audioAt)))

  /* ---------------------------------------------------------------- *
   * 3. Stale and corrupt cache entries
   *
   * The failure that reached the user: the cache was trusted on existence
   * alone, so a copy written by the older, broken algorithm kept being served.
   * ---------------------------------------------------------------- */
  const entries = readdirSync(cacheDir)
  check('the cache holds exactly one entry', entries.length === 1, entries.join(','))
  const cachedFile = join(cacheDir, entries[0])

  /**
   * Corrupt the entry the way the real broken algorithm did: a picture block
   * whose declared length overruns into the following blocks, leaving an
   * invalid block type in the chain. This is the exact shape that reached the
   * user's machine, and it must not be served.
   */
  const corrupt = Buffer.from(copy)
  corrupt.writeUIntBE(0x0fffff, pictureAt + 1, 3)
  writeFileSync(cachedFile, corrupt)
  const corruptChain = walkChain(readFileSync(cachedFile))
  check('the corrupt fixture really is invalid (precondition)',
    !corruptChain.typesValid, corruptChain.blocks.map((b) => `t${b.type}`).join(','))

  const afterCorrupt = await ensurePlayableFlac(brokenPath, cacheDir)
  const regenerated = readFileSync(afterCorrupt.path)
  check('a cache entry with an invalid block chain is rejected and rebuilt',
    walkChain(regenerated).typesValid && walkChain(regenerated).syncOk &&
    regenerated.length === original.length + mimeLength,
    `len=${regenerated.length} expected=${original.length + mimeLength}`)
  check('the rejected entry is overwritten, not accumulated',
    readdirSync(cacheDir).length === 1, readdirSync(cacheDir).join(','))

  // A cache entry that is not a FLAC at all must also be rejected.
  writeFileSync(cachedFile, Buffer.from('not a flac file at all'))
  const afterGarbage = await ensurePlayableFlac(brokenPath, cacheDir)
  const rebuilt = readFileSync(afterGarbage.path)
  check('a non-FLAC cache entry is rejected and rebuilt',
    rebuilt.subarray(0, 4).toString('ascii') === 'fLaC' && walkChain(rebuilt).syncOk)

  // A truncated FLAC must be rejected.
  writeFileSync(cachedFile, copy.subarray(0, 64))
  const afterTruncated = await ensurePlayableFlac(brokenPath, cacheDir)
  check('a truncated cache entry is rejected and rebuilt',
    walkChain(readFileSync(afterTruncated.path)).syncOk)

  /* ---------------------------------------------------------------- *
   * 4. Cache key invalidation on source change
   * ---------------------------------------------------------------- */
  const beforeTouch = afterTruncated.path
  // A different picture size changes the file's size and mtime, so the key must
  // change; reusing the old entry would serve a copy built for other bytes.
  writeFileSync(brokenPath, buildFlac({ pictureMime: '', paddingBytes: 2048 }))
  const afterTouch = await ensurePlayableFlac(brokenPath, cacheDir)
  check('a changed source file does not reuse the previous cache entry',
    afterTouch.path !== beforeTouch, `${afterTouch.path} vs ${beforeTouch}`)
  check('the newly built entry is valid',
    walkChain(readFileSync(afterTouch.path)).typesValid &&
    walkChain(readFileSync(afterTouch.path)).syncOk)

  /* ---------------------------------------------------------------- *
   * 5. What the PROTOCOL layer actually serves
   *
   * The first bug: the repaired copy was whitelisted but never served, because
   * serveMedia reads the path from the request URL. Asserting on the module's
   * return value could not catch that; asserting on the response body can.
   * ---------------------------------------------------------------- */
  const url = mediaUrl(brokenPath)
  const currentOriginal = readFileSync(brokenPath)
  const currentRepaired = readFileSync(afterTouch.path)

  const withoutSubstitute = await serveMedia(
    new Request(url, { method: 'GET' }),
    { roots: [workDir], files: [afterTouch.path] })
  const withoutBody = Buffer.from(await withoutSubstitute.arrayBuffer())
  check('without `substitute` the ORIGINAL bytes are served (bug-1 regression)',
    withoutBody.equals(currentOriginal),
    `${withoutBody.length} vs ${currentOriginal.length}`)

  const withSubstitute = await serveMedia(
    new Request(url, { method: 'GET' }),
    { roots: [workDir], files: [afterTouch.path], substitute: afterTouch.path })
  const withBody = Buffer.from(await withSubstitute.arrayBuffer())
  check('with `substitute` the REPAIRED bytes are served',
    withBody.equals(currentRepaired),
    `${withBody.length} vs ${currentRepaired.length}`)
  check('the served bytes are a coherent FLAC',
    walkChain(withBody).typesValid && walkChain(withBody).syncOk)

  const ranged = await serveMedia(
    new Request(url, { method: 'GET', headers: { Range: 'bytes=8-107' } }),
    { roots: [workDir], files: [afterTouch.path], substitute: afterTouch.path })
  const rangedBody = Buffer.from(await ranged.arrayBuffer())
  check('ranges are served from the substitute',
    ranged.status === 206 && rangedBody.length === 100,
    `status=${ranged.status} bytes=${rangedBody.length}`)
  check('the ranged slice matches the substitute at that offset',
    rangedBody.equals(currentRepaired.subarray(8, 108)))

  /* ---------------------------------------------------------------- *
   * 6. A substitute must not escape the allow-list
   * ---------------------------------------------------------------- */
  const outsidePath = join(workDir, '..', `outside-${process.pid}.flac`)
  writeFileSync(outsidePath, buildFlac({ pictureMime: 'image/jpeg' }))
  try {
    const escape = await serveMedia(
      new Request(url, { method: 'GET' }),
      { roots: [workDir], files: [], substitute: outsidePath })
    check('a substitute outside the allow-list is refused', escape.status === 403,
      `status=${escape.status}`)
  } finally {
    rmSync(outsidePath, { force: true })
  }
} finally {
  rmSync(workDir, { recursive: true, force: true })
}

console.log(`\nRESULT: ${passed} passed, ${failed} failed`)
if (failed > 0) process.exitCode = 1
