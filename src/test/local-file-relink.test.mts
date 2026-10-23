import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, readFile, writeFile, mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { hashPath } from './library/music-library.js'
import { relinkTrack, relinkSettings, commitLocalRelink, recoverLocalRelink, RelinkCandidates } from './library/local-file-relink.js'

const old = { id: hashPath('E:/missing.mp3'), path: 'E:/missing.mp3', name: 'Old', singer: 'Singer' }
const next = { id: hashPath('E:/moved.mp3'), path: 'E:/moved.mp3', name: 'New', singer: 'Singer' }
const change = { old, next }
test('maintenance remains closed after a committed transaction cannot reload memory', async () => {
  const { RelinkCommitGuard } = await import('./library/local-file-relink.js')
  assert.equal(typeof RelinkCommitGuard, 'function')
  const guard = new RelinkCommitGuard()
  let committed = false
  await assert.rejects(guard.run(async () => change, async () => { committed = true }, async () => { throw Error('reload denied') }, () => false), /reload denied/)
  assert.equal(committed, true)
  assert.equal(guard.blocked, true, 'disk success without a journal must still block stale in-memory writers')
  await assert.rejects(guard.run(async () => change, async () => {}, async () => {}, () => false), /恢复/)
  const before = new RelinkCommitGuard()
  await assert.rejects(before.run(async () => { throw Error('source changed') }, async () => {}, async () => {}, () => false), /source changed/)
  assert.equal(before.blocked, false, 'pre-commit rejection without pending recovery is safe to release')
})
test('only the exact old local identity is migrated; queue order, history and resume progress remain', () => {
  const online = { id: old.id, source: 'wy', name: 'Online', meta: {} }
  assert.deepEqual(relinkTrack(old, change), next)
  assert.equal(relinkTrack(online, change), online)
  const other = { ...old, path: 'E:/another.mp3' }
  assert.equal(relinkTrack(other, change), other)
  const settings = { recentPlayed: [online, old], lastSession: { track: old, position: 42, index: 1, queue: [online, old], mode: 'random' }, queueHistory: [{ queue: [old, online], index: 1, mode: 'single' }], volume: 0.4 }
  const result = relinkSettings(settings, change)
  assert.equal(result.volume, 0.4)
  assert.equal(result.lastSession.position, 42)
  assert.equal(result.lastSession.index, 1)
  assert.deepEqual(result.lastSession.queue, [online, next])
  assert.deepEqual(result.queueHistory[0].queue, [next, online])
  assert.equal(result.queueHistory[0].mode, 'single')
  assert.deepEqual(settings.lastSession.track, old, 'inputs must not mutate')
})

for (const failAt of [0, 1, 2, 3, 4]) test(`transaction write failure stage ${failAt} recovers idempotently without replacing later unrelated changes`, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'jj-relink-journal-'))
  try {
    await mkdir(join(dir, 'library'))
    await writeFile(join(dir, 'library/index.json'), JSON.stringify({ version: 5, folders: [], tracks: [old], refreshPending: true }))
    await writeFile(join(dir, 'playlists.json'), JSON.stringify({ version: 1, playlists: [{ id: 'favorites' }], items: { favorites: [old] } }))
    await writeFile(join(dir, 'settings.json'), JSON.stringify({ recentPlayed: [old], volume: 0.4 }))
    const downloads = JSON.stringify([{ path: old.path, localTrackId: old.id }])
    await writeFile(join(dir, 'downloads.json'), downloads)
    let calls = 0
    const write = async (path, value) => {
      if (calls++ === failAt) throw Error('injected disk failure')
      await writeFile(path, JSON.stringify(value))
    }
    if (failAt < 4) await assert.rejects(commitLocalRelink(dir, change, { write }), /injected/)
    else await commitLocalRelink(dir, change, { write })
    const current = JSON.parse(await readFile(join(dir, 'settings.json'), 'utf8'))
    await writeFile(join(dir, 'settings.json'), JSON.stringify({ ...current, volume: 0.7 }))
    await recoverLocalRelink(dir)
    await recoverLocalRelink(dir)
    const index = JSON.parse(await readFile(join(dir, 'library/index.json'), 'utf8'))
    const lists = JSON.parse(await readFile(join(dir, 'playlists.json'), 'utf8'))
    const settings = JSON.parse(await readFile(join(dir, 'settings.json'), 'utf8'))
    const expected = failAt === 0 ? old : next
    assert.deepEqual(index.tracks, [expected])
    assert.equal(index.refreshPending, true)
    assert.deepEqual(lists.items.favorites, [expected])
    assert.deepEqual(settings.recentPlayed, [expected])
    assert.equal(settings.volume, 0.7)
    assert.equal(await readFile(join(dir, 'downloads.json'), 'utf8'), downloads)
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('corrupt stores and corrupt journal fail closed and preserve original bytes', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'jj-relink-corrupt-'))
  try {
    await writeFile(join(dir, 'settings.json'), '{broken')
    await assert.rejects(commitLocalRelink(dir, change), /损坏/)
    assert.equal(await readFile(join(dir, 'settings.json'), 'utf8'), '{broken')
    await writeFile(join(dir, 'settings.json'), JSON.stringify({ lastSession: { queue: 'broken' } }))
    await assert.rejects(commitLocalRelink(dir, change), /损坏/)
    await assert.rejects(readFile(join(dir, 'local-relink.pending.json')), { code: 'ENOENT' })
    await writeFile(join(dir, 'local-relink.pending.json'), '{broken')
    await assert.rejects(recoverLocalRelink(dir), /损坏/)
    assert.equal(await readFile(join(dir, 'local-relink.pending.json'), 'utf8'), '{broken')
  } finally { await rm(dir, { recursive: true, force: true }) }
})

function wav() {
  const b = Buffer.alloc(16044); b.write('RIFF'); b.writeUInt32LE(16036, 4); b.write('WAVEfmt ', 8)
  b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(8000, 24)
  b.writeUInt32LE(16000, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(16000, 40)
  return b
}
test('candidate validates actual audio, cancel/expiry, reappeared old path and changed chosen file', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'jj-relink-candidate-'))
  try {
    const missing = { ...old, path: join(dir, 'old.wav') }; missing.id = hashPath(missing.path)
    const chosen = join(dir, 'new.wav'); await writeFile(chosen, wav())
    let now = 0, conflict = false, known = true
    const candidates = new RelinkCandidates({ now: () => now, findOld: async () => known ? missing : undefined, findTarget: async () => conflict ? next : undefined, readTrack: async path => ({ ...next, id: hashPath(path), path }) })
    let preview = await candidates.preview(missing.id, missing.path, chosen)
    candidates.discard(preview.token)
    await assert.rejects(candidates.confirm(preview.token), /失效/)
    preview = await candidates.preview(missing.id, missing.path, chosen)
    now = 10 * 60_000
    await assert.rejects(candidates.confirm(preview.token), /失效/)
    now = 0
    preview = await candidates.preview(missing.id, missing.path, chosen)
    await writeFile(missing.path, wav())
    await assert.rejects(candidates.confirm(preview.token), /仍可访问/)
    await rm(missing.path)
    preview = await candidates.preview(missing.id, missing.path, chosen)
    await writeFile(chosen, Buffer.concat([wav(), Buffer.from('changed')]))
    await assert.rejects(candidates.confirm(preview.token), /变化/)
    conflict = true
    await assert.rejects(candidates.preview(missing.id, missing.path, chosen), /已在曲库/)
    conflict = false; known = false
    await assert.rejects(candidates.preview(missing.id, missing.path, chosen), /记录/)
    known = true; await writeFile(chosen, 'not audio')
    await assert.rejects(candidates.preview(missing.id, missing.path, chosen), /音频/)
  } finally { await rm(dir, { recursive: true, force: true }) }
})
