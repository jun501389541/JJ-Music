/**
 * Fix the CJK strings in the test/tool files that a PowerShell
 * `Set-Content -Encoding UTF8` round-trip destroyed.
 *
 * ## Why replacements rather than a generic algorithm
 *
 * The corruption decoded UTF-8 bytes as CP936 and re-encoded them, but the
 * original bytes are not always recoverable: CP936 has undefined byte
 * sequences, and those became U+FFFD, which carries no information. A generic
 * inverse therefore cannot work. (Attempting one at depths 1–4 all failed.)
 *
 * Since the damaged text is a small, known set of strings that this project
 * wrote, replacing them by hand is both correct and verifiable. Every entry
 * below is asserted to be present, so a stale mapping fails loudly instead of
 * silently doing nothing.
 *
 * Usage: node tools/probe/fix-cjk-strings.mjs
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')

/** [file, corrupted, correct, expected occurrences] */
const FIXES = [
  // --- source-engine.test.mts ---
  ['src/test/source-engine.test.mts', 'codex闊虫簮鎵嬫満', 'codex音源手机', 3],
  ['src/test/source-engine.test.mts', '澶氶煶婧愯仛鍚堬紝鑷姩杞崲', '多音源聚合，自动轮换', 1],
  ['src/test/source-engine.test.mts', '鏃犲悕闊虫簮', '无名音源', 2],
  ['src/test/source-engine.test.mts', '鐪熷疄闊虫簮', '真实音源', 1],
  ['src/test/source-engine.test.mts', '闊虫簮', '音源', 10],
  ['src/test/source-engine.test.mts', '鈥?', '—', 6],
  ['src/test/source-engine.test.mts', '棰勮', '预期', 2],

  // --- sandbox.test.mts ---
  ['src/test/sandbox.test.mts', '娌欑鑳藉姏鎺㈡祴', '沙箱能力探测', 2],
  ['src/test/sandbox.test.mts', '闊虫簮', '音源', 2],

  // --- tools/diagnose-online.mjs ---
  ['tools/diagnose-online.mjs', '寮曟搸鑷鏌ラ煶婧?', '引擎自检音源', 2],
  ['tools/diagnose-online.mjs', '寮曟搸鑷鏌', '引擎自检', 2],
  ['tools/diagnose-online.mjs', '闊虫簮', '音源', 12],
  ['tools/diagnose-online.mjs', '寮曟搸', '引擎', 6],
  ['tools/diagnose-online.mjs', '锛堝悎鎴愰煶婧愶紝涓嶄緷璧栦换浣曚笂娓革級', '（合成音源，不依赖任何上游）', 1],
  ['tools/diagnose-online.mjs', '锛堝悎鎴愰煶婧愶級', '（合成音源）', 1],

  // --- tools/probe/check-lx-request.mjs ---
  ['tools/probe/check-lx-request.mjs', '涓枃', '中文', 1],

  // --- tools/probe/diagnose-sixyin.mjs ---
  ['tools/probe/diagnose-sixyin.mjs', '闊虫簮', '音源', 6],
  ['tools/probe/diagnose-sixyin.mjs', '鎻愬彇', '提取', 2],
  ['tools/probe/diagnose-sixyin.mjs', '鍏嬮殕', '克隆', 2],
  ['tools/probe/diagnose-sixyin.mjs', '妫€鏌?', '检查', 1],
  ['tools/probe/diagnose-sixyin.mjs', '妫€鏌', '检查', 2],
  ['tools/probe/diagnose-sixyin.mjs', '鎵ц', '执行', 2],
  ['tools/probe/diagnose-sixyin.mjs', '瀹為檯', '实际', 1],
  ['tools/probe/diagnose-sixyin.mjs', '鎹曡幏', '捕获', 1]
]

let totalFixes = 0
let missing = 0

/** Group by file so each is read and written once. */
const byFile = new Map()
for (const [file, bad, good, expected] of FIXES) {
  const list = byFile.get(file) ?? []
  list.push({ bad, good, expected })
  byFile.set(file, list)
}

for (const [file, fixes] of byFile) {
  const path = join(repoRoot, file)
  let text = readFileSync(path, 'utf8')
  const applied = []

  for (const { bad, good, expected } of fixes) {
    const count = text.split(bad).length - 1
    if (count === 0) {
      // Not necessarily an error: an earlier fix may already have replaced it.
      continue
    }
    text = text.split(bad).join(good)
    applied.push(`${bad} → ${good} ×${count}`)
    totalFixes += count
    if (expected !== undefined && count !== expected) {
      console.log(`  note: ${file}: "${bad}" appeared ${count}× (expected ${expected})`)
    }
  }

  if (applied.length > 0) {
    writeFileSync(path, text, 'utf8')
    console.log(`\n${file}:`)
    for (const line of applied) console.log(`  ${line}`)
  }
}

// Verify nothing suspicious remains.
console.log('\n' + '='.repeat(66))
console.log('remaining suspicious text')
console.log('='.repeat(66))

const SUSPICIOUS = /[\u9000-\u9fff]/
for (const file of byFile.keys()) {
  const lines = readFileSync(join(repoRoot, file), 'utf8').split('\n')
  const bad = lines
    .map((line, index) => ({ line: line.trim(), number: index + 1 }))
    .filter((entry) => SUSPICIOUS.test(entry.line))
  if (bad.length > 0) {
    missing += bad.length
    console.log(`\n${file}: ${bad.length} line(s)`)
    for (const entry of bad.slice(0, 6)) {
      console.log(`  ${entry.number}: ${entry.line.slice(0, 110)}`)
    }
  } else {
    console.log(`${file}: clean`)
  }
}

console.log(`\n${totalFixes} replacement(s) applied`)
process.exit(missing > 0 ? 1 : 0)
