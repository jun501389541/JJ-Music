/**
 * Make the crash observable instead of fatal.
 *
 * Every attempt so far ends the same way: the Node process vanishes with no
 * output, taking the diagnostic with it. The fix is to stop running the script
 * in-process at all and have a *supervisor* watch it from outside, writing its
 * findings to disk as it goes so a hard abort still leaves evidence.
 *
 * Because this sandbox blocks named pipes, the supervisor cannot use
 * `child_process` with piped stdio. It therefore spawns the child with
 * `stdio: 'ignore'` and the child reports through files — which is also exactly
 * how the app itself must be fixed.
 *
 * Usage: node tools/probe/supervised-crash.mjs
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const scriptPath = join(repoRoot, 'crasher-1.js')
const workDir = join(repoRoot, '.cache', 'supervised')
const resultPath = join(workDir, 'result.json')

if (!existsSync(scriptPath)) {
  console.error('run tools/probe/extract-crasher.mjs first')
  process.exit(1)
}

mkdirSync(workDir, { recursive: true })
try {
  unlinkSync(resultPath)
} catch {
  /* none */
}

/**
 * The child runs ONE source in a real worker and writes a JSON result before
 * exiting. If the process is aborted by the script, no result file appears —
 * and that absence is itself the finding.
 */
const childSource = `
const { Worker } = require('node:worker_threads')
const { readFileSync, writeFileSync, appendFileSync, mkdirSync } = require('node:fs')

const scriptPath = process.argv[2]
const workerPath = process.argv[3]
const outPath = process.argv[4]
const logPath = process.argv[5]

function log(text) {
  try { appendFileSync(logPath, text + '\\n') } catch {}
}

log('child started pid=' + process.pid)
const script = readFileSync(scriptPath, 'utf8')
log('script read ' + script.length + ' chars')

process.on('uncaughtException', (e) => { log('uncaughtException: ' + e.message) })
process.on('unhandledRejection', (e) => { log('unhandledRejection: ' + (e && e.message)) })
process.on('exit', (c) => { log('child exiting code=' + c) })

const worker = new Worker(workerPath, {
  workerData: {
    script,
    env: 'desktop',
    version: '2.0.0',
    apiId: 'probe',
    scriptInfo: { name: 'probe', description: '', version: '6', author: '', homepage: '' }
  },
  resourceLimits: { maxOldGenerationSizeMb: 256, maxYoungGenerationSizeMb: 32 },
  stdout: true,
  stderr: true
})

log('worker created')

worker.stdout.on('data', (c) => log('[out] ' + c.toString().trim().slice(0, 200)))
worker.stderr.on('data', (c) => log('[err] ' + c.toString().trim().slice(0, 200)))

worker.on('message', (m) => {
  log('message: ' + m.type)
  if (m.type === 'inited' || m.type === 'boot-error') {
    writeFileSync(outPath, JSON.stringify({
      ok: m.type === 'inited',
      sources: m.data ? Object.keys(m.data.sources || {}) : [],
      error: m.error || null,
      ms: Date.now() - start
    }))
  }
})

worker.on('error', (e) => {
  log('worker error: ' + e.name + ': ' + e.message)
  writeFileSync(outPath, JSON.stringify({ ok: false, error: e.name + ': ' + e.message }))
})

worker.on('exit', (code) => {
  log('worker exit ' + code)
  if (!require('node:fs').existsSync(outPath)) {
    writeFileSync(outPath, JSON.stringify({ ok: false, error: 'worker exited ' + code + ' without reporting' }))
  }
  process.exit(0)
})

const start = Date.now()
setTimeout(() => {
  log('timeout')
  if (!require('node:fs').existsSync(outPath)) {
    writeFileSync(outPath, JSON.stringify({ ok: false, error: 'timeout: no init within 15s' }))
  }
  process.exit(0)
}, 15000)
`

const childPath = join(workDir, 'child.cjs')
writeFileSync(childPath, childSource, 'utf8')

console.log('='.repeat(72))
console.log('受监督的崩溃复现')
console.log('='.repeat(72))

async function runOne(label, targetScript) {
  const logPath = join(workDir, 'trace.log')
  try {
    unlinkSync(resultPath)
  } catch {
    /* none */
  }
  try {
    unlinkSync(logPath)
  } catch {
    /* none */
  }

  console.log(`\n--- ${label} ---`)

  const child = spawn(
    process.execPath,
    [childPath, targetScript, join(repoRoot, 'out', 'test', 'lx-worker.js'), resultPath, logPath],
    {
      cwd: repoRoot,
      // Piped stdio needs a named pipe, which this sandbox blocks; the child
      // reports through files instead.
      stdio: 'ignore',
      detached: false
    }
  )

  const exitInfo = await new Promise((resolveExit) => {
    const timer = setTimeout(() => {
      child.kill()
      resolveExit({ timedOut: true })
    }, 40_000)
    child.on('exit', (code, signal) => {
      clearTimeout(timer)
      resolveExit({ code, signal })
    })
    child.on('error', (error) => {
      clearTimeout(timer)
      resolveExit({ error: error.message })
    })
  })

  console.log(
    `  子进程: code=${exitInfo.code ?? 'null'} signal=${exitInfo.signal ?? 'null'}` +
      (exitInfo.timedOut ? ' (被超时杀死)' : '') +
      (exitInfo.error ? ` error=${exitInfo.error}` : '')
  )

  if (existsSync(logPath)) {
    console.log('  轨迹:')
    for (const line of readFileSync(logPath, 'utf8').trim().split('\n').slice(-14)) {
      console.log(`    ${line.slice(0, 190)}`)
    }
  } else {
    console.log('  （没有轨迹文件）')
  }

  if (existsSync(resultPath)) {
    const result = JSON.parse(readFileSync(resultPath, 'utf8'))
    console.log(`  结果: ${JSON.stringify(result).slice(0, 250)}`)
    return result
  }

  console.log('  ✗ 没有结果文件 —— 进程被脚本强行终止')
  return null
}

const crashing = await runOne('独家音源（会崩溃的那个）', scriptPath)
const goodPath = join(repoRoot, 'crasher-0.js')
if (existsSync(goodPath)) {
  await runOne('codex多音源轮换（对照）', goodPath)
}

console.log(`\n${'='.repeat(72)}`)
console.log('结论')
console.log('='.repeat(72))
if (!crashing) {
  console.log(`
"独家音源" 会让整个进程消失，连 worker 的 exit 事件都不触发。

这意味着它不是抛异常，而是触发了**进程级终止**。在 worker_threads 里
这挡不住：worker 与主线程共享同一个进程，任何 abort / OOM / 栈溢出
都会连带杀死宿主。

结论：音源必须跑在**独立子进程**里，而不是 worker 线程。
`)
} else {
  console.log('\n该音源在子进程中表现正常。')
}
