/**
 * OS-level capability probe.
 *
 * Runs a tiny script that attempts a series of capability checks and writes
 * the results as JSON. Designed to be executed under a restricted token
 * (`runas /trustlevel:0x20000`) as well as normally, so the two reports can be
 * compared to see exactly what a restricted source process would lose.
 *
 * Never imports app code, never touches the network. Pure capability
 * measurement.
 */
import { writeFileSync, appendFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const outFile = process.argv[2]
if (!outFile) {
  console.error('usage: node capability-probe.mjs <out-json>')
  process.exit(2)
}

const results = {}
const tryDo = async (name, fn) => {
  try {
    await fn()
    results[name] = 'allowed'
  } catch (error) {
    results[name] = `denied: ${error.code ?? error.message?.slice(0, 60)}`
  }
}

await tryDo('write-temp', async () => {
  const p = join(tmpdir(), `jj-probe-${Date.now()}.txt`)
  writeFileSync(p, 'probe')
})

await tryDo('write-userprofile-documents', async () => {
  const docs = join(process.env.USERPROFILE ?? '', 'Documents')
  writeFileSync(join(docs, `jj-probe-${Date.now()}.txt`), 'probe')
})

await tryDo('write-appdata-roaming', async () => {
  writeFileSync(join(process.env.APPDATA ?? '.', `jj-probe-${Date.now()}.txt`), 'probe')
})

await tryDo('write-windows-system32', async () => {
  writeFileSync(join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', `jj-probe-${Date.now()}.txt`), 'probe')
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

await tryDo('spawn-child', async () => {
  const { execFile } = await import('node:child_process')
  await new Promise((resolve, reject) => {
    execFile('cmd.exe', ['/c', 'echo ok'], (err) => (err ? reject(err) : resolve()))
  })
})

await tryDo('registry-write-hkcu', async () => {
  const { execFile } = await import('node:child_process')
  await new Promise((resolve, reject) => {
    execFile('reg.exe', ['add', 'HKCU\\Software\\JJProbeTest', '/v', 'probe', '/t', 'REG_SZ', '/d', '1', '/f'], (err) => {
      // Clean up immediately either way.
      try {
        const { execFile: ef } = require('node:child_process')
      } catch { /* ignore */ }
      err ? reject(err) : resolve()
    })
  })
})

results.timestamp = new Date().toISOString()
results.pid = process.pid
results.elevated = process.platform === 'win32' ? undefined : false
appendFileSync(outFile, JSON.stringify(results, null, 2))
console.log('probe complete ->', outFile)
