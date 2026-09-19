/**
 * The path allow-list behind `resolveAllowedPath`, which `jjmedia://` has always
 * enforced and the lyric / tag / reveal IPC channels now share.
 *
 * ## Why this is tested separately from serveMedia
 *
 * The protocol was covered: `flac-repair.test.mts` drives `serveMedia` and
 * asserts on bytes. What was not covered is the boundary itself, and the
 * interesting properties are all about *containment*: a sibling folder whose
 * name starts with the root's name, a `..` that resolves out of the root, and a
 * picked file that is named explicitly rather than lying inside a root. Getting
 * any of those wrong does not produce a visible failure — it produces a channel
 * that can read anywhere.
 *
 * Run with:  node out/test/path-scope.test.mjs
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import assert from 'node:assert/strict'

const { resolveAllowedPath } = await import('./media/media-response.js')

const root = mkdtempSync(join(tmpdir(), 'jj-path-scope-'))
const library = join(root, 'Music')
const sibling = join(root, 'MusicSecret')
const picked = join(root, 'Elsewhere', 'song.mp3')

mkdirSync(join(library, 'album'), { recursive: true })
mkdirSync(sibling, { recursive: true })
mkdirSync(join(root, 'Elsewhere'), { recursive: true })
writeFileSync(join(library, 'a.mp3'), 'audio')
writeFileSync(join(library, 'album', 'b.flac'), 'audio')
writeFileSync(join(sibling, 'x.mp3'), 'not yours')
writeFileSync(picked, 'chosen by the user')

after(() => rmSync(root, { recursive: true, force: true }))

const access = (files = []) => ({ roots: [library], files })

test('a file inside a root resolves to its canonical path', async () => {
  const real = await realpath(join(library, 'a.mp3'))
  assert.equal(await resolveAllowedPath(join(library, 'a.mp3'), access()), real)
})

test('a nested file inside a root resolves', async () => {
  await resolveAllowedPath(join(library, 'album', 'b.flac'), access())
})

test('a sibling folder sharing the root name prefix is refused', async () => {
  // 'MusicSecret' starts with 'Music'. A startsWith() containment check lets
  // this through, which is the classic mistake this case exists to catch.
  await assert.rejects(resolveAllowedPath(sibling, access()))
  await assert.rejects(resolveAllowedPath(join(root, 'MusicSecret', 'x'), access()))
})

test('traversal out of the root is refused', async () => {
  await assert.rejects(resolveAllowedPath(join(library, '..', 'MusicSecret'), access()))
  await assert.rejects(resolveAllowedPath(join(library, 'a.mp3', '..', '..', 'MusicSecret'), access()))
})

test('a path outside every root is refused', async () => {
  await assert.rejects(resolveAllowedPath(join(root, 'windows.ini'), access()))
  await assert.rejects(resolveAllowedPath(join(tmpdir(), 'unrelated.txt'), access()))
})

test('an explicitly picked file is allowed without lying in a root', async () => {
  assert.equal(await resolveAllowedPath(picked, access([picked])), await realpath(picked))
  // ...and only that file, not the directory holding it.
  await assert.rejects(resolveAllowedPath(join(root, 'Elsewhere', 'other.mp3'), access([picked])))
})

test('a missing path is refused rather than reported as reachable', async () => {
  await assert.rejects(resolveAllowedPath(join(library, 'ghost.mp3'), access()))
})
