/**
 * Restore the music library folder list, and rebuild the index on next launch.
 *
 * ## Why this is needed
 *
 * The app stores the folder list in `settings.json` and the track index in
 * `library/index.json`. If the folder list is emptied — which happened here
 * during testing — the UI shows an empty library even though every audio file
 * is still on disk and all extracted cover art is intact.
 *
 * The audio files are never touched by this. Recovery is just: restore the
 * folder list, and let the app's own startup scan rebuild the index.
 *
 * Usage:
 *   node tools/probe/restore-library.mjs                       # report only
 *   node tools/probe/restore-library.mjs "D:\Music\华语歌曲"    # restore
 *   node tools/probe/restore-library.mjs --scan                # restore then rescan now
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const dataDir = join(process.env.APPDATA ?? '', 'jj-music')
const settingsPath = join(dataDir, 'settings.json')

const args = process.argv.slice(2)
const wantScan = args.includes('--scan')
const folder = args.find((a) => !a.startsWith('--'))

if (!existsSync(settingsPath)) {
  console.error(`找不到 ${settingsPath}`)
  process.exit(1)
}

const settings = JSON.parse(readFileSync(settingsPath, 'utf8'))

console.log('='.repeat(72))
console.log('恢复曲库文件夹')
console.log('='.repeat(72))
console.log(`\n当前 libraryFolders: ${JSON.stringify(settings.libraryFolders ?? [])}`)

if (!folder) {
  console.log('\n未指定文件夹，仅报告。')
  console.log('用法: node tools/probe/restore-library.mjs "D:\\Music\\华语歌曲"')
  process.exit(0)
}

if (!existsSync(folder)) {
  console.error(`\n文件夹不存在: ${folder}`)
  process.exit(1)
}

const existing = Array.isArray(settings.libraryFolders) ? settings.libraryFolders : []
if (!existing.includes(folder)) existing.push(folder)

settings.libraryFolders = existing
writeFileSync(settingsPath, JSON.stringify(settings, null, 2), 'utf8')

console.log(`\n已写入 libraryFolders: ${JSON.stringify(existing)}`)
console.log('下次启动应用时会自动扫描并重建索引。')

if (wantScan) {
  console.log('\n立即扫描…')
  const { MusicLibrary } = await import(
    new URL('../../out/test/library/music-library.js', import.meta.url).href
  )
  const library = new MusicLibrary(dataDir)
  await library.load()

  let lastReport = 0
  const progress = await library.addFolder(folder, {
    onProgress: (p) => {
      const now = Date.now()
      if (now - lastReport > 2000) {
        lastReport = now
        process.stdout.write(`\r  已扫描 ${p.scanned} 个文件…`)
      }
    }
  })

  process.stdout.write('\r' + ' '.repeat(40) + '\r')
  console.log(`  扫描完成: ${progress.scanned} 个文件, 索引 ${progress.added} 首, 失败 ${progress.failed}`)

  const tracks = library.getAll()
  const withLyrics = tracks.filter((t) => t.hasEmbeddedLyric).length
  console.log(`  曲库现在有 ${tracks.length} 首，其中 ${withLyrics} 首带内嵌歌词`)
}
