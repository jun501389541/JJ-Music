/**
 * Privilege enumeration probe: shows which Windows privileges the current
 * token holds. Run normally vs under runas /trustlevel to see whether the
 * trust level actually changes anything (suspected: it does not, or not
 * meaningfully).
 *
 * Uses PowerShell's whoami /priv via child process — no native module needed.
 */
import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'

const outFile = process.argv[2]
if (!outFile) {
  console.error('usage: node privilege-probe.mjs <out-json>')
  process.exit(2)
}

let privileges = []
try {
  const out = execFileSync('whoami', ['/priv'], { encoding: 'utf8' })
  privileges = out
    .split('\n')
    .filter((line) => line.includes('Se') && line.includes('Privilege'))
    .map((line) => line.trim().split(/\s{2,}/)[0])
    .filter(Boolean)
} catch (error) {
  privileges = [`error: ${error.message.slice(0, 80)}`]
}

const integrity = (() => {
  try {
    const out = execFileSync('whoami', ['/groups'], { encoding: 'utf8' })
    const line = out.split('\n').find((l) => l.includes('Mandatory Level'))
    return line?.trim().split(/\s{2,}/).pop() ?? 'unknown'
  } catch {
    return 'unknown'
  }
})()

writeFileSync(
  outFile,
  JSON.stringify({ integrity, privileges, pid: process.pid, at: new Date().toISOString() }, null, 2)
)
console.log(`integrity: ${integrity}`)
console.log(`privileges (${privileges.length}):`)
for (const p of privileges) console.log('  ', p)
