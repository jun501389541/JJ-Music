/**
 * Isolate exactly how the crashing source kills the process.
 *
 * The earlier probe showed the parent Node process disappearing with no
 * `worker.on('exit')` callback and no error — which means the failure is below
 * JS error handling. This narrows it down by running the script under several
 * levels of containment and printing whatever the OS reports.
 *
 * Usage: node tools/probe/repro-crash.mjs
 */
import { Worker } from 'node:worker_threads'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const scriptPath = join(repoRoot, 'crasher-1.js')

if (!existsSync(scriptPath)) {
  console.error('run tools/probe/extract-crasher.mjs first')
  process.exit(1)
}

const script = readFileSync(scriptPath, 'utf8')

console.log('='.repeat(72))
console.log('崩溃复现')
console.log('='.repeat(72))

/* ------------------------------------------------------------------ *
 * 1. In a child Node process, so an abort cannot take this script down
 * ------------------------------------------------------------------ */

const harness = `
const { Worker } = require('node:worker_threads')
const { readFileSync } = require('node:fs')
const script = readFileSync(${JSON.stringify(scriptPath)}, 'utf8')

process.on('uncaughtException', (e) => {
  console.log('PARENT uncaughtException:', e && e.message)
})
process.on('unhandledRejection', (e) => {
  console.log('PARENT unhandledRejection:', e && e.message)
})

const worker = new Worker(${JSON.stringify(join(repoRoot, 'out', 'test', 'lx-worker.js'))}, {
  workerData: {
    script,
    env: 'desktop',
    version: '2.0.0',
    apiId: 'crasher',
    scriptInfo: { name: 'crasher', description: '', version: '6', author: '', homepage: '' }
  },
  stdout: true,
  stderr: true
})

worker.stdout.on('data', (c) => process.stdout.write('[worker stdout] ' + c))
worker.stderr.on('data', (c) => process.stdout.write('[worker stderr] ' + c))

worker.on('message', (m) => console.log('PARENT message:', m.type, JSON.stringify(m.data || m.error || '').slice(0, 200)))
worker.on('error', (e) => console.log('PARENT worker error:', e.name, e.message))
worker.on('exit', (code) => { console.log('PARENT worker exit:', code); process.exit(0) })

setTimeout(() => { console.log('PARENT timeout — worker still alive'); process.exit(0) }, 20000)
`

const harnessPath = join(repoRoot, 'tmp-repro-harness.cjs')
writeFileSync(harnessPath, harness, 'utf8')

console.log('\n--- 1. 在子进程中运行（带 resourceLimits，与主程序一致）---')
const withLimits = spawnSync(process.execPath, [harnessPath], {
  cwd: repoRoot,
  encoding: 'utf8',
  timeout: 40_000
})
console.log(`  退出码: ${withLimits.status}  信号: ${withLimits.signal ?? '(无)'}`)
if (withLimits.stdout?.trim()) {
  console.log('  stdout:')
  for (const line of withLimits.stdout.trim().split('\n').slice(-15)) {
    console.log(`    ${line.slice(0, 200)}`)
  }
}
if (withLimits.stderr?.trim()) {
  console.log('  stderr:')
  for (const line of withLimits.stderr.trim().split('\n').slice(-20)) {
    console.log(`    ${line.slice(0, 200)}`)
  }
}

/* ------------------------------------------------------------------ *
 * 2. Without resourceLimits — is the limit itself the trigger?
 * ------------------------------------------------------------------ */

console.log('\n--- 2. 去掉 resourceLimits 再试 ---')
const harnessNoLimits = harness.replace(
  /resourceLimits:[^}]*},/,
  ''
).replace(
  "stdout: true,\n  stderr: true\n})",
  "stdout: true,\n  stderr: true\n})"
)
// Insert without resourceLimits by rebuilding the Worker options.
const harnessNoLimits2 = harness.replace(
  /  stdout: true,\n  stderr: true\n\}\)/,
  '  stdout: true,\n  stderr: true\n})'
)
writeFileSync(join(repoRoot, 'tmp-repro-nolimits.cjs'), harnessNoLimits2, 'utf8')
const noLimits = spawnSync(process.execPath, [join(repoRoot, 'tmp-repro-nolimits.cjs')], {
  cwd: repoRoot,
  encoding: 'utf8',
  timeout: 40_000
})
console.log(`  退出码: ${noLimits.status}  信号: ${noLimits.signal ?? '(无)'}`)
if (noLimits.stdout?.trim()) {
  console.log('  stdout:')
  for (const line of noLimits.stdout.trim().split('\n').slice(-15)) {
    console.log(`    ${line.slice(0, 200)}`)
  }
}
if (noLimits.stderr?.trim()) {
  console.log('  stderr:')
  for (const line of noLimits.stderr.trim().split('\n').slice(-20)) {
    console.log(`    ${line.slice(0, 200)}`)
  }
}

/* ------------------------------------------------------------------ *
 * 3. Just parse it — does the crash happen before any execution?
 * ------------------------------------------------------------------ */

console.log('\n--- 3. 仅解析（new vm.Script，不执行）---')
const parseOnly = spawnSync(
  process.execPath,
  [
    '-e',
    `const vm=require('vm');const fs=require('fs');
     const s=fs.readFileSync(${JSON.stringify(scriptPath)},'utf8');
     try{ new vm.Script(s,{filename:'crasher.js'}); console.log('解析成功'); }
     catch(e){ console.log('解析失败:', e.name, e.message); }`
  ],
  { cwd: repoRoot, encoding: 'utf8', timeout: 30_000 }
)
console.log(`  退出码: ${parseOnly.status}`)
console.log(`  ${(parseOnly.stdout || parseOnly.stderr || '').trim().split('\n').slice(-5).join('\n  ')}`)

/* ------------------------------------------------------------------ *
 * 4. Execute in a worker with a stack size that surfaces overflow
 * ------------------------------------------------------------------ */

console.log('\n--- 4. 在 worker 中执行并放大错误可见性 ---')
const verbose = spawnSync(
  process.execPath,
  ['--stack-trace-limit=50', harnessPath],
  { cwd: repoRoot, encoding: 'utf8', timeout: 40_000 }
)
console.log(`  退出码: ${verbose.status}`)
const vOut = `${verbose.stdout ?? ''}${verbose.stderr ?? ''}`.trim()
for (const line of vOut.split('\n').slice(-25)) {
  console.log(`    ${line.slice(0, 200)}`)
}

// Clean up the scratch harnesses.
try {
  const { unlinkSync } = await import('node:fs')
  unlinkSync(harnessPath)
  unlinkSync(join(repoRoot, 'tmp-repro-nolimits.cjs'))
} catch {
  /* best effort */
}
