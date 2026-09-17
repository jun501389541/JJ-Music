/**
 * Repair the UTF-8 damage caused by a PowerShell `Set-Content` round-trip.
 *
 * The console code page re-encoded CJK text, turning every Chinese character
 * into a mojibake pair. The original bytes are not recoverable from the file,
 * so the pairs are mapped back explicitly.
 *
 * This exists because editing source files with PowerShell text cmdlets is
 * unsafe on a GBK console; the fix is to use Node or the edit tool instead.
 * Kept as a tool so a future slip can be repaired the same way.
 *
 * Usage: node tools/probe/repair-utf8.mjs <file...>
 */
import { readFileSync, writeFileSync } from 'node:fs'

/**
 * The mojibake pairs seen in practice.
 *
 * Each entry is [corrupted, correct]. Deriving these from the original text is
 * more reliable than a generic algorithm, because the double re-encoding is
 * lossy in ways that vary by character.
 */
const REPAIRS = [
  // 音源
  ['闀胯櫈婧?', '音源'],
  ['闀胯櫈婧', '音源'],
  ['闊虫簮', '音源'],
  ['闅虫簮', '音源'],
  // 引擎
  ['寮曟搸', '引擎'],
  ['寮曟搸鑷', '引擎自'],
  ['寮曟搸鑷€?, '引擎自'],
  // 自检
  ['鑷鏌?', '自检'],
  ['鑷鏌', '自检'],
  ['鑷€?, '自'],
  // 合成
  ['鍚堟垚', '合成'],
  // 不依赖
  ['涓嶄緷璧栦换浣曚笂娓?', '不依赖任何上游'],
  ['涓嶄緷璧栦换浣曚笂娓', '不依赖任何上游'],
  // 中文
  ['涓枃', '中文'],
  // 沙箱
  ['娌欑', '沙'],
  ['娌欑铡?, '沙箱'],
  ['鑳藉姏', '能力'],
  ['鎺㈡祴', '探测'],
  // engine test
  ['闊虫簮鎵嬫満', '音源手机'],
  ['鏃犲悕', '无名'],
  ['鐪熷疄', '真实'],
  // generic
  ['闊虫簮寮曟搸', '音源引擎']
]

for (const file of process.argv.slice(2)) {
  const before = readFileSync(file, 'utf8')
  let after = before
  let touched = 0

  for (const [bad, good] of REPAIRS) {
    if (!after.includes(bad)) continue
    const count = after.split(bad).length - 1
    after = after.split(bad).join(good)
    touched += count
  }

  if (after !== before) {
    writeFileSync(file, after, 'utf8')
    console.log(`repaired ${touched} occurrence(s): ${file}`)
  } else {
    console.log(`unchanged: ${file}`)
  }
}
