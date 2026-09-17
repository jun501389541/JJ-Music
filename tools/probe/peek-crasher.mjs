/**
 * Look inside the obfuscated source that crashes the app.
 *
 * The script is 13 lines with one 58 KB line — a obfuscator packer. This prints
 * enough of its shape to identify the technique and, more importantly, to find
 * what it does at load time (before `inited`), because that is what kills the
 * process.
 *
 * Usage: node tools/probe/peek-crasher.mjs
 */
import { readFileSync, existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const target = join(repoRoot, 'crasher-1.js')

if (!existsSync(target)) {
  console.error(`missing ${target} — run tools/probe/extract-crasher.mjs first`)
  process.exit(1)
}

const script = readFileSync(target, 'utf8')
const lines = script.split('\n')

console.log('='.repeat(72))
console.log('obfuscated source inspection')
console.log('='.repeat(72))
console.log(`\ntotal: ${script.length} chars, ${lines.length} lines\n`)

console.log('--- line lengths ---')
lines.forEach((line, index) => {
  if (line.length > 60) {
    console.log(`  line ${index + 1}: ${line.length} chars`)
  }
})

console.log('\n--- obfuscation markers ---')
const MARKERS = [
  ['identifier mangling (_0x…)', /_0x[0-9a-f]+/g],
  ['hex escapes (\\xNN)', /\\x[0-9a-f]{2}/gi],
  ['unicode escapes (\\uNNNN)', /\\u[0-9a-f]{4}/gi],
  ['String.fromCharCode', /String\.fromCharCode/g],
  ['atob', /(?<![.\w$])atob\s*\(/g],
  ['Function constructor', /new\s+Function|Function\s*\(/g],
  ['eval', /(?<![.\w$])eval\s*\(/g],
  ['array rotation (push/shift)', /\.push\s*\([^)]*\)[^;]*\.shift\s*\(/g],
  ['while(true)', /while\s*\(\s*(?:true|1|!!\[\])\s*\)/g],
  ['try/catch', /try\s*\{/g]
]
for (const [label, re] of MARKERS) {
  const count = (script.match(re) ?? []).length
  if (count > 0) console.log(`  ${label.padEnd(30)} ${count}`)
}

console.log('\n--- load-time work (before inited) ---')
// Anything outside a function body runs at parse time and can abort the process.
const lxOnIndex = script.search(/\.?on\s*\(\s*(?:EVENT_NAMES\.request|['"]request['"])/)
const initedIndex = script.search(/send\s*\(\s*(?:EVENT_NAMES\.inited|['"]inited['"])/)
console.log(`  first request handler at char: ${lxOnIndex}`)
console.log(`  inited send at char:           ${initedIndex}`)

console.log('\n--- first 40 chars of each line ---')
lines.forEach((line, index) => {
  console.log(`  ${String(index + 1).padStart(2)} | ${line.slice(0, 40)}`)
})

console.log('\n--- tail (last 500 chars) ---')
console.log(script.slice(-500))

// The config blob is the interesting part: it names the remote endpoint the
// script talks to, and a signed API is the usual reason a source needs the
// obfuscation in the first place.
console.log('\n--- SERVER_SCRIPT_CONFIG ---')
const configMatch = /SERVER_SCRIPT_CONFIG['"]?\s*\]?\s*=\s*(\{[\s\S]{0,1200}?\})\s*;/.exec(script)
if (configMatch) {
  try {
    const config = JSON.parse(configMatch[1])
    for (const [key, value] of Object.entries(config)) {
      const shown = typeof value === 'string' && value.length > 90 ? `${value.slice(0, 90)}…` : value
      console.log(`  ${key}: ${JSON.stringify(shown)}`)
    }
  } catch {
    console.log(`  (raw) ${configMatch[1].slice(0, 400)}`)
  }
} else {
  console.log('  not found in the expected shape')
}
