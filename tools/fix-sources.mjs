/**
 * Recover a player that will not start because of a bad 音源.
 *
 * ## Why this exists
 *
 * Sources are loaded at startup. A source that terminates its process — which a
 * self-defending obfuscated script can do — therefore makes the app permanently
 * unstartable: every launch dies before a window appears. There is no UI to
 * disable the offending source, because the UI is what failed to load.
 *
 * This tool works on `user_api.json` directly, which is the only way back in.
 *
 * Usage:
 *   node tools/fix-sources.mjs              # report what is installed
 *   node tools/fix-sources.mjs --disable-all
 *   node tools/fix-sources.mjs --disable <id|name>
 *   node tools/fix-sources.mjs --enable <id|name>
 *   node tools/fix-sources.mjs --remove <id|name>
 *   node tools/fix-sources.mjs --restore    # restore from the .bak
 */
import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { inflateSync } from 'node:zlib'

const sourcesPath = join(process.env.APPDATA ?? '', 'jj-music', 'sources', 'user_api.json')
const backupPath = `${sourcesPath}.bak`

if (!existsSync(sourcesPath)) {
  console.error(`没有找到音源文件: ${sourcesPath}`)
  process.exit(1)
}

/** Decode an LX `gz_` payload (base64 + zlib, despite the name). */
function decode(payload) {
  if (typeof payload !== 'string' || !payload.startsWith('gz_')) return null
  try {
    return inflateSync(Buffer.from(payload.slice(3), 'base64')).toString('utf8')
  } catch {
    return null
  }
}

/**
 * Heuristics for "this script is likely to misbehave".
 *
 * None of these are proof, and a clean report does not guarantee safety — but
 * they flag the shapes that have actually caused trouble, so a user can make an
 * informed choice about what to re-enable.
 */
function assess(script) {
  if (!script) return { risk: 'unknown', notes: ['无法解码脚本内容'] }

  const notes = []
  let risk = 'low'

  const lines = script.split('\n')
  const maxLine = Math.max(...lines.map((l) => l.length))

  if (maxLine > 20_000) {
    notes.push(`单行 ${maxLine} 字符（混淆打包）`)
    risk = 'high'
  }
  if (lines.length < 30 && script.length > 20_000) {
    notes.push('极少的行数承载大量代码')
    risk = 'high'
  }

  const unicodeEscapes = (script.match(/\\u[0-9a-f]{4}/gi) ?? []).length
  if (unicodeEscapes > 200) {
    notes.push(`${unicodeEscapes} 处 unicode 转义`)
    if (risk === 'low') risk = 'medium'
  }

  // Exotic identifiers are the signature of javascript-obfuscator's
  // self-defending mode, which is what aborts on an unexpected host.
  const exotic = (script.match(/[\uFE00-\uFE0F\u0600-\u06FF\u200B-\u200F]/g) ?? []).length
  if (exotic > 50) {
    notes.push(`${exotic} 个异体/零宽字符标识符（自我防护混淆）`)
    risk = 'high'
  }

  if (/while\s*\(\s*(?:true|1|!!\[\])\s*\)/.test(script)) {
    notes.push('含 while(true) 循环')
    if (risk === 'low') risk = 'medium'
  }
  if (/(?<![.\w$])eval\s*\(/.test(script)) {
    notes.push('使用 eval')
  }
  if (/debugger/.test(script)) {
    notes.push('含 debugger 语句')
  }
  if (/process\s*\.\s*(?:exit|abort|kill)/.test(script)) {
    notes.push('尝试调用 process.exit/abort/kill')
    risk = 'high'
  }

  if (notes.length === 0) notes.push('未发现明显风险特征')
  return { risk, notes }
}

const args = process.argv.slice(2)
const store = JSON.parse(readFileSync(sourcesPath, 'utf8'))
const apis = Array.isArray(store.userApis) ? store.userApis : []

/* ------------------------------------------------------------------ *
 * Actions
 * ------------------------------------------------------------------ */

function save() {
  // Keep a one-time backup so `--restore` is always available.
  if (!existsSync(backupPath)) {
    copyFileSync(sourcesPath, backupPath)
    console.log(`已创建备份: ${backupPath}`)
  }
  writeFileSync(sourcesPath, JSON.stringify(store, null, 2), 'utf8')
}

function findTarget(query) {
  const matches = apis.filter((a) => a.id === query || a.name === query)
  if (matches.length === 0) {
    console.error(`找不到音源: ${query}`)
    console.error('可用: ' + apis.map((a) => `${a.name} (${a.id})`).join(', '))
    process.exit(1)
  }
  return matches
}

if (args.includes('--restore')) {
  if (!existsSync(backupPath)) {
    console.error('没有备份可恢复')
    process.exit(1)
  }
  copyFileSync(backupPath, sourcesPath)
  console.log(`已从备份恢复: ${backupPath} → ${sourcesPath}`)
  process.exit(0)
}

if (args.includes('--disable-all')) {
  for (const api of apis) api.enabled = false
  save()
  console.log(`已停用全部 ${apis.length} 个音源`)
  console.log('现在可以启动应用，再逐个启用以找出问题音源。')
  process.exit(0)
}

const disableIndex = args.indexOf('--disable')
const enableIndex = args.indexOf('--enable')
const removeIndex = args.indexOf('--remove')

if (disableIndex >= 0 || enableIndex >= 0 || removeIndex >= 0) {
  const index = [disableIndex, enableIndex, removeIndex].find((i) => i >= 0)
  const query = args[index + 1]
  if (!query) {
    console.error('请提供音源 id 或名称')
    process.exit(1)
  }

  if (removeIndex >= 0) {
    const targets = findTarget(query)
    store.userApis = apis.filter((a) => !targets.includes(a))
    save()
    console.log(`已删除: ${targets.map((t) => t.name).join(', ')}`)
  } else {
    const targets = findTarget(query)
    for (const target of targets) target.enabled = enableIndex >= 0
    save()
    console.log(`已${enableIndex >= 0 ? '启用' : '停用'}: ${targets.map((t) => t.name).join(', ')}`)
  }
  process.exit(0)
}

/* ------------------------------------------------------------------ *
 * Default: report
 * ------------------------------------------------------------------ */

console.log('='.repeat(72))
console.log('已安装的音源')
console.log('='.repeat(72))
console.log(`\n文件: ${sourcesPath}`)
console.log(`数量: ${apis.length}`)
console.log(`备份: ${existsSync(backupPath) ? backupPath : '(无)'}`)

const RISK_LABEL = { high: '高风险', medium: '中风险', low: '低风险', unknown: '未知' }

for (const [index, api] of apis.entries()) {
  const enabled = api.enabled !== false
  const script = decode(api.script)
  const { risk, notes } = assess(script)

  console.log(`\n--- [${index}] ${api.name} ---`)
  console.log(`  id:      ${api.id}`)
  console.log(`  版本:    ${api.version || '?'}   作者: ${api.author || '?'}`)
  console.log(`  状态:    ${enabled ? '已启用' : '已停用'}`)
  console.log(`  脚本:    ${script ? `${script.length} 字符` : '无法解码'}`)
  console.log(`  风险:    ${RISK_LABEL[risk]}`)
  for (const note of notes) console.log(`           - ${note}`)
}

const highRisk = apis.filter((api, index) => assess(decode(api.script)).risk === 'high')

console.log(`\n${'='.repeat(72)}`)
if (highRisk.length > 0) {
  console.log(`注意: ${highRisk.length} 个音源带高风险特征。`)
  console.log('如果应用启动即闪退，先执行:')
  console.log('  node tools/fix-sources.mjs --disable-all')
  console.log('启动成功后再用 --enable <名称> 逐个排查。')
} else {
  console.log('未发现高风险音源。')
}
console.log('='.repeat(72))
