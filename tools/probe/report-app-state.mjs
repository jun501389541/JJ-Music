/**
 * Report the app's persisted state so a lost library can be diagnosed.
 *
 * The library index was found empty after testing. That is recoverable (the
 * audio files are untouched; a rescan rebuilds the index), but it is worth
 * knowing exactly which files hold what, and whether the settings still point
 * at the music folder — because a missing `libraryFolders` entry is what makes
 * the UI show an empty library even when the index is fine.
 *
 * Usage: node tools/probe/report-app-state.mjs
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

const dataDir = join(process.env.APPDATA ?? '', 'jj-music')

console.log('='.repeat(72))
console.log('应用数据状态')
console.log('='.repeat(72))
console.log(`\n目录: ${dataDir}`)
console.log(`存在: ${existsSync(dataDir)}`)

function describe(file) {
  const path = join(dataDir, file)
  if (!existsSync(path)) return { file, present: false }
  const stats = statSync(path)
  let parsed
  let error
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'))
  } catch (e) {
    error = e.message
  }
  return { file, present: true, size: stats.size, mtime: stats.mtime, parsed, error }
}

/* ---------------- settings ---------------- */

const settings = describe('settings.json')
console.log(`\n--- settings.json ---`)
if (!settings.present) {
  console.log('  不存在')
} else {
  console.log(`  ${settings.size} 字节, 修改于 ${settings.mtime.toLocaleString()}`)
  if (settings.error) {
    console.log(`  ⚠ 解析失败: ${settings.error}`)
  } else {
    const folders = settings.parsed?.libraryFolders
    console.log(`  libraryFolders: ${JSON.stringify(folders)}`)
    if (!Array.isArray(folders) || folders.length === 0) {
      console.log('  ⚠ 没有配置任何音乐文件夹 —— 界面会显示空曲库')
    } else {
      for (const folder of folders) {
        const ok = existsSync(folder)
        let count = 0
        if (ok) {
          try {
            count = readdirSync(folder).length
          } catch {
            /* ignore */
          }
        }
        console.log(`    ${ok ? '✓' : '✗'} ${folder}${ok ? ` (顶层 ${count} 项)` : ' —— 不存在'}`)
      }
    }
  }
}

/* ---------------- library index ---------------- */

const index = describe(join('library', 'index.json'))
console.log(`\n--- library/index.json ---`)
if (!index.present) {
  console.log('  不存在（首次扫描时会创建）')
} else {
  console.log(`  ${index.size} 字节, 修改于 ${index.mtime.toLocaleString()}`)
  if (index.error) {
    console.log(`  ⚠ 解析失败: ${index.error}`)
  } else {
    const tracks = index.parsed?.tracks
    console.log(`  version: ${index.parsed?.version}`)
    console.log(`  folders: ${JSON.stringify(index.parsed?.folders)}`)
    console.log(`  tracks:  ${Array.isArray(tracks) ? tracks.length : '(非数组)'}`)
    if (Array.isArray(tracks) && tracks.length === 0) {
      console.log('  ⚠ 索引为空 —— 需要重新扫描（音频文件本身不受影响）')
    }
  }
}

/* ---------------- covers ---------------- */

const coversDir = join(dataDir, 'library', 'covers')
if (existsSync(coversDir)) {
  console.log(`\n--- library/covers ---`)
  console.log(`  已提取封面: ${readdirSync(coversDir).length} 个`)
}

/* ---------------- sources ---------------- */

const sourcesPath = join(dataDir, 'sources', 'user_api.json')
console.log(`\n--- sources/user_api.json ---`)
if (!existsSync(sourcesPath)) {
  console.log('  不存在')
} else {
  console.log(`  ${statSync(sourcesPath).size} 字节`)
  try {
    const parsed = JSON.parse(readFileSync(sourcesPath, 'utf8'))
    const apis = parsed.userApis ?? []
    console.log(`  音源数量: ${apis.length}`)
    for (const api of apis) {
      console.log(`    ${api.enabled === false ? '[停用]' : '[启用]'} ${api.name}`)
    }
  } catch (e) {
    console.log(`  ⚠ 解析失败: ${e.message}`)
  }
}

/* ---------------- recovery advice ---------------- */

console.log(`\n${'='.repeat(72)}`)
console.log('恢复建议')
console.log('='.repeat(72))

const needsFolder =
  !settings.parsed?.libraryFolders || settings.parsed.libraryFolders.length === 0
const needsIndex = !index.present || (index.parsed?.tracks?.length ?? 0) === 0

if (needsFolder || needsIndex) {
  console.log(`
音频文件本身没有被改动。恢复曲库只需重新添加文件夹并扫描：

  1. 打开应用 → 「本地曲库」→「添加文件夹」
  2. 选择你的音乐目录

或者直接写入设置（下次启动会自动扫描）：

  node tools/probe/restore-library.mjs "D:\\Music\\华语歌曲"
`)
} else {
  console.log('\n曲库配置看起来是完整的。')
}
