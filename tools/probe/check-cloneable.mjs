/**
 * Reproduce the "An object could not be cloned" IPC failure.
 *
 * Electron serialises IPC payloads with the structured clone algorithm. Values
 * that are not cloneable throw at send time, and the renderer sees a generic
 * "An object could not be cloned" with no indication of which field is at
 * fault — the error message names nothing.
 *
 * This narrows down which part of a `ResolvedLyric` breaks the clone.
 *
 * Usage: node tools/probe/check-cloneable.mjs
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { MessageChannel } from 'node:worker_threads'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const load = (rel) => import(pathToFileURL(join(repoRoot, 'out', 'test', rel)).href)

const { resolveLocalLyric, searchLyricOnline } = await load('library/lyric-service.js')
const { matchMetadata } = await load('library/metadata-match.js')
const { MusicLibrary } = await load('library/music-library.js')

/**
 * Structured clone by the same rules Electron uses.
 * `MessageChannel` is the simplest way to get a real structured-clone check in
 * Node without pulling in a dependency.
 */
function isCloneable(value) {
  return new Promise((resolveCheck) => {
    const { port1, port2 } = new MessageChannel()
    port1.on('message', () => {
      port1.close()
      port2.close()
      resolveCheck({ ok: true })
    })
    port1.on('messageerror', (error) => {
      port1.close()
      port2.close()
      resolveCheck({ ok: false, reason: error.message })
    })
    try {
      port2.postMessage(value)
    } catch (error) {
      resolveCheck({ ok: false, reason: `${error.name}: ${error.message}` })
    }
  })
}

const dataDir = mkdtempSync(join(tmpdir(), 'jj-clone-'))
const library = new MusicLibrary(dataDir)
await library.load()
await library.addFolder('D:\\Music\\华语歌曲')
const tracks = library.getAll()
const target = tracks.find((t) => t.name && t.singer)

console.log('='.repeat(72))
console.log('IPC structured-clone check')
console.log('='.repeat(72))

if (!target) {
  console.log('no local track available')
  process.exit(0)
}

// 1. The plain local track.
const trackClone = await isCloneable(target)
console.log(`\nlocal track        : ${trackClone.ok ? 'cloneable' : `NOT cloneable — ${trackClone.reason}`}`)

// 2. The resolved lyric without a matched track (the embedded path).
const embedded = await resolveLocalLyric(target, { allowOnline: false })
const embeddedClone = await isCloneable(embedded)
console.log(`resolved (embedded): ${embeddedClone.ok ? 'cloneable' : `NOT cloneable — ${embeddedClone.reason}`}`)

// 3. A resolved lyric carrying an online match.
const candidates = await matchMetadata(target, { limit: 1 })
const music = candidates[0]?.music
if (music) {
  const musicClone = await isCloneable(music)
  console.log(`online music object: ${musicClone.ok ? 'cloneable' : `NOT cloneable — ${musicClone.reason}`}`)

  const onlineResult = await searchLyricOnline(target)
  const onlineClone = await isCloneable(onlineResult)
  console.log(`resolved (online)  : ${onlineClone.ok ? 'cloneable' : `NOT cloneable — ${onlineClone.reason}`}`)

  // Isolate which field of the music object breaks it.
  for (const [key, value] of Object.entries(music)) {
    const fieldClone = await isCloneable({ [key]: value })
    if (!fieldClone.ok) {
      console.log(`  ↳ field "${key}" is NOT cloneable: ${fieldClone.reason}`)
      if (value && typeof value === 'object') {
        for (const [subKey, subValue] of Object.entries(value)) {
          const subClone = await isCloneable({ [subKey]: subValue })
          if (!subClone.ok) {
            console.log(`     ↳ meta.${subKey} is NOT cloneable (${typeof subValue}): ${subClone.reason}`)
          }
        }
      }
    }
  }
}

// 4. A lyric result as the engine returns it.
const { fetchOnlineLyric } = await load('online/lyrics.js')
if (music) {
  const lyric = await fetchOnlineLyric(music)
  const lyricClone = await isCloneable(lyric)
  console.log(`LyricResult        : ${lyricClone.ok ? 'cloneable' : `NOT cloneable — ${lyricClone.reason}`}`)
}

rmSync(dataDir, { recursive: true, force: true })
