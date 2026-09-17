/**
 * Repair UTF-8 corruption left by a PowerShell `Set-Content` round-trip.
 *
 * The earlier edit read the file as UTF-8 but re-encoded it through the console
 * code page, turning em-dashes into a mojibake pair and destroying CJK text.
 * CJK has already been restored by hand; this fixes the punctuation.
 *
 * Usage: node tools/probe/fix-mojibake.mjs <file...>
 */
import { readFileSync, writeFileSync } from 'node:fs'

/** Matches the mojibake sequences seen in practice: `鈥?`, `鈥`, `锛?`. */
const REPAIRS = [
  [/\u9225\u003F/g, '\u2014'], // em dash followed by a lost byte
  [/\u9225\uFFFD/g, '\u2014'],
  [/\u9225/g, '\u2014'],
  [/\u951F\u003F/g, '\u2014'],
  [/[\uFFFD]/g, '']
]

let changed = 0
for (const file of process.argv.slice(2)) {
  const before = readFileSync(file, 'utf8')
  let after = before
  for (const [pattern, replacement] of REPAIRS) {
    after = after.replace(pattern, replacement)
  }
  if (after !== before) {
    writeFileSync(file, after, 'utf8')
    changed += 1
    console.log(`repaired: ${file}`)
  } else {
    console.log(`unchanged: ${file}`)
  }
}
console.log(`\n${changed} file(s) repaired`)
