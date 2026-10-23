import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFileSync } from 'node:fs'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import fsPromises from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'

const { MusicLibrary, hashPath } = await import('./library/music-library.js')
const root = mkdtempSync(join(tmpdir(), 'jj-scan-test-'))
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }

test('partial unreadability preserves current-schema incremental scans and still refreshes old schemas', async () => {
  const own = mkdtempSync(join(tmpdir(), 'jj-scan-partial-'))
  const realReaddir = fsPromises.readdir
  try {
    const folder = join(own, 'music'), blocked = join(folder, 'blocked'), profile = join(own, 'profile')
    mkdirSync(blocked, { recursive: true }); mkdirSync(join(profile, 'library'), { recursive: true })
    writeFileSync(join(folder, 'song.wav'), 'fixture')
    const lib = new MusicLibrary(profile)
    let reads = 0
    lib.readTrack = async (path, size, mtimeMs) => { reads++; return { id: hashPath(path), path, size, mtimeMs, name: 'song', singer: '' } }
    fsPromises.readdir = async (path, ...args) => {
      if (path === blocked) throw Object.assign(new Error('controlled inaccessible directory'), { code: 'EACCES' })
      return realReaddir(path, ...args)
    }
    syncBuiltinESMExports()
    assert.equal((await lib.addFolder(folder)).failed, 1)
    assert.equal((await lib.scan()).unchanged, 1)
    assert.equal(reads, 1, 'unreadable sibling must not force unchanged metadata reads')
    assert.equal(lib.isStale(), false)
    const indexPath = join(profile, 'library/index.json'), index = JSON.parse(readFileSync(indexPath, 'utf8'))
    index.version = 0; writeFileSync(indexPath, JSON.stringify(index))
    const old = new MusicLibrary(profile); await old.load()
    old.readTrack = lib.readTrack
    await old.scan()
    assert.equal(old.isStale(), true, 'an incomplete schema refresh must remain pending')
    fsPromises.readdir = realReaddir; syncBuiltinESMExports()
    await old.scan()
    assert.equal(old.isStale(), false)
  } finally {
    fsPromises.readdir = realReaddir; syncBuiltinESMExports()
    rmSync(own, { recursive: true, force: true })
  }
})
test('GA04 scans preserve unavailable roots while pruning removed files in available roots', async () => {
  const own = mkdtempSync(join(tmpdir(), 'jj-scan-offline-'))
  try {
    const offline = join(own, 'unmounted'), available = join(own, 'available'), profile = join(own, 'profile')
    mkdirSync(available); mkdirSync(join(profile, 'library'), { recursive: true })
    const missing = join(offline, 'song.wav'), deleted = join(available, 'deleted.wav')
    writeFileSync(join(profile, 'library/index.json'), JSON.stringify({ version: 5, folders: [offline, available], tracks: [missing, deleted].map(path => ({ id: hashPath(path), path, name: 'song', singer: '' })) }))
    const lib = new MusicLibrary(profile); await lib.load()
    const progress = await lib.scan()
    assert.ok(lib.get(hashPath(missing)), 'offline entries survive')
    assert.equal(lib.get(hashPath(deleted)), undefined, 'confirmed deletion under reachable root is pruned')
    assert.ok(progress.failed > 0, 'unreachable root is reported')
    const saved = JSON.parse(readFileSync(join(profile, 'library/index.json'), 'utf8'))
    assert.deepEqual(saved.tracks.map(t => t.path), [missing])
    await lib.removeFolder(available)
    await lib.scan()
    assert.ok(lib.get(hashPath(missing)), 'all roots unavailable still preserves index')
  } finally { rmSync(own, { recursive: true, force: true }) }
})
test('GA05 folder removal invalidates a metadata read already in progress', async () => {
  const own = mkdtempSync(join(tmpdir(), 'jj-scan-remove-'))
  try {
    const folder = join(own, 'music'), profile = join(own, 'profile')
    mkdirSync(folder); const file = join(folder, 'song.wav'); writeFileSync(file, 'fixture')
    const lib = new MusicLibrary(profile), entered = deferred(), release = deferred()
    lib.readTrack = async path => { entered.resolve(); await release.promise; return { id: hashPath(path), path, name: 'song', singer: '' } }
    const pending = lib.addFolder(folder); await entered.promise
    await lib.removeFolder(folder); release.resolve(); await pending
    assert.equal(lib.getAll().length, 0)
    assert.deepEqual(lib.getFolders(), [])
    assert.deepEqual(JSON.parse(readFileSync(join(profile, 'library/index.json'), 'utf8')).tracks, [])
  } finally { rmSync(own, { recursive: true, force: true }) }
})
const wav = Buffer.alloc(44)
wav.write('RIFF', 0); wav.writeUInt32LE(36, 4); wav.write('WAVEfmt ', 8)
wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22)
wav.writeUInt32LE(8000, 24); wav.writeUInt32LE(16000, 28)
wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write('data', 36)

try {
  const folder = join(root, 'music')
  mkdirSync(folder)
  for (let i = 0; i < 8; i++) writeFileSync(join(folder, `${i}.wav`), wav)
  const library = new MusicLibrary(join(root, 'data'))
  const originalRead = library.readTrack.bind(library)
  let active = 0, peak = 0
  library.readTrack = async (...args) => {
    active++
    peak = Math.max(peak, active)
    await new Promise(resolve => setTimeout(resolve, 20))
    try { return await originalRead(...args) }
    finally { active-- }
  }
  const first = await library.addFolder(folder)
  assert.equal(first.added, 8)
  assert.ok(peak >= 2 && peak <= 4, `bounded metadata read concurrency: ${peak}`)
  assert.deepEqual(library.getAll().map(track => basename(track.path)), Array.from({ length: 8 }, (_, i) => `${i}.wav`))
  const second = await library.scan()
  assert.equal(second.unchanged, 8)
  console.log('scan concurrency passes')
} finally {
  if (dirname(resolve(root)) === resolve(tmpdir()) && basename(root).startsWith('jj-scan-test-')) {
    rmSync(root, { recursive: true, force: true })
  }
}
