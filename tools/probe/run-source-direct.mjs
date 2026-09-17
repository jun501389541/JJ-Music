/**
 * Run the "独家音源" obfuscated script directly in Node with no sandbox.
 *
 * Everything else has failed to produce a message: the host exits with code 1
 * within 45 ms, printing nothing to stdout or stderr. A plain throw would print
 * a stack, so the script is either calling `process.exit` itself or dying inside
 * the obfuscator's runtime.
 *
 * Running it with only a minimal `lx` stub, and with `process.exit` trapped,
 * isolates the script's behaviour from the host's plumbing.
 *
 * Usage: node tools/probe/run-source-direct.mjs
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const load = (rel) => import(pathToFileURL(join(repoRoot, 'out', 'test', rel)).href)
const { SourceStore } = await load('sources/source-store.js')

const sourcesPath = join(process.env.APPDATA ?? '', 'jj-music', 'sources', 'user_api.json')
const scratch = mkdtempSync(join(tmpdir(), 'jj-direct-'))
const store = new SourceStore(scratch)
store.load()
store.importLxFile(readFileSync(sourcesPath, 'utf8'))
const api = store.list().find((a) => a.meta.name === '独家音源')

if (!api) {
  console.error('找不到「独家音源」')
  process.exit(1)
}

// Write the script out so it can be inspected and run in a child process.
const scriptPath = join(scratch, 'source.js')
writeFileSync(scriptPath, api.source, 'utf8')

console.log('='.repeat(72))
console.log('直接运行混淆脚本（无沙箱包装）')
console.log('='.repeat(72))
console.log(`脚本: ${scriptPath}`)
console.log(`长度: ${api.source.length} 字符\n`)

/* ------------------------------------------------------------------ *
 * A minimal runner that traps every exit path
 * ------------------------------------------------------------------ */

const runnerPath = join(scratch, 'runner.cjs')
writeFileSync(
  runnerPath,
  `
const fs = require('node:fs')
const path = require('node:path')
const scriptPath = process.argv[2]
const tracePath = process.argv[3]

function mark(text) {
  try { fs.appendFileSync(tracePath, text + '\\n') } catch {}
}

mark('runner start')

// Trap the exit paths before anything else loads.
const realExit = process.exit.bind(process)
process.exit = function (code) {
  mark('process.exit(' + code + ')')
  mark('stack: ' + String(new Error().stack).split('\\n').slice(1, 10).join(' | '))
  return realExit(code)
}
process.on('exit', (code) => mark('exit event: ' + code))
process.on('uncaughtException', (e) => {
  mark('uncaughtException: ' + (e && e.name) + ': ' + (e && e.message))
  mark('stack: ' + String(e && e.stack).split('\\n').slice(0, 10).join(' | '))
})
process.on('unhandledRejection', (e) => {
  mark('unhandledRejection: ' + (e && e.message))
})

// Minimal lx surface.
const EVENT_NAMES = { request: 'request', inited: 'inited', updateAlert: 'updateAlert' }
let inited = false
globalThis.lx = {
  EVENT_NAMES,
  env: 'desktop',
  version: '2.0.0',
  currentScriptInfo: { name: 'x', description: '', version: '6', author: '', homepage: '', rawScript: '' },
  on: (name, fn) => { mark('lx.on(' + name + ')'); return Promise.resolve() },
  send: (name, data) => {
    mark('lx.send(' + name + ')')
    if (name === EVENT_NAMES.inited) inited = true
    return Promise.resolve()
  },
  request: () => Promise.resolve({ statusCode: 200, headers: {}, body: {} }),
  utils: {
    buffer: { from: () => Buffer.alloc(0), bufToString: () => '' },
    crypto: { md5: () => '', randomBytes: (n) => Buffer.alloc(n) },
    zlib: { inflate: (b) => Promise.resolve(Buffer.alloc(0)), deflate: () => Promise.resolve(Buffer.alloc(0)) }
  }
}

// Common browser globals obfuscators probe.
globalThis.window = globalThis
globalThis.self = globalThis
globalThis.document = { createElement: () => ({}), head: { appendChild: () => {} }, addEventListener: () => {} }
globalThis.navigator = { userAgent: 'node' }
globalThis.atob = (s) => Buffer.from(s, 'base64').toString('binary')
globalThis.btoa = (s) => Buffer.from(s, 'binary').toString('base64')

const script = fs.readFileSync(scriptPath, 'utf8')
mark('script read: ' + script.length + ' chars')

try {
  mark('evaluating')
  // Indirect eval puts it in global scope, closest to how a page would run it.
  ;(0, eval)(script)
  mark('eval returned; inited=' + inited)
} catch (e) {
  mark('eval threw: ' + (e && e.name) + ': ' + (e && e.message))
  mark('stack: ' + String(e && e.stack).split('\\n').slice(0, 12).join(' | '))
}

setTimeout(() => {
  mark('timeout reached; inited=' + inited)
  process.exit(0)
}, 4000)
`,
  'utf8'
)

const tracePath = join(scratch, 'trace.log')
const { spawn } = await import('node:child_process')

const child = spawn(process.execPath, [runnerPath, scriptPath, tracePath], {
  stdio: 'ignore',
  cwd: repoRoot
})

await new Promise((resolveDone) => {
  const timer = setTimeout(() => {
    child.kill()
    resolveDone()
  }, 20_000)
  child.on('exit', (code, signal) => {
    clearTimeout(timer)
    console.log(`子进程退出: code=${code} signal=${signal}`)
    resolveDone()
  })
})

console.log('\n执行轨迹:')
if (existsSync(tracePath)) {
  for (const line of readFileSync(tracePath, 'utf8').trim().split('\n')) {
    console.log(`  ${line.slice(0, 320)}`)
  }
} else {
  console.log('  （无轨迹）')
}

rmSync(scratch, { recursive: true, force: true })
