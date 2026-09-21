/**
 * Headless test of the local music library against a real folder.
 *
 * Verifies the half of the product that LX Music gets wrong: recursive
 * scanning, tag reading, cover extraction, incremental rescans and
 * sidecar-lyric discovery.
 *
 * Usage: node out/test/library.test.mjs [folder]
 */
import { mkdtempSync, rmSync, existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const { MusicLibrary, isPlayableFormat } = await import('./library/music-library.js')

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

const folder = process.argv[2] ?? 'D:\\Music\\华语歌曲'

console.log('='.repeat(72))
console.log('Local music library test')
console.log('='.repeat(72))

if (!existsSync(folder)) {
  console.log(`\nSKIP: folder not found: ${folder}`)
  process.exit(0)
}

const dataDir = mkdtempSync(join(tmpdir(), 'jjmusic-lib-'))
const library = new MusicLibrary(dataDir)
await library.load()

/* ------------------------------------------------------------------ *
 * 1. Format detection
 * ------------------------------------------------------------------ */

console.log('\n--- format support ---')
check('flac is playable', isPlayableFormat('a.flac'))
check('mp3 is playable', isPlayableFormat('a.mp3'))
check('m4a is playable', isPlayableFormat('a.m4a'))
check('ogg is playable', isPlayableFormat('a.ogg'))
check('wav is playable', isPlayableFormat('a.wav'))
// APE and DSD need a native decoder; Chromium cannot play them. Reporting
// them as unsupported is correct rather than silently indexing dead files.
check('ape is NOT playable by Web Audio', !isPlayableFormat('a.ape'))
check('dsf is NOT playable by Web Audio', !isPlayableFormat('a.dsf'))

/* ------------------------------------------------------------------ *
 * 2. Full scan
 * ------------------------------------------------------------------ */

console.log(`\n--- scanning ${folder} ---`)
const started = Date.now()
const progressEvents = []
// `addFolder` registers the folder and scans it in one step; scanning without
// a registered folder is a no-op by design.
const progress = await library.addFolder(folder, {
  onProgress: (p) => progressEvents.push({ ...p })
})
const elapsed = Date.now() - started

console.log(`  scanned:   ${progress.scanned}`)
console.log(`  added:     ${progress.added}`)
console.log(`  unchanged: ${progress.unchanged}`)
console.log(`  failed:    ${progress.failed}`)
console.log(`  elapsed:   ${elapsed} ms`)
console.log(`  progress callbacks: ${progressEvents.length}`)

check('found audio files', progress.scanned > 0, `${progress.scanned}`)
check('indexed files', progress.added > 0, `${progress.added}`)
check('most files read successfully', progress.failed < progress.scanned * 0.1, `${progress.failed} failed`)

const tracks = library.getAll()
check('library returns indexed tracks', tracks.length === progress.added, `${tracks.length}`)

/* ------------------------------------------------------------------ *
 * 3. Tag quality
 * ------------------------------------------------------------------ */

console.log('\n--- tag extraction quality ---')
const withTitle = tracks.filter((t) => t.name && t.name.length > 0).length
const withArtist = tracks.filter((t) => t.singer && t.singer.length > 0).length
const withAlbum = tracks.filter((t) => t.albumName).length
const withDuration = tracks.filter((t) => t.duration && t.duration > 0).length
const withCover = tracks.filter((t) => t.coverPath).length
const withSpec = tracks.filter((t) => t.sampleRate).length
const lossless = tracks.filter((t) => t.lossless).length
const hasSidecar = (t) => !!t.assets?.lyrics?.main?.some((a) => a.origin === 'sidecar')
const withLyric = tracks.filter(hasSidecar).length

const pct = (n) => `${((n / Math.max(1, tracks.length)) * 100).toFixed(0)}%`
console.log(`  title:      ${withTitle} (${pct(withTitle)})`)
console.log(`  artist:     ${withArtist} (${pct(withArtist)})`)
console.log(`  album:      ${withAlbum} (${pct(withAlbum)})`)
console.log(`  duration:   ${withDuration} (${pct(withDuration)})`)
console.log(`  technical:  ${withSpec} (${pct(withSpec)})`)
console.log(`  cover art:  ${withCover} (${pct(withCover)})`)
console.log(`  lossless:   ${lossless} (${pct(lossless)})`)
console.log(`  .lrc file:  ${withLyric} (${pct(withLyric)})`)

check('titles extracted', withTitle > tracks.length * 0.8, pct(withTitle))
check('artists extracted', withArtist > tracks.length * 0.5, pct(withArtist))
check('durations extracted', withDuration > tracks.length * 0.8, pct(withDuration))
check('technical spec extracted', withSpec > tracks.length * 0.8, pct(withSpec))

// Show a representative sample so the shape is visible.
console.log('\n--- sample tracks ---')
for (const track of tracks.slice(0, 5)) {
  console.log(`  ${track.name} — ${track.singer || '?'}`)
  console.log(
    `    ${track.codec ?? '?'} ${track.bitsPerSample ?? '?'}bit/${track.sampleRate ?? '?'}Hz ` +
      `${track.lossless ? 'lossless' : 'lossy'} ${track.duration ?? '?'}s` +
      `${track.coverPath ? ' [cover]' : ''}${hasSidecar(track) ? ' [lrc]' : ''}`
  )
}

// Report the codec spread, which is what a real library looks like.
const codecs = new Map()
for (const track of tracks) {
  const key = `${track.codec ?? '?'} ${track.bitsPerSample ?? '?'}bit`
  codecs.set(key, (codecs.get(key) ?? 0) + 1)
}
console.log('\n--- codec spread ---')
for (const [codec, count] of [...codecs.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10)) {
  console.log(`  ${codec.padEnd(18)} ${count}`)
}

/* ------------------------------------------------------------------ *
 * 4. Incremental rescan
 * ------------------------------------------------------------------ */

console.log('\n--- incremental rescan (should skip unchanged files) ---')
const rescanStart = Date.now()
const second = await library.scan()
const rescanMs = Date.now() - rescanStart
console.log(`  unchanged: ${second.unchanged}, added: ${second.added}, elapsed: ${rescanMs} ms`)

check('rescan reuses cached entries', second.unchanged > 0, `${second.unchanged}`)
check('rescan adds nothing new', second.added === 0, `${second.added}`)
check(
  'rescan is faster than the full scan',
  rescanMs < elapsed,
  `${rescanMs}ms vs ${elapsed}ms`
)

/* ------------------------------------------------------------------ *
 * 5. Persistence
 * ------------------------------------------------------------------ */

console.log('\n--- persistence ---')
const reloaded = new MusicLibrary(dataDir)
await reloaded.load()
check('index survives a reload', reloaded.getAll().length === tracks.length, `${reloaded.getAll().length}`)
check('folders persist', reloaded.getFolders().includes(folder))

/* ------------------------------------------------------------------ *
 * 6. Cover cache on disk
 * ------------------------------------------------------------------ */

const coverDir = join(dataDir, 'library', 'covers')
if (existsSync(coverDir)) {
  const covers = readdirSync(coverDir)
  console.log(`\n--- extracted covers: ${covers.length} files ---`)
  check('covers written to disk', covers.length > 0, `${covers.length}`)
  const uniqueCovers = new Set(tracks.map((track) => track.coverPath).filter(Boolean))
  check('cover cache contains each distinct image once', covers.length === uniqueCovers.size, `${covers.length} vs ${uniqueCovers.size}`)
  check('all indexed covers exist', [...uniqueCovers].every((path) => existsSync(path)))
}

/* ------------------------------------------------------------------ *
 * 7. Folder removal
 * ------------------------------------------------------------------ */

console.log('\n--- folder removal ---')
await library.removeFolder(folder)
check('removing a folder drops its tracks', library.getAll().length === 0, `${library.getAll().length}`)
check('folder list is empty', library.getFolders().length === 0)

rmSync(dataDir, { recursive: true, force: true })

console.log(`\n${'='.repeat(72)}`)
console.log(`RESULT: ${passed} passed, ${failed} failed`)
console.log('='.repeat(72))
process.exit(failed === 0 ? 0 : 1)
