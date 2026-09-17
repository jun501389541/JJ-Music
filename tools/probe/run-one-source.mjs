/**
 * Run one named 音源 in the host process and print everything it does.
 *
 * Used to see why a particular source fails now that it can no longer take the
 * app down with it. With isolation in place, a failure is just a failure and
 * the reason is recoverable — which is the whole point of the change.
 *
 * Usage: node tools/probe/run-one-source.mjs <name-or-index>
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

const query = process.argv[2] ?? '0'

if (!existsSync(hostPath)) {
  console.error('source-host.cjs missing - run: node tools/build-test.mjs')
  process.exit(1)
}

const scratch = mkdtempSync(join(tmpdir(), 'jj-one-'))
const store = new SourceStore(scratch)
store.load()
store.importLxFile(readFileSync(sourcesPath, 'utf8'))
const apis = store.list()

const index = /^\d+$/.test(query) ? Number(query) : apis.findIndex((a) => a.meta.name === query)
const api = apis[index]

if (!api) {
  console.error(`找不到音源: ${query}`)
  console.error('可用: ' + apis.map((a, i) => `${i}=${a.meta.name}`).join(', '))
  process.exit(1)
}

console.log('='.repeat(72))
console.log(`运行音源: ${api.meta.name} (v${api.meta.version})`)
console.log('='.repeat(72))
console.log(`脚本 ${api.source.length} 字符\n`)

// Hand the script over exactly as the engine does.
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

const child = fork(hostPath, [scriptPath, initPath], {
  stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  cwd: scratch
})

const started = Date.now()

child.stdout?.on('data', (chunk) => process.stdout.write(`  [脚本输出] ${chunk}`))
child.stderr?.on('data', (chunk) => process.stdout.write(`  [脚本错误] ${chunk}`))

child.on('message', (message) => {
  const elapsed = Date.now() - started
  if (message.type === 'ready') {
    console.log(`\n✓ 就绪 (${elapsed} ms)`)
    console.log(`  平台: ${Object.keys(message.sources ?? {}).join(', ') || '(无)'}`)
    child.kill()
  } else if (message.type === 'boot-error') {
    console.log(`\n✗ 初始化失败 (${elapsed} ms)`)
    console.log(`  ${String(message.error).slice(0, 600)}`)
    child.kill()
  } else if (message.type === 'log') {
    console.log(`  [${message.level}] ${String(message.message).slice(0, 300)}`)
  } else {
    console.log(`  [${message.type}] ${JSON.stringify(message).slice(0, 200)}`)
  }
})

child.on('exit', (code, signal) => {
  const elapsed = Date.now() - started
  console.log(`\n进程退出: code=${code} signal=${signal} (${elapsed} ms)`)

  // Name the common causes rather than leaving a bare exit code.
  if (code === 134 || signal === 'SIGABRT') {
    console.log('  → 进程被 abort()，典型的混淆脚本自我保护。')
  } else if (code === 2) {
    console.log('  → 缺少启动参数（宿主进程未能读取脚本或配置）。')
  } else if (code === 1) {
    console.log('  → 脚本抛出了未捕获异常，或主动调用 process.exit(1)。')
  } else if (code === 137 || signal === 'SIGKILL') {
    console.log('  → 被强杀，可能是内存超限。')
  }

  rmSync(scratch, { recursive: true, force: true })
  process.exit(0)
})

setTimeout(() => {
  console.log(`\n超时：15s 内没有报告就绪`)
  child.kill()
}, 15_000)
