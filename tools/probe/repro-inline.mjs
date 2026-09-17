/**
 * Reproduce the crashing source inside this process, without spawning children.
 *
 * A sandbox that blocks named pipes makes `spawnSync` useless here, so the
 * worker is created directly and every termination path is instrumented. The
 * goal is to learn *how* the script dies: an abort, an OOM, a stack overflow,
 * or an intentional self-defence trap.
 *
 * Usage: node tools/probe/repro-inline.mjs
 */
import { Worker } from 'node:worker_threads'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const scriptPath = join(repoRoot, 'crasher-1.js')
const workerPath = join(repoRoot, 'out', 'test', 'lx-worker.js')

if (!existsSync(scriptPath)) {
  console.error('run tools/probe/extract-crasher.mjs first')
  process.exit(1)
}

const script = readFileSync(scriptPath, 'utf8')

console.log('='.repeat(72))
console.log('崩溃复现（进程内，worker 隔离）')
console.log('='.repeat(72))
console.log(`\n脚本: ${script.length} 字符`)

/** Run one attempt and resolve with how it ended. */
function attempt(label, options) {
  return new Promise((resolveAttempt) => {
    const started = Date.now()
    let settled = false
    const output = []

    const worker = new Worker(workerPath, {
      workerData: {
        script,
        env: 'desktop',
        version: '2.0.0',
        apiId: 'crasher',
        scriptInfo: {
          name: 'crasher',
          description: '',
          version: '6',
          author: '',
          homepage: ''
        }
      },
      ...options
    })

    const finish = (outcome) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      void worker.terminate().catch(() => undefined)
      resolveAttempt({ ...outcome, elapsed: Date.now() - started, output })
    }

    // The app's own init budget is 15 s.
    const timer = setTimeout(() => finish({ status: 'TIMEOUT (no inited in 15s)' }), 15_000)

    worker.stdout?.on('data', (c) => output.push(`stdout: ${c.toString().trim()}`))
    worker.stderr?.on('data', (c) => output.push(`stderr: ${c.toString().trim()}`))

    worker.on('message', (message) => {
      if (message.type === 'inited') {
        const sources = Object.keys(message.data?.sources ?? {})
        finish({ status: 'inited', detail: `sources=[${sources.join(',')}]` })
      } else if (message.type === 'boot-error') {
        finish({ status: 'boot-error', detail: String(message.error).slice(0, 300) })
      } else if (message.type === 'log') {
        output.push(`log: ${String(message.message).slice(0, 160)}`)
      }
    })

    worker.on('error', (error) => {
      finish({ status: 'worker-error', detail: `${error.name}: ${error.message}` })
    })

    worker.on('exit', (code) => {
      finish({ status: code === 0 ? 'EXIT 0 (never inited)' : `EXIT ${code}`, detail: '' })
    })
  })
}

const ATTEMPTS = [
  {
    label: '默认（与主程序相同的 resourceLimits）',
    options: { resourceLimits: { maxOldGenerationSizeMb: 256, maxYoungGenerationSizeMb: 32 } }
  },
  { label: '无 resourceLimits', options: {} },
  {
    label: '大内存 (2GB) + 大栈',
    options: {
      resourceLimits: { maxOldGenerationSizeMb: 2048, stackSizeMb: 8 }
    }
  },
  {
    label: '无 stdout/stderr 管道',
    options: {
      resourceLimits: { maxOldGenerationSizeMb: 256 },
      stdout: false,
      stderr: false
    }
  }
]

for (const test of ATTEMPTS) {
  console.log(`\n--- ${test.label} ---`)
  const result = await attempt(test.label, test.options)
  console.log(`  ${result.status}  (${result.elapsed} ms)`)
  if (result.detail) console.log(`  ${result.detail}`)
  if (result.output.length > 0) {
    console.log('  输出:')
    for (const line of result.output.slice(-10)) {
      console.log(`    ${line.slice(0, 190)}`)
    }
  } else {
    console.log('  （脚本没有产生任何输出）')
  }
}

console.log(`\n${'='.repeat(72)}`)
console.log('对照：正常音源')
console.log('='.repeat(72))
const goodPath = join(repoRoot, 'crasher-0.js')
if (existsSync(goodPath)) {
  const goodScript = readFileSync(goodPath, 'utf8')
  const result = await new Promise((resolveAttempt) => {
    const worker = new Worker(workerPath, {
      workerData: {
        script: goodScript,
        env: 'desktop',
        version: '2.0.0',
        apiId: 'good',
        scriptInfo: { name: 'good', description: '', version: '3.2.0', author: '', homepage: '' }
      },
      resourceLimits: { maxOldGenerationSizeMb: 256 }
    })
    const timer = setTimeout(() => {
      void worker.terminate()
      resolveAttempt('TIMEOUT')
    }, 15_000)
    worker.on('message', (m) => {
      if (m.type === 'inited') {
        clearTimeout(timer)
        void worker.terminate()
        resolveAttempt(`inited: ${Object.keys(m.data?.sources ?? {}).join(',')}`)
      } else if (m.type === 'boot-error') {
        clearTimeout(timer)
        void worker.terminate()
        resolveAttempt(`boot-error: ${m.error}`)
      }
    })
    worker.on('error', (e) => {
      clearTimeout(timer)
      resolveAttempt(`error: ${e.message}`)
    })
    worker.on('exit', (code) => {
      clearTimeout(timer)
      resolveAttempt(`exit ${code}`)
    })
  })
  console.log(`  codex多音源轮换: ${result}`)
}
