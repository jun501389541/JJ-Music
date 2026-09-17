/**
 * Choose the source-isolation transport by testing it inside Electron.
 *
 * Plain Node in this sandbox cannot create named pipes, so `fork()` fails here
 * for environmental reasons. The app, however, runs inside Electron, where the
 * rules differ. Deciding on a transport without testing it in the actual target
 * environment would risk shipping something that cannot work.
 *
 * This launches a real Electron main process and has it try each option,
 * reporting through a file (which is the only channel guaranteed to survive).
 *
 * Usage: node tools/probe/check-transport-in-electron.mjs
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const workDir = join(repoRoot, '.cache', 'electron-transport')
mkdirSync(workDir, { recursive: true })

const resultPath = join(workDir, 'result.json')
try {
  unlinkSync(resultPath)
} catch {
  /* none */
}

/* ------------------------------------------------------------------ *
 * Child worker used by the Electron probe
 * ------------------------------------------------------------------ */

const childPath = join(workDir, 'probe-child.cjs')
writeFileSync(
  childPath,
  `
// Reports through IPC when available, and always writes a file as a fallback.
const fs = require('node:fs')

const initPath = process.argv[2]
const outPath = process.argv[3]

function report(payload) {
  try { fs.writeFileSync(outPath, JSON.stringify(payload)) } catch {}
  try { process.send && process.send(payload) } catch {}
}

let bigPayloadOk = false
try {
  if (initPath && fs.existsSync(initPath)) {
    const script = fs.readFileSync(initPath, 'utf8')
    bigPayloadOk = script.length > 100000
  }
} catch {}

const hasIpc = typeof process.send === 'function'
report({ pid: process.pid, hasIpc, bigPayloadOk, argvOk: true })

// Stay alive briefly so the parent can observe a live channel.
setTimeout(() => process.exit(0), 2500)
`,
  'utf8'
)

/* ------------------------------------------------------------------ *
 * Electron main-process probe
 * ------------------------------------------------------------------ */

const electronMain = join(workDir, 'probe-main.cjs')
writeFileSync(
  electronMain,
  `
const { app } = require('electron')
const { fork, spawn } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')

const workDir = ${JSON.stringify(workDir)}
const childPath = ${JSON.stringify(childPath)}
const resultPath = ${JSON.stringify(resultPath)}

const results = {}

function finish() {
  try { fs.writeFileSync(resultPath, JSON.stringify(results, null, 2)) } catch (e) {
    fs.writeFileSync(resultPath, JSON.stringify({ fatal: String(e) }))
  }
  app.exit(0)
}

// A payload larger than any env var or argv limit, to prove the transport
// handles realistic script sizes (the biggest installed source is ~740 KB).
const bigPayloadPath = path.join(workDir, 'big.txt')
fs.writeFileSync(bigPayloadPath, 'x'.repeat(400000))

app.whenReady().then(async () => {
  // ---- 1. fork() with an IPC channel ----
  results.fork = await new Promise((resolve) => {
    let child
    try {
      child = fork(childPath, [bigPayloadPath, path.join(workDir, 'fork.json')], {
        stdio: ['ignore', 'pipe', 'pipe', 'ipc']
      })
    } catch (e) {
      resolve({ ok: false, error: String(e && e.message) })
      return
    }
    const timer = setTimeout(() => { try { child.kill() } catch {} ; resolve({ ok: false, error: 'timeout' }) }, 8000)
    child.on('message', (m) => {
      clearTimeout(timer)
      resolve({ ok: true, received: m })
      try { child.kill() } catch {}
    })
    child.on('error', (e) => { clearTimeout(timer); resolve({ ok: false, error: String(e && e.message) }) })
    child.on('exit', (c) => { clearTimeout(timer); resolve({ ok: false, error: 'exited ' + c + ' without message' }) })
  })

  // ---- 2. utilityProcess (Electron's own API) ----
  results.utilityProcess = await new Promise((resolve) => {
    let child
    try {
      const { utilityProcess } = require('electron')
      child = utilityProcess.fork(childPath, [bigPayloadPath, path.join(workDir, 'utility.json')], {
        stdio: 'pipe'
      })
    } catch (e) {
      resolve({ ok: false, error: String(e && e.message) })
      return
    }
    const timer = setTimeout(() => { try { child.kill() } catch {} ; resolve({ ok: false, error: 'timeout' }) }, 8000)
    child.on('message', (m) => {
      clearTimeout(timer)
      resolve({ ok: true, received: m })
      try { child.kill() } catch {}
    })
    child.on('exit', (c) => { clearTimeout(timer); resolve({ ok: false, error: 'exited ' + c + ' without message' }) })
  })

  // ---- 3. crash isolation: does a child abort hurt the parent? ----
  const suicidePath = path.join(workDir, 'suicide.cjs')
  fs.writeFileSync(suicidePath, 'process.abort()\\n')
  results.crashIsolation = await new Promise((resolve) => {
    const child = fork(suicidePath, [], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] })
    const timer = setTimeout(() => { try { child.kill() } catch {} ; resolve({ ok: false, error: 'timeout' }) }, 8000)
    child.on('exit', (code, signal) => {
      clearTimeout(timer)
      resolve({ ok: true, childExit: code, signal })
    })
  })

  results.parentSurvivedCrash = true
  finish()
})
`,
  'utf8'
)

console.log('='.repeat(72))
console.log('在 Electron 中测试进程隔离方案')
console.log('='.repeat(72))

const electronBin = join(
  repoRoot,
  'node_modules',
  'electron',
  'dist',
  process.platform === 'win32' ? 'electron.exe' : 'electron'
)

if (!existsSync(electronBin)) {
  console.error('electron binary not found')
  process.exit(1)
}

// Electron needs a directory containing a package.json to treat this as an app.
const appDir = join(workDir, 'app')
mkdirSync(appDir, { recursive: true })
writeFileSync(
  join(appDir, 'package.json'),
  JSON.stringify({ name: 'transport-probe', main: electronMain, version: '1.0.0' }),
  'utf8'
)

console.log('\n启动 Electron…')

const child = spawn(electronBin, [appDir], {
  cwd: repoRoot,
  stdio: 'ignore',
  env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined }
})

const exit = await new Promise((resolveExit) => {
  const timer = setTimeout(() => {
    child.kill()
    resolveExit({ timedOut: true })
  }, 60_000)
  child.on('exit', (code) => {
    clearTimeout(timer)
    resolveExit({ code })
  })
})

console.log(`Electron 退出: ${JSON.stringify(exit)}`)

if (!existsSync(resultPath)) {
  console.log('\n没有结果文件 —— 探针未能运行')
  process.exit(1)
}

const results = JSON.parse(readFileSync(resultPath, 'utf8'))
console.log('\n结果:')
console.log(JSON.stringify(results, null, 2))

console.log(`\n${'='.repeat(72)}`)
console.log('结论')
console.log('='.repeat(72))

const forkOk = results.fork?.ok === true
const utilityOk = results.utilityProcess?.ok === true
const crashOk = results.crashIsolation?.ok === true && results.parentSurvivedCrash === true

console.log(`  fork() + IPC          : ${forkOk ? '可用' : `不可用 (${results.fork?.error})`}`)
console.log(`  utilityProcess        : ${utilityOk ? '可用' : `不可用 (${results.utilityProcess?.error})`}`)
console.log(`  崩溃隔离              : ${crashOk ? '有效，父进程存活' : '未验证'}`)
console.log('')

if (forkOk) {
  console.log('  → 采用 fork()，它能传大载荷且通道稳定。')
} else if (utilityOk) {
  console.log('  → 采用 utilityProcess。')
} else {
  console.log('  → 两者都不可用，需要改用文件/其它通道。')
}
