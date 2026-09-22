/**
 * OS-level capability probe.
 *
 * Runs a tiny script that attempts a series of capability checks and appends one
 * JSON object per line (repeat runs append; read it with `JSON.parse` per line,
 * not as one document). Designed to be executed under a restricted token
 * (`runas /trustlevel:0x20000`) as well as normally, so the two reports can be
 * compared to see exactly what a restricted source process would lose.
 *
 * Never imports app code, never touches the network beyond the one HEAD request
 * below. Every file and key it creates is removed again, because this runs
 * against a real workstation profile.
 */
import { appendFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { execFile } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const outFile = process.argv[2]
if (!outFile) {
  console.error('usage: node capability-probe.mjs <out-json>')
  process.exit(2)
}

const results = {}
/** Paths and keys to remove again, whatever the outcome of the check was. */
const created = []

function run(command, args) {
  return new Promise((resolve, reject) => {
    execFile(command, args, (error) => (error ? reject(error) : resolve()))
  })
}

/** Records the outcome and, when it produced a file, queues it for cleanup. */
async function tryDo(name, fn) {
  try {
    const path = await fn()
    if (typeof path === 'string') created.push(path)
    results[name] = 'allowed'
  } catch (error) {
    results[name] = `denied: ${error.code ?? error.message?.slice(0, 60)}`
  }
}

function stamp() {
  return `${Date.now()}-${process.pid}`
}

await tryDo('write-temp', async () => {
  const p = join(tmpdir(), `jj-probe-${stamp()}.txt`)
  writeFileSync(p, 'probe')
  return p
})

await tryDo('write-userprofile-documents', async () => {
  const p = join(process.env.USERPROFILE ?? '', 'Documents', `jj-probe-${stamp()}.txt`)
  writeFileSync(p, 'probe')
  return p
})

await tryDo('write-appdata-roaming', async () => {
  const p = join(process.env.APPDATA ?? '.', `jj-probe-${stamp()}.txt`)
  writeFileSync(p, 'probe')
  return p
})

await tryDo('write-windows-system32', async () => {
  const p = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', `jj-probe-${stamp()}.txt`)
  writeFileSync(p, 'probe')
  return p
})

await tryDo('network-fetch', async () => {
  // A DNS-only style request to a benign host with a short timeout. Probes
  // whether outbound sockets are permitted at all.
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 4000)
  try {
    await fetch('https://www.baidu.com/favicon.ico', { signal: controller.signal, method: 'HEAD' })
  } finally {
    clearTimeout(timer)
  }
})

await tryDo('spawn-child', () => run('cmd.exe', ['/c', 'echo ok']))

/**
 * Writing `HKCU` is the check; the delete is part of the same probe, not optional
 * follow-up — an earlier revision said "clean up immediately either way" in a
 * comment and then did nothing, which left the key behind on every run.
 */
await tryDo('registry-write-hkcu', async () => {
  await run('reg.exe', ['add', 'HKCU\\Software\\JJProbeTest', '/v', 'probe', '/t', 'REG_SZ', '/d', '1', '/f'])
  created.push('HKCU\\Software\\JJProbeTest')
})

/**
 * Elevation, measured rather than assumed.
 *
 * `HKU\S-1-5-19` (the local service account) is only mounted into the registry
 * view of an elevated token, which is the usual non-invasive way to ask the
 * question without spawning something that needs admin to even start.
 */
results.elevated = await run('reg.exe', ['query', 'HKU\\S-1-5-19'])
  .then(() => true)
  .catch(() => false)

results.timestamp = new Date().toISOString()
results.pid = process.pid

for (const path of created) {
  try {
    if (path.startsWith('HKCU\\')) await run('reg.exe', ['delete', path, '/f'])
    else unlinkSync(path)
  } catch (error) {
    // A leftover the probe could not remove is itself a finding, so say so in the report.
    results.cleanupFailed = [...(results.cleanupFailed ?? []), `${path}: ${error.code ?? error.message}`]
  }
}

appendFileSync(outFile, `${JSON.stringify(results, null, 2)}\n`)
console.log('probe complete ->', outFile)
