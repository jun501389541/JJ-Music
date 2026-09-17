/**
 * Fix the remaining CJK strings damaged by a PowerShell `Set-Content` round-trip.
 *
 * ## Detecting mojibake correctly
 *
 * A character-range test does not work: 音 is U+97F3, which sits inside the
 * range that also contains the mojibake characters (闊 is U+95CA), so a naive
 * range flags *correct* Chinese as damaged.
 *
 * The reliable signal is specific, known-bad sequences. Mojibake from a
 * UTF-8→CP936→UTF-8 round trip produces very distinctive bigrams that do not
 * occur in normal Chinese text (闊虫, 婧愶, 鑷姩, 鎺㈡, …), so matching those is both
 * precise and safe.
 *
 * Usage: node tools/probe/finish-cjk-fix.mjs
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')

/**
 * Bigrams that only appear in mojibake. Used purely for *detection*; the
 * repairs below are explicit.
 */
const MOJIBAKE_MARKERS = [
  '闊虫',
  '婧愶',
  '鑷姩',
  '鎺㈡',
  '鎵嬫',
  '澶氶',
  '鐪熷',
  '鏃犲',
  '寮曟',
  '鎻愬',
  '瀹為',
  '娌欑',
  '涓枃',
  '鈥?',
  '鈥',
  '锛?',
  '锛堝',
  '閿?',
  '銆?'
]

/** [file, corrupted, correct] — applied in order. */
const FIXES = [
  // source-engine.test.mts
  ['src/test/source-engine.test.mts', '澶氶煶婧愯仛鍚堬紝鑷姩杞崲', '多音源聚合，自动轮换'],

  // sandbox.test.mts
  ['src/test/sandbox.test.mts', '娌欑鑳藉姏鎺㈡祴', '沙箱能力探测'],

  // diagnose-online.mjs
  ['tools/diagnose-online.mjs', '寮曟搸鑷奸煶婧?', '引擎自检音源'],
  ['tools/diagnose-online.mjs', '寮曟搸鑷奸煶婧', '引擎自检音源'],
  ['tools/diagnose-online.mjs', '寮曟搸鑷', '引擎自检'],
  ['tools/diagnose-online.mjs', '鑷姩杞崲', '自动轮换'],
  ['tools/diagnose-online.mjs', '鎵ц', '执行'],
  ['tools/diagnose-online.mjs', '鎻愬彇', '提取'],
  ['tools/diagnose-online.mjs', '瀹為檯', '实际'],
  ['tools/diagnose-online.mjs', '鎹曡幏', '捕获'],
  ['tools/diagnose-online.mjs', '妫€鏌', '检查'],
  ['tools/diagnose-online.mjs', '缁撴灉', '结果'],
  ['tools/diagnose-online.mjs', '鎻愮ず', '提示'],
  ['tools/diagnose-online.mjs', '闇€瑕?', '需要'],
  ['tools/diagnose-online.mjs', '闇€瑕', '需要'],
  ['tools/diagnose-online.mjs', '涓婃父', '上游'],
  ['tools/diagnose-online.mjs', '涓嶄緷璧?', '不依赖'],
  ['tools/diagnose-online.mjs', '涓嶄緷璧', '不依赖'],
  ['tools/diagnose-online.mjs', '鍚堟垚', '合成'],
  ['tools/diagnose-online.mjs', '姝ｅ父', '正常'],
  ['tools/diagnose-online.mjs', '寮傚父', '异常'],
  ['tools/diagnose-online.mjs', '鍏ㄩ儴', '全部'],
  ['tools/diagnose-online.mjs', '閫氳繃', '通过'],
  ['tools/diagnose-online.mjs', '澶辫触', '失败'],
  ['tools/diagnose-online.mjs', '鎴愬姛', '成功'],
  ['tools/diagnose-online.mjs', '澹版槑', '声明'],
  ['tools/diagnose-online.mjs', '骞冲彴', '平台'],
  ['tools/diagnose-online.mjs', '鏈嶅姟', '服务'],
  ['tools/diagnose-online.mjs', '绱㈠紩', '索引'],
  ['tools/diagnose-online.mjs', '璇锋眰', '请求'],
  ['tools/diagnose-online.mjs', '杩斿洖', '返回'],
  ['tools/diagnose-online.mjs', '妫€娴?', '检测'],

  // diagnose-sixyin.mjs
  ['tools/probe/diagnose-sixyin.mjs', '鎻愬彇', '提取'],
  ['tools/probe/diagnose-sixyin.mjs', '瀹為檯', '实际'],
  ['tools/probe/diagnose-sixyin.mjs', '鎹曡幏', '捕获'],
  ['tools/probe/diagnose-sixyin.mjs', '妫€鏌', '检查'],
  ['tools/probe/diagnose-sixyin.mjs', '杩愯', '运行'],
  ['tools/probe/diagnose-sixyin.mjs', '涓绘満', '主机'],
  ['tools/probe/diagnose-sixyin.mjs', '鍙揪鎬?', '可达性'],
  ['tools/probe/diagnose-sixyin.mjs', '鍙揪鎬', '可达性'],
  ['tools/probe/diagnose-sixyin.mjs', '鍚勫悗绔?', '各后端'],
  ['tools/probe/diagnose-sixyin.mjs', '鍚勫悗绔', '各后端'],
  ['tools/probe/diagnose-sixyin.mjs', '鍘熷瓙', '原子'],
  ['tools/probe/diagnose-sixyin.mjs', '鑳藉姏', '能力'],
  ['tools/probe/diagnose-sixyin.mjs', '渚濊禆', '依赖'],
  ['tools/probe/diagnose-sixyin.mjs', '鍑芥暟', '函数'],
  ['tools/probe/diagnose-sixyin.mjs', '鏋勯€犲櫒', '构造器'],

  // check-lx-request.mjs
  ['tools/probe/check-lx-request.mjs', '涓枃', '中文'],
  ['tools/probe/check-lx-request.mjs', '鎺㈡祴', '探测'],
  ['tools/probe/check-lx-request.mjs', '鍦ㄦ矙绠变腑', '在沙箱中'],
  ['tools/probe/check-lx-request.mjs', '琛屼负', '行为'],

  // Shared em-dash damage
  ['src/test/source-engine.test.mts', '鈥?', '—'],
  ['src/test/sandbox.test.mts', '鈥?', '—'],
  ['tools/diagnose-online.mjs', '鈥?', '—'],
  ['tools/probe/check-lx-request.mjs', '鈥?', '—'],
  ['tools/probe/diagnose-sixyin.mjs', '鈥?', '—']
]

const files = [...new Set(FIXES.map(([file]) => file))]
let applied = 0

for (const file of files) {
  const path = join(repoRoot, file)
  let text = readFileSync(path, 'utf8')
  const report = []

  for (const [target, bad, good] of FIXES) {
    if (target !== file) continue
    const count = text.split(bad).length - 1
    if (count === 0) continue
    text = text.split(bad).join(good)
    applied += count
    report.push(`${bad} → ${good} ×${count}`)
  }

  if (report.length > 0) {
    writeFileSync(path, text, 'utf8')
    console.log(`\n${file}`)
    for (const line of report) console.log(`  ${line}`)
  }
}

/* ------------------------------------------------------------------ *
 * Verify with a mojibake-specific detector
 * ------------------------------------------------------------------ */

console.log('\n' + '='.repeat(66))
console.log('验证（只匹配真实的乱码特征）')
console.log('='.repeat(66))

let remaining = 0
for (const file of files) {
  const lines = readFileSync(join(repoRoot, file), 'utf8').split('\n')
  const bad = []
  lines.forEach((line, index) => {
    if (MOJIBAKE_MARKERS.some((marker) => line.includes(marker))) {
      bad.push({ number: index + 1, line: line.trim() })
    }
  })
  if (bad.length === 0) {
    console.log(`clean: ${file}`)
  } else {
    remaining += bad.length
    console.log(`\n${file}: ${bad.length} line(s) still damaged`)
    for (const entry of bad.slice(0, 8)) {
      console.log(`  ${entry.number}: ${entry.line.slice(0, 110)}`)
    }
  }
}

console.log(`\n${applied} replacement(s) applied`)
console.log(remaining === 0 ? '全部修复完成' : `${remaining} 行仍需处理`)
process.exit(remaining === 0 ? 0 : 1)
