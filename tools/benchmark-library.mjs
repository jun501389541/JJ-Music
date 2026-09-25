/** Cold and incremental scans of generated WAV files; never touches the user's library. */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { performance } from 'node:perf_hooks'
import { MusicLibrary } from '../out/test/library/music-library.js'

const count = Number(process.argv.find(arg => arg.startsWith('--tracks='))?.slice(9) ?? 2000)
if (!Number.isInteger(count) || count < 1 || count > 10000) throw new Error('--tracks must be 1..10000')
const root = mkdtempSync(join(tmpdir(), 'jj-library-benchmark-'))
const wav = Buffer.alloc(44)
wav.write('RIFF', 0); wav.writeUInt32LE(36, 4); wav.write('WAVEfmt ', 8)
wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22)
wav.writeUInt32LE(8000, 24); wav.writeUInt32LE(16000, 28)
wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write('data', 36)

try {
  const music = join(root, 'music')
  mkdirSync(music)
  for (let i = 0; i < count; i++) writeFileSync(join(music, `${String(i).padStart(5, '0')}.wav`), wav)
  const library = new MusicLibrary(join(root, 'data'))
  const coldStart = performance.now()
  const cold = await library.addFolder(music)
  const coldMs = performance.now() - coldStart
  const warmStart = performance.now()
  const warm = await library.scan()
  const warmMs = performance.now() - warmStart
  console.log(JSON.stringify({ tracks: count, coldMs: +coldMs.toFixed(2), incrementalMs: +warmMs.toFixed(2), cold, incremental: warm }, null, 2))
} finally {
  // The only recursive removal target is the exact prefix created under os.tmpdir().
  if (dirname(resolve(root)) === resolve(tmpdir()) && basename(root).startsWith('jj-library-benchmark-')) {
    rmSync(root, { recursive: true, force: true })
  }
}
