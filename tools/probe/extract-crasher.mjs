/**
 * Extract and analyse the 音源 that kills the process.
 *
 * The script dies so hard that the worker's `exit` event never fires, which
 * means the failure is below the JS error-handling layer — an abort, a stack
 * overflow, or the V8 OOM killer. This dumps the script and looks for the
 * constructs that cause those.
 *
 * Usage: node tools/probe/extract-crasher.mjs
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { inflateSync } from 'node:zlib'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const sourcesPath = join(process.env.APPDATA ?? '', 'jj-music', 'sources', 'user_api.json')

const store = JSON.parse(readFileSync(sourcesPath, 'utf8'))
const apis = store.userApis ?? []

console.log('='.repeat(72))
console.log('崩溃音源分析')
console.log('='.repeat(72))

for (const [index, api] of apis.entries()) {
  const payload = api.script ?? ''
  if (!payload.startsWith('gz_')) {
    console.log(`\n[${index}] ${api.name}: 不是 gz_ 编码，跳过`)
    continue
  }

  const script = inflateSync(Buffer.from(payload.slice(3), 'base64')).toString('utf8')
  const outPath = join(repoRoot, `crasher-${index}.js`)
  writeFileSync(outPath, script, 'utf8')

  console.log(`\n[${index}] ${api.name} (v${api.version})`)
  console.log(`  导出: ${outPath}`)
  console.log(`  长度: ${script.length} 字符, ${script.split('\n').length} 行`)

  // --- structural red flags ---
  const flags = []

  const count = (re) => (script.match(re) ?? []).length

  const whileTrue = count(/while\s*\(\s*(?:true|1)\s*\)/g)
  if (whileTrue) flags.push(`while(true) × ${whileTrue}`)

  const forNoCond = count(/for\s*\(\s*;[^;]*;\s*\)/g)
  if (forNoCond) flags.push(`for(;;) × ${forNoCond}`)

  // Deep recursion is the usual cause of a stack overflow that bypasses try/catch.
  const selfCalls = count(/(\w+)\s*\([^)]*\)\s*\{[^}]*\1\s*\(/g)
  if (selfCalls > 4) flags.push(`疑似深层递归 × ${selfCalls}`)

  // Huge literals get materialised at parse time.
  const longLines = script.split('\n').filter((l) => l.length > 20_000).length
  if (longLines) flags.push(`超长单行 × ${longLines} (>20000 字符)`)

  const maxLine = Math.max(...script.split('\n').map((l) => l.length))
  if (maxLine > 10_000) flags.push(`最长行 ${maxLine} 字符`)

  const processUse = count(/(?<![.\w$])process\b/g)
  if (processUse) flags.push(`引用 process × ${processUse}`)

  const requireUse = count(/(?<![.\w$])require\s*\(/g)
  if (requireUse) flags.push(`require() × ${requireUse}`)

  const btoaUse = count(/(?<![.\w$])(?:btoa|atob)\s*\(/g)
  if (btoaUse) flags.push(`btoa/atob × ${btoaUse}`)

  const textDecoder = count(/new\s+TextDecoder/g)
  if (textDecoder) flags.push(`new TextDecoder × ${textDecoder}`)

  const bufferUse = count(/(?<![.\w$])Buffer\b/g)
  if (bufferUse) flags.push(`Buffer × ${bufferUse}`)

  const globals = count(/\bglobalThis\b/g)
  if (globals) flags.push(`globalThis × ${globals}`)

  console.log(`  风险标记: ${flags.length ? flags.join('; ') : '(无)'}`)

  // --- header ---
  const header = script.slice(0, 300).split('\n').slice(0, 14)
  console.log('  头部:')
  for (const line of header) console.log(`    ${line.slice(0, 110)}`)

  // --- top-level structure ---
  console.log('  lx API 用法:')
  for (const probe of [
    ['lx.on', /lx\.on\s*\(/g],
    ['EVENT_NAMES.request', /EVENT_NAMES\.request/g],
    ['EVENT_NAMES.inited', /EVENT_NAMES\.inited/g],
    ['lx.send', /(?:lx\.)?send\s*\(/g],
    ['lx.request', /(?:lx\.)?request\s*\(/g],
    ['lx.utils', /lx\.utils/g],
    ['fetch', /(?<![.\w$])fetch\s*\(/g],
    ['setTimeout', /setTimeout\s*\(/g],
    ['setInterval', /setInterval\s*\(/g]
  ]) {
    const n = count(probe[1])
    if (n) console.log(`    ${probe[0].padEnd(22)} ${n}`)
  }

  // --- find the biggest function bodies; one of them is the crasher ---
  const lines = script.split('\n')
  const bigBlocks = []
  let depth = 0
  let blockStart = 0
  for (let i = 0; i < lines.length; i += 1) {
    const opens = (lines[i].match(/\{/g) ?? []).length
    const closes = (lines[i].match(/\}/g) ?? []).length
    if (depth === 0 && opens > closes) blockStart = i
    depth += opens - closes
    if (depth === 0 && blockStart >= 0 && i - blockStart > 200) {
      bigBlocks.push({ start: blockStart + 1, end: i + 1, size: i - blockStart })
      blockStart = -1
    }
    if (depth === 0) blockStart = i + 1
  }
  if (bigBlocks.length) {
    console.log('  最大的顶层块:')
    for (const block of bigBlocks.slice(0, 5)) {
      console.log(`    行 ${block.start}-${block.end} (${block.size} 行)`)
    }
  }
}
