/**
 * Complete the CJK repair in tools/diagnose-online.mjs.
 *
 * The corruption is a UTF-8→CP936→UTF-8 round trip from a PowerShell
 * `Set-Content -Encoding UTF8`. Because the file's intended text is known (this
 * project wrote it), the remaining damage is replaced explicitly rather than
 * inferred — a generic inverse is impossible where CP936 had undefined byte
 * sequences and produced U+FFFD.
 *
 * Usage: node tools/probe/finish-diagnose-fix.mjs
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const target = join(repoRoot, 'tools', 'diagnose-online.mjs')

/** [corrupted, correct] — longest first so substrings do not clobber matches. */
const FIXES = [
  ['引擎鏈敹鍒颁换浣曞钩鍙板０鏄?鈥斺€?杩欐槸引擎闂', '引擎未收到任何平台声明 —— 这是引擎问题'],
  ['寮曟搸鑷奸煶婧?', '引擎自检音源'],
  ['寮曟搸鑷', '引擎自检'],
  ['寮曟搸鏈韩娌℃湁闂', '引擎本身没有问题'],
  ['鍚姩锛屽０鏄庡钩鍙?', '启动，声明平台:'],
  ['鏈敹鍒颁换浣曞钩鍙板０鏄', '未收到任何平台声明'],
  ['杩欐槸引擎闂', '这是引擎问题'],
  ['涓嶄緷璧栦换浣曚笂娓?', '不依赖任何上游'],
  ['锛堝悎鎴愰煶婧愶紝涓嶄緷璧栦换浣曚笂娓革級', '（合成音源，不依赖任何上游）'],
  ['锛堝悎鎴愰煶婧愶級', '（合成音源）'],
  ['浣犵殑鐪熷疄', '你的真实'],
  ['鐪熷疄音源', '真实音源'],
  ['鐪熷疄', '真实'],
  ['鑺辨捣', '花海'],
  ['閸涖劍婢冩导?', '周杰伦'],
  ['閸涖劍婢冩导', '周杰伦'],
  ['鍛ㄦ澃浼?', '周杰伦'],
  ['鍛ㄦ澃浼', '周杰伦'],
  ['鍚姩', '启动'],
  ['鏈敹鍒?', '未收到'],
  ['鏃?', '无'],
  ['骞冲彴', '平台'],
  ['澹版槑', '声明'],
  ['杩欐槸', '这是'],
  ['闂', '问'],
  ['鍜屽０鏄?', '和声明'],
  ['鍜?', '和'],
  ['锛?', '：'],
  ['鈫?', '→'],
  ['鈥斺€?', '——'],
  ['鈥?', '—'],
  ['鉁?', '✗'],
  ['鉁?', '✓'],
  ['馃敘', '·'],
  ['寮曟搸', '引擎'],
  ['閿欒', '错误'],
  ['杩斿洖', '返回'],
  ['璇锋眰', '请求'],
  ['瓒呮椂', '超时'],
  ['澶辫触', '失败'],
  ['鎴愬姛', '成功'],
  ['妫€鏌', '检查'],
  ['缁撴灉', '结果'],
  ['杈撳嚭', '输出'],
  ['鏈嶅姟鍣?', '服务器'],
  ['鏈嶅姟鍣', '服务器'],
  ['涓浆', '中转'],
  ['鏇存崲', '更换'],
  ['闇€瑕?', '需要'],
  ['闇€瑕', '需要'],
  ['鍦板潃', '地址'],
  ['鏃犳硶', '无法'],
  ['鍙栧埌', '取到'],
  ['鑻?', '若'],
  ['姣忎釜', '每个'],
  ['鍊欓€?', '候选'],
  ['鍏ㄩ儴', '全部'],
  ['閫氳繃', '通过'],
  ['姝ｅ父', '正常'],
  ['寮傚父', '异常'],
  ['鍙敤', '可用'],
  ['鐜嬭€?', '状态'],
  ['绫诲瀷', '类型']
]

let text = readFileSync(target, 'utf8')
let applied = 0

// Apply longest patterns first so a short rule cannot eat a longer match.
const ordered = [...FIXES].sort((a, b) => b[0].length - a[0].length)

for (const [bad, good] of ordered) {
  const count = text.split(bad).length - 1
  if (count === 0) continue
  text = text.split(bad).join(good)
  applied += count
}

writeFileSync(target, text, 'utf8')
console.log(`applied ${applied} replacement(s) to tools/diagnose-online.mjs`)

/* ------------------------------------------------------------------ *
 * Verify
 * ------------------------------------------------------------------ */

// Mojibake-specific bigrams. A character-range test would flag correct Chinese
// (音 is U+97F3, adjacent to the damaged 闊 U+95CA), so match sequences instead.
const MARKERS = ['闊虫', '婧愶', '鑷姩', '鎺㈡', '寮曟', '閿欒', '鉁', '鈥', '锛?', '鍚姩', '鏈敹']

const lines = readFileSync(target, 'utf8').split('\n')
const remaining = lines
  .map((line, index) => ({ line: line.trim(), number: index + 1 }))
  .filter((entry) => MARKERS.some((marker) => entry.line.includes(marker)))

if (remaining.length === 0) {
  console.log('验证通过：没有残留乱码')
} else {
  console.log(`\n仍有 ${remaining.length} 行可疑:`)
  for (const entry of remaining.slice(0, 12)) {
    console.log(`  ${entry.number}: ${entry.line.slice(0, 110)}`)
  }
}
process.exit(remaining.length === 0 ? 0 : 1)
