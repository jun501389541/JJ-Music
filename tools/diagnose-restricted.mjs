/**
 * One-shot restricted-mode diagnostics.
 *
 * Boots every enabled source the same way the app does (restricted token),
 * captures the exact failure point per source, and prints a decision-ready
 * table. Read-only with respect to user data: it never writes user_api.json.
 *
 * Usage: node tools/diagnose-restricted.mjs [name-filter]
 */
import { mkdtempSync, rmSync, readdirSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'

const __dirname = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(__dirname, '..')
const hostPath = join(repoRoot, 'out', 'test', 'source-host.cjs')
// Flag-aware arg parsing: `--all` is a switch, any other non-numeric arg is a
// name filter. (A previous version treated argv[2] as the filter, so passing
// `--all` also set filter='--all' and matched nothing.)
const args = process.argv.slice(2)
const wantAll = args.includes('--all')
const filter = args.find((a) => a !== '--all' && !/^\d+$/.test(a))

const userApi = join(process.env.APPDATA, 'jj-music', 'sources', 'user_api.json')
if (!existsSync(userApi)) {
  console.error('user_api.json not found — nothing to diagnose.')
  process.exit(1)
}
const { gunzipSync, inflateSync } = await import('node:zlib')
const data = JSON.parse(readFileSync(userApi, 'utf8'))

function decode(script) {
  if (script.startsWith('gz_') || script.startsWith('zlib_')) {
    const raw = Buffer.from(script.slice(script.indexOf('_') + 1), 'base64')
    return (raw[0] === 0x1f ? gunzipSync(raw) : inflateSync(raw)).toString('utf8')
  }
  return script
}

const INIT_TIMEOUT_MS = 25_000
const results = []

function diagnose(api) {
  return new Promise((resolve) => {
    const scratch = mkdtempSync(join(tmpdir(), 'jj-diag-'))
    const scriptPath = join(scratch, 'script.js')
    const initPath = join(scratch, 'init.json')
    writeFileSync(scriptPath, decode(api.script), 'utf8')
    writeFileSync(initPath, JSON.stringify({
      env: 'desktop', version: '2.0.0', apiId: api.id,
      scriptInfo: { name: api.name, description: '', version: '', author: '', homepage: '' }
    }), 'utf8')

    // Same launcher as the app: .cmd wrapper via runas.
    const nodeExec = process.execPath
    const cmdFile = join(scratch, 'launch.cmd')
    const body = [
      '@echo off',
      `"${nodeExec}" --max-old-space-size=512 "${hostPath}" "${scriptPath}" "${initPath}" "${scratch}"`
    ].join('\r\n')
    writeFileSync(cmdFile, body, 'utf8')

    const wrapper = spawn('runas', ['/trustlevel:0x20000', `"${cmdFile}"`], {
      stdio: 'ignore', windowsVerbatimArguments: true
    })

    let settled = false
    let lastHeartbeat = 0
    let heartbeatSeen = false
    // Console-log tail from the child, accumulated across polls so a failure
    // report carries what the script printed before it died.
    let logSeen = 0
    let pollTimer
    const finish = (outcome, detail = '') => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      clearInterval(pollTimer)
      try { wrapper.kill() } catch { /* ignore */ }
      // Collect the scratch state as evidence before cleanup.
      const files = existsSync(scratch) ? readdirSync(scratch) : []
      const consoleLog = existsSync(join(scratch, 'console.log'))
        ? readFileSync(join(scratch, 'console.log'), 'utf8').slice(-400)
        : ''
      try { rmSync(scratch, { recursive: true, force: true }) } catch { /* ignore */ }
      resolve({ name: api.name, outcome, detail, files, consoleLog })
    }
    const timer = setTimeout(() => {
      const waited = heartbeatSeen
        ? 'init-timeout (alive but never wrote ready.json)'
        : 'init-timeout (heartbeat never started — child likely never ran)'
      finish('TIMEOUT', waited)
    }, INIT_TIMEOUT_MS)

    // Watch the scratch directory for protocol files.
    pollTimer = setInterval(() => {
      let names = []
      try { names = existsSync(scratch) ? readdirSync(scratch) : [] } catch { return }
      if (names.includes('heartbeat.json')) {
        try {
          const hb = Number(readFileSync(join(scratch, 'heartbeat.json'), 'utf8'))
          if (hb > lastHeartbeat) { lastHeartbeat = hb; heartbeatSeen = true }
        } catch { /* racing write */ }
      }
      const cl = join(scratch, 'console.log')
      if (existsSync(cl)) {
        const text = readFileSync(cl, 'utf8')
        if (text.length > logSeen) logSeen = text.length
      }
      if (names.includes('ready.json')) {
        try {
          const ready = JSON.parse(readFileSync(join(scratch, 'ready.json'), 'utf8'))
          if (ready.ok === false) finish('BOOT_ERROR', ready.error ?? '')
          else finish('OK', `sources: ${Object.keys(ready.sources ?? {}).join(',')}`)
        } catch { /* partial */ }
      }
    }, 250)
  })
}

const limitArg = args.find((a) => /^\d+$/.test(a))
const list = data.userApis
  .filter((a) => wantAll || a.enabled !== false)
  .filter((a) => !filter || a.name.includes(filter))
  .slice(0, limitArg ? Number(limitArg) : 100)

console.log(`diagnosing ${list.length} enabled source(s) under restricted token…\n`)
for (const api of list) {
  const r = await diagnose(api)
  results.push(r)
  console.log(`[${r.outcome.padEnd(12)}] ${r.name}`)
  if (r.detail) console.log(`    ${r.detail}`)
  if (r.consoleLog.trim()) console.log(`    console: ${r.consoleLog.trim().split('\n').slice(-2).join(' | ').slice(0, 160)}`)
}

console.log('\n===== SUMMARY =====')
const byOutcome = {}
for (const r of results.filter((x) => x.name)) byOutcome[r.outcome] = (byOutcome[r.outcome] ?? 0) + 1
console.log(JSON.stringify(byOutcome, null, 2))
console.log('\nA source that shows "init-timeout (heartbeat never started)" means the')
console.log('child never even began executing under the restricted token — that is a')
console.log('launcher problem, not a source problem.')
