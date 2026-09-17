/**
 * Inspect the persisted 音源 store after a crash-on-import report.
 *
 * A source that crashes the app on import and then prevents it from starting
 * points at the *startup* path, not the import path: whatever was written to
 * `user_api.json` is now read on every launch. This checks the file's integrity
 * and reports what the app will try to load.
 *
 * Usage: node tools/probe/inspect-sources.mjs
 */
import { existsSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

const sourcesPath = join(process.env.APPDATA ?? '', 'jj-music', 'sources', 'user_api.json')

console.log('='.repeat(72))
console.log('音源存储检查')
console.log('='.repeat(72))

if (!existsSync(sourcesPath)) {
  console.log(`\n没有音源文件: ${sourcesPath}`)
  process.exit(0)
}

const stats = statSync(sourcesPath)
console.log(`\n路径: ${sourcesPath}`)
console.log(`大小: ${stats.size} 字节 (${(stats.size / 1024).toFixed(1)} KB)`)
console.log(`修改: ${stats.mtime.toLocaleString()}`)

// First bytes matter: a BOM would break JSON.parse, and a truncated file is the
// classic result of a write that died partway through.
const buffer = readFileSync(sourcesPath)
console.log(
  `前 8 字节: ${[...buffer.subarray(0, 8)].map((b) => b.toString(16).padStart(2, '0')).join(' ')}`
)
console.log(`有 BOM: ${buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf}`)

const text = buffer.toString('utf8')

let parsed
try {
  parsed = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text)
  console.log('\nJSON 解析: 成功')
} catch (error) {
  console.log(`\nJSON 解析: 失败 — ${error.message}`)
  console.log('文件已损坏。应用启动时会把它重命名为 .corrupt 并继续。')
  // Show where it broke so the shape of the damage is visible.
  const position = /position (\d+)/.exec(error.message)
  if (position) {
    const at = Number(position[1])
    console.log(`\n出错位置附近:\n  ...${text.slice(Math.max(0, at - 120), at + 120)}...`)
  }
  process.exit(1)
}

const apis = Array.isArray(parsed?.userApis) ? parsed.userApis : null
if (!apis) {
  console.log('\n结构异常: 缺少 userApis 数组')
  console.log(`顶层键: ${Object.keys(parsed ?? {}).join(', ') || '(无)'}`)
  process.exit(1)
}

console.log(`\n音源数量: ${apis.length}`)

for (const [index, api] of apis.entries()) {
  console.log(`\n--- [${index}] ---`)
  for (const key of ['id', 'name', 'version', 'author', 'homepage', 'enabled']) {
    const value = api[key]
    if (value !== undefined) console.log(`  ${key}: ${String(value).slice(0, 80)}`)
  }

  const script = api.script
  if (typeof script !== 'string') {
    console.log(`  script: 类型异常 (${typeof script}) ← 会导致读取失败`)
    continue
  }

  console.log(`  script: ${script.length} 字符`)
  console.log(`  编码: ${script.startsWith('gz_') ? 'gz_ (LX 编码)' : '明文'}`)

  // Decode it the same way the app does, so a corrupt body surfaces here rather
  // than inside the worker at startup.
  try {
    const { decodeScript } = await import(
      new URL('../../out/test/sources/codec.js', import.meta.url).href
    )
    const decoded = decodeScript(script)
    console.log(`  解码后: ${decoded.length} 字符`)

    const header = decoded.slice(0, 400)
    const looksLikeScript = /^\s*\/\*/.test(header)
    console.log(`  头部注释在字节 0: ${looksLikeScript}`)

    // A few things that make a script fail at init rather than at import.
    const risky = []
    if (/\bwhile\s*\(\s*(?:true|1)\s*\)/.test(decoded)) risky.push('含 while(true) 死循环')
    if (decoded.length > 900_000) risky.push(`脚本过大 (${decoded.length} 字符)`)
    if (/process\.exit|require\(['"]child_process/.test(decoded)) risky.push('尝试访问进程/子进程')
    if (risky.length > 0) {
      console.log(`  风险: ${risky.join('; ')}`)
    }
  } catch (error) {
    console.log(`  解码失败: ${error.message} ← 这个音源无法加载`)
  }
}

console.log(`\n${'='.repeat(72)}`)
