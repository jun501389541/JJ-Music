/**
 * Find out why the "独家音源" script exits with code 1 and no output.
 *
 * With the process boundary in place the app survives it, but the source still
 * does not work — and "exits silently after 44 ms" is not a useful diagnosis.
 * This instruments the host so the exit path is visible: an explicit
 * `process.exit`, an uncaught throw, or something in the obfuscator's runtime.
 *
 * Usage: node tools/probe/trace-source-exit.mjs <name-or-index>
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const load = (rel) => import(pathToFileURL(join(repoRoot, 'out', 'test', rel)).href)
const { SourceStore } = await load('sources/source-store.js')

const sourcesPath = join(process.env.APPDATA ?? '', 'jj-music', 'sources', 'user_api.json')
const query = process.argv[2] ?? '独家音源'

const scratch = mkdtempSync(join(tmpdir(), 'jj-trace-'))
const store = new SourceStore(scratch)
store.load()
store.importLxFile(readFileSync(sourcesPath, 'utf8'))
const apis = store.list()
const api = /^\d+$/.test(query) ? apis[Number(query)] : apis.find((a) => a.meta.name === query)

if (!api) {
  console.error(`找不到音源: ${query}`)
  process.exit(1)
}

console.log('='.repeat(72))
console.log(`追踪退出原因: ${api.meta.name}`)
console.log('='.repeat(72))

/* ------------------------------------------------------------------ *
 * Build a host variant that traces every exit path
 * ------------------------------------------------------------------ */

const hostSource = readFileSync(join(repoRoot, 'out', 'test', 'source-host.cjs'), 'utf8')

// Insert tracing at the very top, before the bundled code runs, so nothing can
// exit without being recorded.
const traced = `
const __fs = require('node:fs')
const __trace = process.argv[4] || null
function __mark(text) {
  try { if (__trace) __fs.appendFileSync(__trace, text + '\\n') } catch {}
}

__mark('start pid=' + process.pid)
__mark('argv=' + JSON.stringify(process.argv.slice(2, 4)))

// Catch every way the process can end.
const __realExit = process.exit.bind(process)
process.exit = function (code) {
  __mark('process.exit(' + code + ') called')
  __mark('stack=' + String(new Error().stack).split('\\n').slice(1, 8).join(' | '))
  return __realExit(code)
}
process.on('exit', (code) => __mark('exit event code=' + code))
process.on('beforeExit', (code) => __mark('beforeExit code=' + code))
process.on('uncaughtException', (e) => __mark('uncaughtException: ' + (e && e.name) + ': ' + (e && e.message)))
process.on('unhandledRejection', (e) => __mark('unhandledRejection: ' + (e && e.message)))

__mark('about to load host body')
try {
${hostSource}
  __mark('host body finished loading')
} catch (e) {
  __mark('host body threw: ' + (e && e.name) + ': ' + (e && e.message))
  __mark('stack=' + String(e && e.stack).split('\\n').slice(0, 10).join(' | '))
  throw e
}
`

const tracePath = join(scratch, 'trace.log')
const tracedHost = join(scratch, 'traced-host.cjs')
writeFileSync(tracedHost, traced, 'utf8')

const scriptPath = join(scratch, 'script.js')
const initPath = join(scratch, 'init.json')
writeFileSync(scriptPath, api.source, 'utf8')
writeFileSync(
  initPath,
  JSON.stringify({
    env: 'desktop',
    version: '2.0.0',
    apiId: api.meta.id,
    scriptInfo: {
      name: api.meta.name,
      description: api.meta.description,
      version: api.meta.version,
      author: api.meta.author,
      homepage: api.meta.homepage
    }
  }),
  'utf8'
)

const { fork } = await import('node:child_process')
const child = fork(tracedHost, [scriptPath, initPath, tracePath], {
  stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  cwd: scratch
})

child.stdout?.on('data', (chunk) => process.stdout.write(`  [out] ${chunk}`))
child.stderr?.on('data', (chunk) => process.stdout.write(`  [err] ${chunk}`))
child.on('message', (message) => {
  console.log(`  [message] ${message.type} ${JSON.stringify(message).slice(0, 200)}`)
})

await new Promise((resolveDone) => {
  child.on('exit', (code, signal) => {
    console.log(`\n进程退出: code=${code} signal=${signal}`)
    resolveDone()
  })
  setTimeout(() => {
    child.kill()
    resolveDone()
  }, 15_000)
})

console.log('\n执行轨迹:')
if (existsSync(tracePath)) {
  for (const line of readFileSync(tracePath, 'utf8').trim().split('\n')) {
    console.log(`  ${line.slice(0, 300)}`)
  }
} else {
  console.log('  （没有轨迹文件 —— 进程在写入任何内容之前就结束了）')
}

rmSync(scratch, { recursive: true, force: true })
