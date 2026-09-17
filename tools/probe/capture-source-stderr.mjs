/**
 * Capture the exact stderr of a source host child process.
 *
 * `run-one-source.mjs` reported "exit 1 with no output", which means the failure
 * happens before the host's own error reporting can send a `boot-error` message.
 * The child's stderr is the only place that reason appears, so this forwards it
 * verbatim.
 *
 * Usage: node tools/probe/capture-source-stderr.mjs <name-or-index>
 */
import { fork } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const load = (rel) => import(pathToFileURL(join(repoRoot, 'out', 'test', rel)).href)
const { SourceStore } = await load('sources/source-store.js')

const hostPath = join(repoRoot, 'out', 'test', 'source-host.cjs')
const sourcesPath = join(process.env.APPDATA ?? '', 'jj-music', 'sources', 'user_api.json')
const query = process.argv[2] ?? '独家音源'

const scratch = mkdtempSync(join(tmpdir(), 'jj-stderr-'))
const store = new SourceStore(scratch)
store.load()
store.importLxFile(readFileSync(sourcesPath, 'utf8'))
const apis = store.list()
const api = /^\d+$/.test(query) ? apis[Number(query)] : apis.find((a) => a.meta.name === query)

if (!api) {
  console.error(`找不到音源: ${query}`)
  console.error('可用: ' + apis.map((a, i) => `${i}=${a.meta.name}`).join(', '))
  process.exit(1)
}

console.log('='.repeat(72))
console.log(`捕获 stderr: ${api.meta.name}`)
console.log('='.repeat(72))
console.log(`脚本 ${api.source.length} 字符\n`)

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

// Run from the host's own directory, matching the engine.
const child = fork(hostPath, [scriptPath, initPath], {
  stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  cwd: dirname(hostPath)
})

const started = Date.now()
const out = []
const err = []

child.stdout?.on('data', (chunk) => out.push(chunk.toString()))
child.stderr?.on('data', (chunk) => err.push(chunk.toString()))

child.on('message', (message) => {
  const elapsed = Date.now() - started
  if (message.type === 'ready') {
    console.log(`✓ 就绪 (${elapsed} ms) — 平台: ${Object.keys(message.sources ?? {}).join(', ')}`)
    child.kill()
  } else if (message.type === 'boot-error') {
    console.log(`✗ 初始化失败 (${elapsed} ms)`)
    console.log(`  ${String(message.error).slice(0, 500)}`)
  } else if (message.type === 'log') {
    console.log(`  [${message.level}] ${String(message.message).slice(0, 250)}`)
  }
})

await new Promise((resolveDone) => {
  child.on('exit', (code, signal) => {
    const elapsed = Date.now() - started
    console.log(`\n退出: code=${code} signal=${signal} (${elapsed} ms)`)
    resolveDone()
  })
  setTimeout(() => {
    child.kill()
    resolveDone()
  }, 15_000)
})

if (out.length > 0) {
  console.log('\nstdout:')
  for (const line of out.join('').trim().split('\n').slice(0, 30)) {
    console.log(`  ${line.slice(0, 300)}`)
  }
}

if (err.length > 0) {
  console.log('\nstderr（真实错误在这里）:')
  for (const line of err.join('').trim().split('\n').slice(0, 40)) {
    console.log(`  ${line.slice(0, 300)}`)
  }
} else {
  console.log('\nstderr: （空）')
}

rmSync(scratch, { recursive: true, force: true })
