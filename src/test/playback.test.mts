/** Test the actual production URL and protocol modules with temporary files. */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, normalize, resolve, sep } from 'node:path'
import { serveMedia, mediaPath } from './media/media-response.js'
import { toMediaUrl } from './shared/media-url.js'
import { isPlayableFormat } from './library/music-library.js'

async function fixture(run) {
  const root = resolve(tmpdir())
  const dir = await mkdtemp(join(root, 'jj-media-'))
  try {
    const music = join(dir, 'music')
    const outside = join(dir, 'music-other')
    await mkdir(music)
    await mkdir(outside)
    const path = join(music, '中文 + # 100%.wav')
    const bytes = Buffer.alloc(1068)
    bytes.write('RIFF', 0); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write('WAVEfmt ', 8)
    bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22)
    bytes.writeUInt32LE(44100, 24); bytes.writeUInt32LE(88200, 28)
    bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34)
    bytes.write('data', 36); bytes.writeUInt32LE(bytes.length - 44, 40)
    await writeFile(path, bytes)
    const request = (file = path, headers = {}, method = 'GET') => serveMedia(
      new Request(toMediaUrl(file), { headers, method }), { roots: [music] }
    )
    await run({ dir, music, outside, path, bytes, request })
  } finally {
    assert.ok(resolve(dir).startsWith(root + sep))
    assert.ok(dir.slice(root.length + 1).startsWith('jj-media-'))
    await rm(dir, { recursive: true, force: true })
  }
}

test('production URL builder round-trips Chinese, spaces, percent, plus and hash', () => {
  for (const path of [join(tmpdir(), '中文', 'a + b# 100%.flac'), join(tmpdir(), 'album', 'a.mp3')]) {
    assert.equal(mediaPath(toMediaUrl(path)), normalize(path))
  }
  assert.throws(() => mediaPath('jjmedia://remote/C:/song.mp3'))
  assert.throws(() => mediaPath('jjmedia://local/relative.mp3'))
  assert.throws(() => mediaPath('jjmedia://local/%broken'))
})

test('full file response returns real audio bytes and CORS headers', () => fixture(async ({ request, bytes }) => {
  const response = await request()
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('content-type'), 'audio/wav')
  assert.equal(response.headers.get('accept-ranges'), 'bytes')
  assert.equal(response.headers.get('access-control-allow-origin'), '*')
  assert.equal(Number(response.headers.get('content-length')), bytes.length)
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes)
}))

test('closed, open, suffix and oversized ranges return the exact bytes', () => fixture(async ({ request, path, bytes }) => {
  for (const [range, start, end] of [
    ['bytes=0-31', 0, 31], ['bytes=100-', 100, bytes.length - 1],
    ['bytes=-20', bytes.length - 20, bytes.length - 1],
    ['bytes=-99999', 0, bytes.length - 1], ['bytes=100-99999', 100, bytes.length - 1]
  ]) {
    const response = await request(path, { Range: range })
    assert.equal(response.status, 206, range)
    assert.equal(response.headers.get('content-range'), `bytes ${start}-${end}/${bytes.length}`)
    assert.equal(Number(response.headers.get('content-length')), end - start + 1)
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes.subarray(start, end + 1))
  }
}))

test('invalid, inverted and unsupported multiple ranges fail cleanly', () => fixture(async ({ request, path, bytes }) => {
  for (const range of ['bytes=-', 'bytes=-0', 'bytes=5-2', 'bytes=9007199254740992-',
    'bytes=99999-', 'nonsense', 'bytes=0-1,3-4', 'prefix bytes=0-1']) {
    const response = await request(path, { Range: range })
    assert.equal(response.status, 416, range)
    assert.equal(response.headers.get('content-range'), `bytes */${bytes.length}`)
  }
}))

test('HEAD and empty files do not open a body stream', () => fixture(async ({ request, path, music, bytes }) => {
  const head = await request(path, { Range: 'bytes=0-1' }, 'HEAD')
  assert.equal(head.status, 200)
  assert.equal(Number(head.headers.get('content-length')), bytes.length)
  assert.equal(await head.text(), '')
  const empty = join(music, 'empty.wav')
  await writeFile(empty, '')
  const response = await request(empty)
  assert.equal(response.status, 200)
  assert.equal(await response.text(), '')
  assert.equal((await request(empty, { Range: 'bytes=0-' })).status, 416)
  assert.equal((await request(path, {}, 'POST')).status, 405)
}))

test('unselected files, sibling directories, non-media files and junction escapes are denied', () => fixture(async ({ request, music, outside, path }) => {
  const privateFile = join(outside, 'private.wav')
  await writeFile(privateFile, 'private')
  assert.equal((await request(privateFile)).status, 403)
  const config = join(music, 'settings.json')
  await writeFile(config, '{}')
  assert.equal((await request(config)).status, 403)
  assert.equal((await request(join(music, 'missing.wav'))).status, 404)
  const link = join(music, 'linked')
  await symlink(outside, link, process.platform === 'win32' ? 'junction' : 'dir')
  assert.equal((await request(join(link, 'private.wav'))).status, 403)
  const selected = await serveMedia(new Request(toMediaUrl(privateFile)), { roots: [], files: [privateFile] })
  assert.equal(selected.status, 200)
  assert.equal(await selected.text(), 'private')
  const invalidHost = toMediaUrl(path).replace('://local/', '://other/')
  assert.equal((await serveMedia(new Request(invalidHost), { roots: [music] })).status, 400)
}))

test('format capability assertions call the production implementation', () => {
  for (const ext of ['mp3', 'flac', 'm4a', 'aac', 'ogg', 'oga', 'opus', 'wav', 'mp4', 'webm']) {
    assert.equal(isPlayableFormat(`track.${ext}`), true, ext)
  }
  for (const ext of ['ape', 'dsf', 'dff', 'wma', 'aiff']) {
    assert.equal(isPlayableFormat(`track.${ext}`), false, ext)
  }
})
