/** Verify UTF-8 integrity of source files after shell edits. */
import { readFileSync } from 'node:fs'
import { globSync } from 'node:fs'

const files = process.argv.slice(2)
if (files.length === 0) {
  console.error('usage: node tools/probe/check-encoding.mjs <file...>')
  process.exit(1)
}

/** Characters that indicate a UTF-8 -> GBK -> UTF-8 round-trip corruption. */
const MOJIBAKE = /[\uFFFD\u951F\u95C8\u95B2\u93C1\u6D93\u7C2E\u6FC2\u608A]/

for (const file of files) {
  const text = readFileSync(file, 'utf8')
  const lines = text.split('\n')
  const cjk = lines
    .map((line, index) => ({ line: line.trim(), number: index + 1 }))
    .filter((entry) => /[\u4e00-\u9fff]/.test(entry.line))
  const suspicious = cjk.filter((entry) => MOJIBAKE.test(entry.line))

  console.log(`\n=== ${file} ===`)
  console.log(`lines with CJK: ${cjk.length}`)
  console.log(`suspicious lines: ${suspicious.length}`)
  for (const entry of cjk.slice(0, 12)) {
    const flag = MOJIBAKE.test(entry.line) ? ' <-- MOJIBAKE' : ''
    console.log(`  ${entry.number}: ${entry.line.slice(0, 90)}${flag}`)
  }
}
