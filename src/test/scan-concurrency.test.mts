import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'

const { MusicLibrary } = await import('./library/music-library.js')
const root = mkdtempSync(join(tmpdir(), 'jj-scan-test-'))
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
