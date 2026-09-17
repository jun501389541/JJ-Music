/**
 * Reverse the PowerShell `Set-Content -Encoding UTF8` mojibake.
 *
 * ## What went wrong
 *
 * The text was read as UTF-8, then written back through the console's code
 * page. The round trip is: original UTF-8 bytes → decoded as CP936 (GBK) →
 * re-encoded as UTF-8. Every multi-byte character therefore becomes two or
 * three wrong ones.
 *
 * ## Why this reverses it
 *
 * The transformation is deterministic and, crucially, **information-preserving
 * in the cases that matter**: the UTF-8 encoding of the mangled string, when
 * decoded as GBK, yields the original bytes. So the inverse is:
 *
 *   Buffer.from(mojibake, 'utf8').toString('gbk')  →  original
 *
 * Characters that were ASCII survive unchanged and pass through untouched,
 * which is why code structure is intact and only the text is wrong.
 *
 * Usage: node tools/probe/unmojibake.mjs <file...>
 */
import { readFileSync, writeFileSync } from 'node:fs'
import iconv from 'iconv-lite'

/**
 * Repair a string by re-interpreting its UTF-8 bytes as GBK.
 *
 * Applied per line, and only to lines that actually contain non-ASCII text, so
 * pure-ASCII lines (most code) are never touched.
 */
function repairText(text) {
  let changed = 0

  const repaired = text
    .split('\n')
    .map((line) => {
      // Fast path: nothing to fix.
      if (!/[\u0080-\uffff]/.test(line)) return line

      try {
        const bytes = Buffer.from(line, 'utf8')
        const candidate = iconv.decode(bytes, 'gbk')

        // Only accept the repair when it looks better than the input: the
        // corrupted form is full of rare CJK characters, while the original is
        // normal Chinese. A replacement character means the decode failed.
        if (candidate.includes('\uFFFD')) return line

        // Heuristic: prefer the version with more common characters. The
        // mojibake form is dominated by characters from the CJK Compatibility
        // and rare blocks; the original is mostly CJK Unified Ideographs.
        const rare = (s) => (s.match(/[\u3400-\u4dbf\u9fa6-\u9fff\ue000-\uf8ff]/g) ?? []).length
        const common = (s) => (s.match(/[\u4e00-\u9fa5\u3000-\u303f\uff00-\uffef]/g) ?? []).length

        if (rare(candidate) <= rare(line) && common(candidate) >= common(line)) {
          changed += 1
          return candidate
        }
        return line
      } catch {
        return line
      }
    })
    .join('\n')

  return { repaired, changed }
}

let totalChanged = 0

for (const file of process.argv.slice(2)) {
  const before = readFileSync(file, 'utf8')
  const { repaired, changed } = repairText(before)

  if (changed > 0 && repaired !== before) {
    writeFileSync(file, repaired, 'utf8')
    totalChanged += changed
    console.log(`repaired ${changed} line(s): ${file}`)
  } else {
    console.log(`unchanged: ${file}`)
  }
}

console.log(`\n${totalChanged} line(s) repaired`)
