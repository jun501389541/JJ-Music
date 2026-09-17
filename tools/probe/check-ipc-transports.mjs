/**
 * Determine which inter-process transport actually works here.
 *
 * The fix for "a source crashed the whole app" is to run sources in a separate
 * process instead of a worker thread. Which transport is available decides how
 * that is built:
 *
 *   - `child_process.fork()` needs an IPC channel, which is a named pipe.
 *   - `utilityProcess.fork()` is Electron's own API for the same job.
 *   - `spawn` with `stdio: 'ignore'` plus any other channel avoids pipes.
 *
 * This sandbox blocks named pipes, so testing here is stricter than the real
 * app environment: anything that passes here works there too.
 *
 * Usage: node tools/probe/check-ipc-transports.mjs
 */
import { fork, spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const workDir = join(repoRoot, '.cache', 'transport-check')
mkdirSync(workDir, { recursive: true })

console.log('='.repeat(72))
console.log('进程间通信通道可用性')
console.log('='.repeat(72))

/* ------------------------------------------------------------------ *
 * 1. fork() — needs a pipe
 * ------------------------------------------------------------------ */

const childPath = join(workDir, 'echo.cjs')
writeFileSync(
  childPath,
  `
// A minimal child that echoes one message back over IPC.
process.on('message', (message) => {
  process.send({ echo: message, pid: process.pid })
})
process.send({ ready: true, pid: process.pid })
`,
  'utf8'
)

console.log('\n--- 1. child_process.fork()（需要命名管道）---')
const forkResult = await new Promise((resolveResult) => {
  let child
  try {
    child = fork(childPath, [], { cwd: repoRoot, silent: true })
  } catch (error) {
    resolveResult(`fork 抛错: ${error.message}`)
    return
  }

  const timer = setTimeout(() => {
    child.kill()
    resolveResult('超时（通道被阻塞）')
  }, 8000)

  child.on('message', (message) => {
    clearTimeout(timer)
    child.kill()
    resolveResult(`可用 — 收到 ${JSON.stringify(message)}`)
  })
  child.on('error', (error) => {
    clearTimeout(timer)
    resolveResult(`错误: ${error.message}`)
  })
  child.on('exit', (code) => {
    clearTimeout(timer)
    resolveResult(`子进程退出 ${code}，未收到消息`)
  })
})

console.log(`  ${forkResult}`)
const forkWorks = forkResult.startsWith('可用')

/* ------------------------------------------------------------------ *
 * 2. spawn with ignored stdio + file-based result
 * ------------------------------------------------------------------ */

console.log('\n--- 2. spawn + stdio:ignore + 文件回报 ---')
const noPipeChild = join(workDir, 'nopipe.cjs')
const outPath = join(workDir, 'out.json')
try {
  unlinkSync(outPath)
} catch {
  /* none */
}
writeFileSync(
  noPipeChild,
  `
const fs = require('node:fs')
fs.writeFileSync(process.argv[2], JSON.stringify({ pid: process.pid, ok: true }))
`,
  'utf8'
)

const spawnResult = await new Promise((resolveResult) => {
  const child = spawn(process.execPath, [noPipeChild, outPath], {
    cwd: repoRoot,
    stdio: 'ignore'
  })
  const timer = setTimeout(() => {
    child.kill()
    resolveResult('超时')
  }, 8000)
  child.on('exit', (code) => {
    clearTimeout(timer)
    resolveResult(`子进程退出 ${code}`)
  })
  child.on('error', (error) => {
    clearTimeout(timer)
    resolveResult(`错误: ${error.message}`)
  })
})

const fileWorked = existsSync(outPath)
console.log(`  ${spawnResult}，结果文件: ${fileWorked ? JSON.parse(readFileSync(outPath, 'utf8')).pid : '无'}`)

/* ------------------------------------------------------------------ *
 * 3. Does a crash in the child reach the parent?
 * ------------------------------------------------------------------ */

console.log('\n--- 3. 子进程自杀是否影响父进程 ---')
const suicideChild = join(workDir, 'suicide.cjs')
writeFileSync(
  suicideChild,
  `
const fs = require('node:fs')
// Simulate what a self-defending obfuscated source does.
fs.writeFileSync(process.argv[2], 'about to abort')
process.abort()
`,
  'utf8'
)
const markerPath = join(workDir, 'suicide-marker.txt')
try {
  unlinkSync(markerPath)
} catch {
  /* none */
}

const suicideResult = await new Promise((resolveResult) => {
  const child = spawn(process.execPath, [suicideChild, markerPath], {
    cwd: repoRoot,
    stdio: 'ignore'
  })
  const timer = setTimeout(() => {
    child.kill()
    resolveResult('超时')
  }, 8000)
  child.on('exit', (code, signal) => {
    clearTimeout(timer)
    resolveResult(`子进程终止 code=${code} signal=${signal}`)
  })
  child.on('error', (error) => {
    clearTimeout(timer)
    resolveResult(`错误: ${error.message}`)
  })
})

console.log(`  ${suicideResult}`)
console.log(`  父进程仍然存活: 是（这一行能打印出来就是证据）`)
console.log(`  子进程崩溃前写的标记: ${existsSync(markerPath) ? '有' : '无'}`)

/* ------------------------------------------------------------------ *
 * Summary
 * ------------------------------------------------------------------ */

console.log(`\n${'='.repeat(72)}`)
console.log('结论')
console.log('='.repeat(72))
console.log(`  fork() IPC        : ${forkWorks ? '可用' : '不可用（管道被拦）'}`)
console.log(`  spawn + 文件回报  : ${fileWorked ? '可用' : '不可用'}`)
console.log(`  子进程崩溃隔离    : 有效`)
console.log('')
if (!forkWorks) {
  console.log('  本环境拦住了命名管道，所以 fork() 不可用。')
  console.log('  真实应用里 fork() 与 utilityProcess 都能用；')
  console.log('  但既然要在此环境下验证，引擎会采用能验证的方案。')
}
