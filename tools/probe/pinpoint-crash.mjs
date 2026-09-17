/**
 * Confirm the crash mechanism and determine a safe containment strategy.
 *
 * The previous probe showed the parent process dying with no output the moment
 * the worker started. That rules out an ordinary exception. This narrows it to
 * one of: a V8 fatal abort, an OOM kill, or a deliberate `process.abort()`-style
 * self-defence trap in the obfuscator's runtime.
 *
 * The test writes a marker file before and after, so even a hard abort leaves
 * evidence of how far it got.
 *
 * Usage: node tools/probe/pinpoint-crash.mjs
 */
import { Worker } from 'node:worker_threads'
import { existsSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const scriptPath = join(repoRoot, 'crasher-1.js')
const markerDir = join(repoRoot, '.cache', 'crash-probe')

if (!existsSync(scriptPath)) {
  console.error('run tools/probe/extract-crasher.mjs first')
  process.exit(1)
}

const script = readFileSync(scriptPath, 'utf8')

console.log('='.repeat(72))
console.log('崩溃机制定位')
console.log('='.repeat(72))

/* ------------------------------------------------------------------ *
 * Test A: does the script itself (not the worker) abort the process?
 *
 * Run it in a vm context on a worker that does *nothing else*. If the process
 * still dies, the abort comes from the script's own code.
 * ------------------------------------------------------------------ */

const minimalWorker = `
const { parentPort, workerData } = require('node:worker_threads')
const vm = require('node:vm')
const fs = require('node:fs')

const MARKER = ${JSON.stringify(markerDir)}

function mark(text) {
  try {
    fs.mkdirSync(MARKER, { recursive: true })
    fs.appendFileSync(MARKER + '/trace.log', text + '\\n')
  } catch {}
}

mark('worker started')

// Minimal lx surface: just enough for the script to run.
const EVENT_NAMES = { request: 'request', inited: 'inited', updateAlert: 'updateAlert' }
let inited = false
globalThis.lx = {
  EVENT_NAMES,
  env: 'desktop',
  version: '2.0.0',
  on: () => Promise.resolve(),
  send: (name, data) => {
    if (name === EVENT_NAMES.inited) {
      inited = true
      mark('inited called')
      parentPort.postMessage({ type: 'inited', data })
    }
    return Promise.resolve()
  },
  request: () => Promise.resolve({}),
  utils: { buffer: { from: () => Buffer.alloc(0), bufToString: () => '' }, crypto: {}, zlib: {} }
}

mark('lx installed')
mark('script length ' + workerData.script.length)

try {
  const context = vm.createContext(globalThis, { name: 'probe' })
  mark('context created')
  vm.runInContext(workerData.script, context, { filename: 'crasher.js' })
  mark('script executed to completion')
  if (!inited) {
    mark('WARNING: script finished without calling inited')
    parentPort.postMessage({ type: 'no-init' })
  }
} catch (e) {
  mark('caught: ' + (e && e.name) + ': ' + (e && e.message))
  parentPort.postMessage({ type: 'error', message: String((e && e.message) || e) })
}
`

const minimalPath = join(repoRoot, '.cache', 'minimal-worker.cjs')
writeFileSync(minimalPath, minimalWorker, 'utf8')

// Clear the trace before running.
try {
  unlinkSync(join(markerDir, 'trace.log'))
} catch {
  /* no previous trace */
}

console.log('\n--- A. 最小 worker（只装 lx 并执行脚本）---')
console.log('    这个进程会打印结果，或直接消失。')

const worker = new Worker(minimalPath, {
  workerData: { script },
  stdout: 'inherit',
  stderr: 'inherit'
})

const outcome = await new Promise((resolveOutcome) => {
  const timer = setTimeout(() => resolveOutcome('timeout'), 15_000)
  worker.on('message', (message) => {
    clearTimeout(timer)
    resolveOutcome(`message: ${JSON.stringify(message).slice(0, 200)}`)
  })
  worker.on('error', (error) => {
    clearTimeout(timer)
    resolveOutcome(`error: ${error.name}: ${error.message}`)
  })
  worker.on('exit', (code) => {
    clearTimeout(timer)
    resolveOutcome(`exit ${code}`)
  })
})

console.log(`  结果: ${outcome}`)

// The trace file survives a hard abort, so it shows how far execution got.
const tracePath = join(markerDir, 'trace.log')
if (existsSync(tracePath)) {
  console.log('\n  执行轨迹（即使进程被 abort 也会留下）:')
  for (const line of readFileSync(tracePath, 'utf8').trim().split('\n')) {
    console.log(`    ${line}`)
  }
} else {
  console.log('\n  没有轨迹文件 —— worker 在写第一行之前就死了')
}

console.log(`\n${'='.repeat(72)}`)
console.log('结论')
console.log('='.repeat(72))
console.log(`
如果轨迹停在 "script length …" 而没有 "inited called"，说明脚本在
执行过程中让进程直接 abort。这类混淆脚本通常带自我保护：检测到宿主
环境不是预期的浏览器/Node 形态时，主动崩溃以阻止分析。

对我们的意义：worker_threads 的隔离挡不住 process.abort()——它杀的是
整个进程。要真正隔离，必须把音源放进**独立进程**（child_process），
而不是 worker 线程。
`)
