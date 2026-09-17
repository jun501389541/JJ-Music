/**
 * Determine how many times the mangling was applied, then undo all of it.
 *
 * A single `Set-Content -Encoding UTF8` pass on a GBK console maps
 * `utf8 → gbk → utf8`. Two passes compound it, and the exact-inverse test then
 * fails because one application no longer reproduces the input.
 *
 * This tries depths 1..4 and reports which one round-trips, so the repair is
 * derived rather than guessed.
 *
 * Usage: node tools/probe/diagnose-mojibake-depth.mjs <file>
 */
import { readFileSync } from 'node:fs'
import iconv from 'iconv-lite'

const file = process.argv[2]
if (!file) {
  console.error('usage: node tools/probe/diagnose-mojibake-depth.mjs <file>')
  process.exit(1)
}

const lines = readFileSync(file, 'utf8').split('\n')

/** One corruption pass: decode UTF-8 bytes as GBK, then hand back the string. */
function corruptOnce(text) {
  return iconv.decode(Buffer.from(text, 'utf8'), 'gbk')
}

/** One repair pass: re-interpret the string's UTF-8 bytes as GBK. */
function repairOnce(text) {
  return iconv.decode(Buffer.from(text, 'utf8'), 'gbk')
}

console.log(`file: ${file}\n`)

// Pick a damaged line to analyse.
const sample = lines.find((l) => /[\u9000-\u9fff]/.test(l) && l.length > 8)
if (!sample) {
  console.log('no obviously damaged line found')
  process.exit(0)
}

console.log(`sample line:\n  ${sample.slice(0, 120)}\n`)

// Show what each repair depth produces, and whether corrupting it back the
// same number of times reproduces the input.
for (let depth = 1; depth <= 4; depth += 1) {
  let candidate = sample
  for (let i = 0; i < depth; i += 1) candidate = repairOnce(candidate)

  let back = candidate
  for (let i = 0; i < depth; i += 1) back = corruptOnce(back)

  const exact = back === sample
  const hasReplacement = candidate.includes('\uFFFD')
  const looksChinese = /[\u4e00-\u9fa5]/.test(candidate)

  console.log(`depth ${depth}: ${exact ? 'ROUND-TRIPS' : 'no'}${hasReplacement ? ' (has U+FFFD)' : ''}${looksChinese ? ' (contains CJK)' : ''}`)
  console.log(`  → ${candidate.slice(0, 120)}`)
  console.log('')
}
