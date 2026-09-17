/**
 * Verify the 音源 sandbox supports the dynamic-code patterns LX allows.
 *
 * LX runs sources in a BrowserWindow where `eval` and `new Function` work, and
 * real obfuscated sources depend on them. The forked host process must match.
 *
 * Usage: node out/test/sandbox.test.mjs
 */
import { fork } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const HOST = join(__dirname, 'source-host.cjs')

let passed = 0
let failed = 0

function check(name, condition, detail = '') {
  if (condition) {
    passed += 1
    console.log(`  PASS  ${name}`)
  } else {
    failed += 1
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

/**
 * A script exercising every dynamic-code and browser-global pattern the real
 * installed aggregator uses. It hands the results back over the request channel
 * so the test also proves that channel works in both directions.
 */
const PROBE_SCRIPT = `
/*!
 * @name 沙箱能力探测
 * @description exercises dynamic code and browser globals
 * @version 1.0.0
 * @author test
 */
const { EVENT_NAMES, on, send } = globalThis.lx
const results = {}

try { results.eval = eval('1 + 1') === 2 } catch (e) { results.eval = 'ERR: ' + e.message }
try { results.fnCtor = new Function('a', 'b', 'return a + b')(2, 3) === 5 } catch (e) { results.fnCtor = 'ERR: ' + e.message }
try { results.fnGlobal = typeof Function('return this')() === 'object' } catch (e) { results.fnGlobal = 'ERR: ' + e.message }
try { results.window = typeof window === 'object' && typeof window.lx === 'object' } catch (e) { results.window = 'ERR: ' + e.message }
try { results.document = typeof document === 'object' && typeof document.createElement === 'function' } catch (e) { results.document = 'ERR: ' + e.message }
try { document.head.appendChild(document.createElement('script')); results.domOk = true } catch (e) { results.domOk = 'ERR: ' + e.message }
try { results.btoa = btoa('hello') === 'aGVsbG8=' } catch (e) { results.btoa = 'ERR: ' + e.message }
try { results.atob = atob('aGVsbG8=') === 'hello' } catch (e) { results.atob = 'ERR: ' + e.message }
try { localStorage.setItem('k', 'v'); results.storage = localStorage.getItem('k') === 'v' } catch (e) { results.storage = 'ERR: ' + e.message }
try { results.md5 = lx.utils.crypto.md5('abc') === '900150983cd24fb0d6963f7d28e17f72' } catch (e) { results.md5 = 'ERR: ' + e.message }
try { results.randBytes = lx.utils.crypto.randomBytes(8).length === 8 } catch (e) { results.randBytes = 'ERR: ' + e.message }
try { results.b64 = lx.utils.buffer.bufToString(lx.utils.buffer.from('hi'), 'base64') === 'aGk=' } catch (e) { results.b64 = 'ERR: ' + e.message }
try { results.zlib = typeof lx.utils.zlib.inflate === 'function' && typeof lx.utils.zlib.deflate === 'function' } catch (e) { results.zlib = 'ERR: ' + e.message }
try { results.scriptInfo = lx.currentScriptInfo && lx.currentScriptInfo.name === '沙箱能力探测' } catch (e) { results.scriptInfo = 'ERR: ' + e.message }
try { results.version = lx.version === '2.0.0' && lx.env === 'desktop' } catch (e) { results.version = 'ERR: ' + e.message }

Promise.resolve(lx.on('inited', () => {})).then(
  () => { results.onRejects = false },
  () => { results.onRejects = true }
).then(() => {
  globalThis.__probeResults = JSON.stringify(results)
  send(EVENT_NAMES.inited, { sources: {
    kw: { name: 'probe', type: 'music', actions: ['musicUrl'], qualitys: ['128k'] }
  } })
})

on(EVENT_NAMES.request, () => Promise.resolve(globalThis.__probeResults))
`

console.log('=== 音源沙箱能力探测 ===\n')

if (!existsSync(HOST)) {
  console.log(`  FAIL  找不到宿主进程: ${HOST}`)
  console.log('  先运行: node tools/build-test.mjs')
  process.exit(1)
}

// The script is passed by file, matching how the engine hands it over.
const scratch = mkdtempSync(join(tmpdir(), 'jj-sandbox-'))
writeFileSync(join(scratch, 'script.js'), PROBE_SCRIPT, 'utf8')
writeFileSync(
  join(scratch, 'init.json'),
  JSON.stringify({
    env: 'desktop',
    version: '2.0.0',
    apiId: 'probe',
    scriptInfo: {
      name: '沙箱能力探测',
      description: '',
      version: '1.0.0',
      author: 'test',
      homepage: ''
    }
  }),
  'utf8'
)

const child = fork(HOST, [join(scratch, 'script.js'), join(scratch, 'init.json')], {
  stdio: ['ignore', 'pipe', 'pipe', 'ipc']
})

const ready = await new Promise((resolve) => {
  const timer = setTimeout(() => resolve({ timeout: true }), 20_000)
  child.on('message', (message) => {
    if (message.type === 'ready') {
      clearTimeout(timer)
      resolve({ sources: message.sources })
    } else if (message.type === 'boot-error') {
      clearTimeout(timer)
      resolve({ bootError: message.error })
    }
  })
  child.on('error', (error) => {
    clearTimeout(timer)
    resolve({ childError: error.message })
  })
  child.on('exit', (code) => {
    clearTimeout(timer)
    resolve({ exit: code })
  })
})

if (ready.timeout) {
  console.log('  FAIL  宿主进程未在 20s 内报告就绪')
  failed += 1
} else if (ready.bootError || ready.childError || ready.exit !== undefined) {
  console.log(
    `  FAIL  启动失败: ${ready.bootError ?? ready.childError ?? `退出码 ${ready.exit}`}`
  )
  failed += 1
} else {
  console.log(`宿主进程就绪，声明平台: ${Object.keys(ready.sources ?? {}).join(', ')}\n`)

  // Second round-trip: pull the probe results back through a real request.
  const probeRaw = await new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), 10_000)
    const onMessage = (message) => {
      if (message.type === 'response') {
        clearTimeout(timer)
        child.off('message', onMessage)
        resolve(message.data)
      } else if (message.type === 'response-error') {
        clearTimeout(timer)
        child.off('message', onMessage)
        resolve(null)
      }
    }
    child.on('message', onMessage)
    child.send({ type: 'request', id: 1, payload: { source: 'kw', action: 'musicUrl', info: {} } })
  })

  check('请求通道双向可用', probeRaw !== null, probeRaw === null ? '请求超时' : '')

  let probe = {}
  try {
    probe = probeRaw ? JSON.parse(probeRaw) : {}
  } catch {
    probe = {}
  }

  const labels = {
    eval: 'eval() 可用',
    fnCtor: 'new Function() 可用',
    fnGlobal: "Function('return this')() 可用",
    window: 'window 指向 globalThis 且暴露 lx',
    document: 'document 补齐存在',
    domOk: 'DOM 操作不抛错',
    btoa: 'btoa 可用',
    atob: 'atob 可用',
    storage: 'localStorage 可用',
    md5: 'lx.utils.crypto.md5 匹配已知向量',
    randBytes: 'lx.utils.crypto.randomBytes 返回字节',
    b64: 'lx.utils.buffer base64 往返正确',
    zlib: 'lx.utils.zlib 暴露 inflate/deflate',
    scriptInfo: 'lx.currentScriptInfo 已填充',
    version: 'lx.version/env 与 LX 一致',
    onRejects: 'lx.on 拒绝不支持的事件'
  }

  for (const [key, label] of Object.entries(labels)) {
    const value = probe[key]
    if (value === undefined) {
      console.log(`  SKIP  ${label}（探针未回传）`)
      continue
    }
    check(label, value === true, String(value))
  }
}

child.kill()
rmSync(scratch, { recursive: true, force: true })

console.log(`\nRESULT: ${passed} passed, ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
