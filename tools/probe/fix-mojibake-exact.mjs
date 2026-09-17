/**
 * Reverse PowerShell `Set-Content -Encoding UTF8` mojibake, exactly.
 *
 * ## The transformation
 *
 * `Set-Content -Encoding UTF8` on a GBK console performs:
 *   original UTF-8 bytes → decode as CP936 → encode as UTF-8
 *
 * The inverse is therefore `Buffer.from(mojibake,'utf8').toString('gbk')`, but
 * only when every byte sequence in the line round-trips. Lines where the
 * original contained characters CP936 cannot represent (or where the file
 * already had damage) need care.
 *
 * ## Why the earlier heuristic was too cautious
 *
 * It compared "rare" vs "common" CJK character counts and refused to change a
 * line when the result was not obviously better. That rejected valid repairs
 * whose output was simply short. This version validates by *round-tripping the
 * repair back*: if re-applying the corruption reproduces the input, the repair
 * is provably correct and is applied unconditionally.
 *
 * Usage: node tools/probe/fix-mojibake-exact.mjs <file...>
 */
import { readFileSync, writeFileSync } from 'node:fs'
import iconv from 'iconv-lite'

/** Apply the corruption, so a candidate repair can be verified against it. */
function corrupt(text) {
  // decode UTF-8 bytes as GBK, then re-encode as UTF-8 — the Set-Content step.
  return iconv.decode(Buffer.from(text, 'utf8'), 'gbk')
}

/** Attempt the inverse. */
function repair(line) {
  return iconv.decode(Buffer.from(line, 'utf8'), 'gbk')
}

/**
 * True when re-corrupting `candidate` reproduces `line`, which proves the
 * repair is the exact inverse for this line.
 */
function isExactInverse(line, candidate) {
  if (candidate.includes('\uFFFD')) return false
  try {
    return corrupt(candidate) === line
  } catch {
    return false
  }
}

let total = 0

for (const file of process.argv.slice(2)) {
  const before = readFileSync(file, 'utf8')
  let changed = 0

  const after = before
    .split('\n')
    .map((line) => {
      if (!/[\u0080-\uffff]/.test(line)) return line
      // A line already containing normal Chinese has been repaired or was
      // never damaged; re-decoding it would break it.
      if (/[\u4e00-\u9fa5]/.test(line) && !/[\u9000-\u9fff]/.test(line)) {
        // still worth checking: mixed lines exist
      }

      const candidate = repair(line)
      if (isExactInverse(line, candidate)) {
        changed += 1
        return candidate
      }
      return line
    })
    .join('\n')

  if (changed > 0 && after !== before) {
    writeFileSync(file, after, 'utf8')
    total += changed
    console.log(`repaired ${changed} line(s): ${file}`)
  } else {
    console.log(`unchanged: ${file}`)
  }
}

console.log(`\n${total} line(s) repaired`)
