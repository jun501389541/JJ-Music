/**
 * Find what the crashing source expects from the host environment.
 *
 * A minimal worker reproduces a plain `TypeError: Cannot read properties of
 * undefined (reading 'version')` rather than a process abort, which means the
 * abort in the real worker is a *second-order* failure — the script takes a
 * different path once more of the environment is present.
 *
 * This enumerates what the script touches on `lx` and on the globals, so the
 * missing or wrong-shaped piece can be identified instead of guessed.
 *
 * Usage: node tools/probe/what-does-it-need.mjs
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync, appendFileSync, unlinkSync } from 'node:fs'
import { Worker } from 'node:worker_threads'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const scriptPath = join(repoRoot, 'crasher-1.js')
const markerDir = join(repoRoot, '.cache', 'need-probe')

if (!existsSync(scriptPath)) {
  console.error('run tools/probe/extract-crasher.mjs first')
  process.exit(1)
}

const script = readFileSync(scriptPath, 'utf8')

console.log('='.repeat(72))
console.log('探测脚本期望的宿主环境')
console.log('='.repeat(72))

/* ------------------------------------------------------------------ *
 * Instrument every property access on the lx object with a Proxy, so the
 * failure names the exact field the script wanted.
 * ------------------------------------------------------------------ */

const probeWorker = `
const { parentPort, workerData } = require('node:worker_threads')
const vm = require('node:vm')
const fs = require('node:fs')
const crypto = require('node:crypto')
const zlib = require('node:zlib')

const MARKER = ${JSON.stringify(markerDir)}
function mark(text) {
  try {
    fs.mkdirSync(MARKER, { recursive: true })
    fs.appendFileSync(MARKER + '/trace.log', text + '\\n')
  } catch {}
}

const accessed = new Set()

const EVENT_NAMES = { request: 'request', inited: 'inited', updateAlert: 'updateAlert' }

const realLx = {
  EVENT_NAMES,
  env: 'desktop',
  version: '2.0.0',
  currentScriptInfo: { name: 'probe', description: '', version: '6', author: '', homepage: '', rawScript: workerData.script },
  on: () => Promise.resolve(),
  send: () => Promise.resolve(),
  request: () => Promise.resolve({ statusCode: 200, headers: {}, body: {} }),
  utils: {
    buffer: { from: (...a) => Buffer.from(...a), bufToString: (b, f) => Buffer.from(b).toString(f || 'utf8') },
    crypto: {
      md5: (s) => crypto.createHash('md5').update(s).digest('hex'),
      randomBytes: (n) => crypto.randomBytes(n),
      aesEncrypt: (b, m, k, iv) => { const c = crypto.createCipheriv(m, k, iv); return Buffer.concat([c.update(b), c.final()]) },
      rsaEncrypt: (b, k) => crypto.publicEncrypt({ key: k, padding: crypto.constants.RSA_NO_PADDING }, Buffer.concat([Buffer.alloc(128 - Buffer.from(b).length), Buffer.from(b)]))
    },
    zlib: {
      inflate: (b) => Promise.resolve(zlib.inflateSync(Buffer.from(b))),
      deflate: (d) => Promise.resolve(zlib.deflateSync(Buffer.from(d)))
    }
  }
}

// Wrap the lx object so every read is recorded. This is what turns an opaque
// "reading 'version' of undefined" into a named, actionable miss.
const lx = new Proxy(realLx, {
  get(target, prop) {
    const value = target[prop]
    accessed.add(String(prop))
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      return new Proxy(value, {
        get(inner, innerProp) {
          accessed.add(String(prop) + '.' + String(innerProp))
          return inner[innerProp]
        }
      })
    }
    return value
  }
})

globalThis.lx = lx

// Also record global reads that obfuscators commonly probe.
for (const name of ['window', 'document', 'navigator', 'self', 'globalThis']) {
  mark('global available: ' + name + '=' + (typeof globalThis[name]))
}

try {
  const context = vm.createContext(globalThis, { name: 'probe' })
  vm.runInContext(workerData.script, context, { filename: 'crasher.js' })
  mark('executed OK')
  parentPort.postMessage({ type: 'done', accessed: [...accessed] })
} catch (e) {
  mark('caught ' + (e && e.name) + ': ' + (e && e.message))
  // A stack points at the failing line, which is more useful than the message.
  mark('stack: ' + String((e && e.stack) || '').split('\\n').slice(0, 6).join(' | '))
  parentPort.postMessage({ type: 'error', message: String(e && e.message), accessed: [...accessed] })
}
`

const probePath = join(repoRoot, '.cache', 'need-probe-worker.cjs')
writeFileSync(probePath, probeWorker, 'utf8')
try {
  unlinkSync(join(markerDir, 'trace.log'))
} catch {
  /* none */
}

const worker = new Worker(probePath, {
  workerData: { script },
  stdout: 'inherit',
  stderr: 'inherit'
})

const outcome = await new Promise((resolveOutcome) => {
  const timer = setTimeout(() => resolveOutcome({ status: 'timeout' }), 20_000)
  worker.on('message', (message) => {
    clearTimeout(timer)
    resolveOutcome({ status: 'message', message })
  })
  worker.on('error', (error) => {
    clearTimeout(timer)
    resolveOutcome({ status: 'error', error: `${error.name}: ${error.message}` })
  })
  worker.on('exit', (code) => {
    clearTimeout(timer)
    resolveOutcome({ status: `exit ${code}` })
  })
})

console.log(`\n结果: ${outcome.status}`)
if (outcome.message) {
  console.log(`  ${JSON.stringify(outcome.message).slice(0, 400)}`)
}
if (outcome.error) {
  console.log(`  ${outcome.error}`)
}

const tracePath = join(markerDir, 'trace.log')
if (existsSync(tracePath)) {
  console.log('\n执行轨迹:')
  for (const line of readFileSync(tracePath, 'utf8').trim().split('\n')) {
    console.log(`  ${line.slice(0, 220)}`)
  }
}

if (outcome.message?.accessed) {
  console.log('\nlx 上被访问的字段:')
  for (const key of outcome.message.accessed.sort()) {
    console.log(`  ${key}`)
  }
}

await worker.terminate().catch(() => undefined)

/* ------------------------------------------------------------------ *
 * Compare: what does the working source touch?
 * ------------------------------------------------------------------ */

console.log(`\n${'='.repeat(72)}`)
console.log('对照：正常音源访问的 lx 字段')
console.log('='.repeat(72))

const goodPath = join(repoRoot, 'crasher-0.js')
if (existsSync(goodPath)) {
  const goodWorker = probeWorker.replace(
    /workerData\.script/g,
    'workerData.script'
  )
  const goodProbePath = join(repoRoot, '.cache', 'need-probe-good.cjs')
  writeFileSync(goodProbePath, goodWorker, 'utf8')

  try {
    unlinkSync(join(markerDir, 'trace.log'))
  } catch {
    /* none */
  }

  const goodWorkerInstance = new Worker(goodProbePath, {
    workerData: { script: readFileSync(goodPath, 'utf8') },
    stdout: 'inherit',
    stderr: 'inherit'
  })

  const goodOutcome = await new Promise((resolveOutcome) => {
    const timer = setTimeout(() => resolveOutcome({ status: 'timeout' }), 20_000)
    goodWorkerInstance.on('message', (message) => {
      clearTimeout(timer)
      resolveOutcome({ status: 'message', message })
    })
    goodWorkerInstance.on('error', (error) => {
      clearTimeout(timer)
      resolveOutcome({ status: 'error', error: `${error.name}: ${error.message}` })
    })
    goodWorkerInstance.on('exit', (code) => {
      clearTimeout(timer)
      resolveOutcome({ status: `exit ${code}` })
    })
  })

  console.log(`\n结果: ${goodOutcome.status}`)
  if (goodOutcome.message?.accessed) {
    console.log('lx 上被访问的字段:')
    for (const key of goodOutcome.message.accessed.sort()) {
      console.log(`  ${key}`)
    }
  }
  await goodWorkerInstance.terminate().catch(() => undefined)
}
