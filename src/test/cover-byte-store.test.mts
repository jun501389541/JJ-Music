import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, readFile, writeFile, mkdir, symlink } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { CoverByteStore } from './online/cover-byte-store.js'
const image = n => ({ data: Uint8Array.from([137,80,78,71,13,10,26,10,n]), mimeType: 'image/png' })
test('byte store LRU quota, digest checking and owned-file-only cleanup', async () => {
  const root = await mkdtemp(join(tmpdir(), 'jj-byte-store-')), dir = join(root, 'owned')
  const c = new CoverByteStore({ dir, maxBytes: 18 }); await c.load()
  const manual = join(dir, 'manual.png'); await writeFile(manual, 'keep')
  const one = await c.put(image(1)), two = await c.put(image(2))
  assert.deepEqual((await c.read(one)).data, image(1).data)
  await c.put(image(3)); assert.equal(await c.read(two), null)
  await writeFile(join(dir, `${one.hash}.bin`), 'corrupt')
  assert.equal(await c.read(one), null)
  await c.clear(); assert.equal(await readFile(manual, 'utf8'), 'keep')
})
test('byte store rejects traversal references, HTML/mismatched MIME and oversized images', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'jj-byte-validate-')), c = new CoverByteStore({ dir, maxBytes: 100 }); await c.load()
  assert.equal(await c.read({ hash: '../private', mimeType: 'image/png', size: 9 }), null)
  await assert.rejects(c.put({ data: new TextEncoder().encode('<html/>'), mimeType: 'image/png' }))
  await assert.rejects(c.put({ ...image(1), mimeType: 'image/jpeg' }))
  await assert.rejects(c.put({ data: new Uint8Array(8*1024*1024+1), mimeType: 'image/png' }))
})
test('rejecting a linked cache directory permanently degrades that store to memory', async () => {
  const root = await mkdtemp(join(tmpdir(), 'jj-byte-linked-')), outside = join(root, 'outside'), link = join(root, 'linked')
  await mkdir(outside); await symlink(outside, link, process.platform === 'win32' ? 'junction' : 'dir')
  const c = new CoverByteStore({ dir: link }); await assert.rejects(c.load())
  const ref = await c.put(image(1))
  assert.deepEqual((await c.read(ref)).data, image(1).data)
  await assert.rejects(readFile(join(outside, `${ref.hash}.bin`)), e => e.code === 'ENOENT')
  const sentinel = join(outside, `${ref.hash}.bin`); await writeFile(sentinel, 'user-owned')
  await c.clear(); assert.equal(await readFile(sentinel, 'utf8'), 'user-owned')
})
