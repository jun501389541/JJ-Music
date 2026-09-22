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
let privilegeError = null
try {
  const out = execFileSync('whoami', ['/priv'], { encoding: 'utf8' })
  privileges = out
    .split('\n')
    .filter((line) => line.includes('Se') && line.includes('Privilege'))
    .map((line) => line.trim().split(/\s{2,}/)[0])
    .filter(Boolean)
} catch (error) {
  // Kept out of the list: a row in the report that reads `error: …` is a row a
  // later comparison would count as a privilege the token holds.
  privilegeError = error.message.slice(0, 120)
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

const report = { integrity, privileges, pid: process.pid, at: new Date().toISOString() }
if (privilegeError) report.privilegeError = privilegeError
try {
  writeFileSync(outFile, JSON.stringify(report, null, 2))
} catch (error) {
  // Writing the report is itself a capability, and a restricted token can be
  // denied it — which is the result worth keeping, so it goes to stdout too
  // rather than dying in a stack trace that loses the measurement.
  console.error(`无法写入 ${outFile}: ${error.code ?? error.message}`)
  console.log(JSON.stringify(report, null, 2))
  process.exit(1)
}
console.log(`integrity: ${integrity}`)
if (privilegeError) console.log(`whoami /priv 失败: ${privilegeError}`)
console.log(`privileges (${privileges.length}):`)
for (const p of privileges) console.log('  ', p)
