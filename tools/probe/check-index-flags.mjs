/**
 * Check whether the persisted library index carries the embedded-lyric flags.
 *
 * The flags are only written during a scan. A library indexed by an older build
 * has no flags, so the UI shows no lyric badges until a rescan — worth knowing
 * before concluding the UI is broken.
 *
 * Usage: node tools/probe/check-index-flags.mjs
 */
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const indexPath = join(process.env.APPDATA ?? '', 'jj-music', 'library', 'index.json')

if (!existsSync(indexPath)) {
  console.log(`no index at ${indexPath}`)
  process.exit(0)
}

const index = JSON.parse(readFileSync(indexPath, 'utf8'))
const tracks = Array.isArray(index.tracks) ? index.tracks : []

console.log(`index: ${indexPath}`)
console.log(`version: ${index.version}`)
console.log(`tracks:  ${tracks.length}\n`)

const withField = tracks.filter((t) => t.hasEmbeddedLyric !== undefined)
const embedded = tracks.filter((t) => t.hasEmbeddedLyric === true)
const synced = tracks.filter((t) => t.hasSyncedLyric === true)

console.log(`hasEmbeddedLyric present : ${withField.length}`)
console.log(`hasEmbeddedLyric true    : ${embedded.length}`)
console.log(`hasSyncedLyric true      : ${synced.length}`)

const sample = tracks[0]
if (sample) {
  console.log('\nfirst track:')
  console.log(
    JSON.stringify(
      {
        name: sample.name,
        singer: sample.singer,
        hasEmbeddedLyric: sample.hasEmbeddedLyric,
        hasSyncedLyric: sample.hasSyncedLyric,
        coverPath: sample.coverPath ? '(present)' : undefined
      },
      null,
      2
    )
  )
}

if (withField.length === 0) {
  console.log(
    '\n=> The index predates the lyric flags. Run 重新扫描 in the app (or the', 
    'library test) to populate them.'
  )
}
