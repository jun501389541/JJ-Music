import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFileSync } from 'node:fs'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import fsPromises from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'
import NodeID3 from 'node-id3'
import { exportAssets, mergeAssets } from './library/asset-export.js'
import { parseFile } from 'music-metadata'

const { MusicLibrary, hashPath } = await import('./library/music-library.js')
const root = mkdtempSync(join(tmpdir(), 'jj-scan-test-'))
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }

for (const restart of [false, true]) test(`a sidecar write during an old-schema scan retains pending refresh (${restart ? 'restart' : 'same process'})`, async () => {
  const own = mkdtempSync(join(tmpdir(), 'jj-scan-schema-')), entered = deferred(), release = deferred()
  let scanning
  try {
    const folder = join(own, 'music'), profile = join(own, 'profile'), file = join(folder, 'song.mp3'), cover = join(folder, 'song.png')
    mkdirSync(folder); mkdirSync(join(profile, 'library'), { recursive: true })
    const frame = Buffer.alloc(417); frame.writeUInt32BE(0xfffb9064)
    writeFileSync(file, Buffer.concat(Array.from({ length: 12 }, () => frame)))
    writeFileSync(cover, Buffer.from('89504e470d0a1a0a', 'hex'))
    const info = await fsPromises.stat(file), id = hashPath(file), indexPath = join(profile, 'library/index.json')
    const oldTrack = { id, path: file, name: 'song', singer: '', size: info.size, mtimeMs: info.mtimeMs }
    writeFileSync(indexPath, JSON.stringify({ version: 4, folders: [folder], tracks: [oldTrack] }))
    const lib = new MusicLibrary(profile); await lib.load()
    const readTrack = lib.readTrack.bind(lib); let held = false
    lib.readTrack = async (...args) => {
      const fresh = await readTrack(...args)
      if (!held && args[1] !== undefined) { held = true; entered.resolve(); await release.promise }
      return fresh
    }
    scanning = lib.scan(); await entered.promise
    const result = await exportAssets({ audioPath: file, patch: { lyrics: '[00:00.00]confirmed' }, to: ['sidecar'] })
    assert.equal(result.written, true)
    // This is the production sidecar-only commit: no metadata reread occurs.
    await lib.updateTrack({ ...oldTrack, assets: mergeAssets(oldTrack.assets, result.assets) })
    release.resolve(); await scanning
    assert.equal(lib.isStale(), true, 'discarded schema reads cannot complete the upgrade')
    const reloaded = new MusicLibrary(profile); await reloaded.load()
    assert.equal(reloaded.isStale(), true, 'pending schema work must survive persistence and restart')
    const retry = restart ? reloaded : lib
    await retry.scan()
    assert.equal(retry.get(id).coverPath, cover, 'unchanged audio must still gain its sidecar cover metadata')
    assert.equal(retry.get(id).assets.cover[0].origin, 'sidecar')
    assert.equal(retry.get(id).assets.lyrics.main[0].origin, 'sidecar')
    assert.equal(readFileSync(join(folder, 'song.lrc'), 'utf8'), '[00:00.00]confirmed')
    assert.equal(retry.isStale(), false)
    const completed = new MusicLibrary(profile); await completed.load()
    assert.equal(completed.isStale(), false, 'only the completed scan publishes the current schema version')
  } finally { release.resolve(); await scanning; rmSync(own, { recursive: true, force: true }) }
})

for (const target of ['embedded', 'sidecar']) test(`a late scan cannot replace an actual ${target} write's refreshed index`, async () => {
  const own = mkdtempSync(join(tmpdir(), 'jj-scan-write-')), entered = deferred(), release = deferred()
  let scanning
  try {
    const folder = join(own, 'music'), profile = join(own, 'profile'), file = join(folder, 'song.mp3')
    mkdirSync(folder)
    // Parser fixture: MPEG frame headers and ID3, with no user recording.
    const frame = Buffer.alloc(417); frame.writeUInt32BE(0xfffb9064)
    writeFileSync(file, Buffer.concat(Array.from({ length: 12 }, () => frame)))
    assert.equal(NodeID3.update({ title: 'original title', artist: 'fixture' }, file), true)
    const peer = join(folder, 'other.mp3')
    writeFileSync(peer, readFileSync(file))
    const lib = new MusicLibrary(profile)
    const readTrack = lib.readTrack.bind(lib)
    let held = false
    lib.readTrack = async (...args) => {
      const track = await readTrack(...args)
      if (args[0] === file && args[1] !== undefined && !held) { held = true; entered.resolve(); await release.promise }
      return track
    }
    scanning = lib.addFolder(folder); await entered.promise
    const current = await readTrack(file)
    const patch = target === 'embedded' ? { title: 'confirmed title' } : { lyrics: '[00:00.00]confirmed lyric' }
    const result = await exportAssets({ audioPath: file, patch, to: [target] })
    assert.equal(result.written, true)
    const next = result.embeddedWritten ? await readTrack(file) : { ...current, assets: mergeAssets(current.assets, result.assets) }
    await lib.updateTrack(next)
    const expected = structuredClone(lib.get(next.id))
    release.resolve(); await scanning
    assert.deepEqual(lib.get(next.id), expected, 'late scan must preserve the confirmed in-memory result')
    assert.equal(lib.get(hashPath(peer)).name, 'original title', 'other paths still commit their scan results')
    const saved = JSON.parse(readFileSync(join(profile, 'library/index.json'), 'utf8'))
    const persisted = JSON.parse(JSON.stringify(expected))
    assert.deepEqual(saved.tracks.find(t => t.id === next.id), persisted, 'late scan must preserve the persisted result')
    assert.equal(saved.tracks.length, 2)
    if (target === 'embedded') assert.equal((await parseFile(file)).common.title, 'confirmed title')
    else assert.equal(readFileSync(join(folder, 'song.lrc'), 'utf8'), patch.lyrics)
    const restarted = new MusicLibrary(profile); await restarted.load()
    assert.deepEqual(restarted.get(next.id), persisted)
    const again = await lib.scan()
    assert.equal(again.unchanged, 2, 'invalidation must not suppress future incremental scans')
  } finally { release.resolve(); await scanning; rmSync(own, { recursive: true, force: true }) }
})

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
