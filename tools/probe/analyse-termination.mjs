/**
 * Characterise how the obfuscated source terminates its process.
 *
 * The trace stops at "evaluating" with no caught exception, no `process.exit`
 * call, and nothing on stderr. Node itself exits with code 1. That combination
 * rules out ordinary JS failure and points at a V8-level termination.
 *
 * This checks the specific mechanisms that can do that, and reports which
 * constructs the script actually contains.
 *
 * Usage: node tools/probe/analyse-termination.mjs
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const load = (rel) => import(pathToFileURL(join(repoRoot, 'out', 'test', rel)).href)
const { SourceStore } = await load('sources/source-store.js')

const scratch = mkdtempSync(join(tmpdir(), 'jj-analyse-'))
const store = new SourceStore(scratch)
store.load()
store.importLxFile(
  readFileSync(join(process.env.APPDATA ?? '', 'jj-music', 'sources', 'user_api.json'), 'utf8')
)
const api = store.list().find((a) => a.meta.name === '独家音源')

if (!api) {
  console.error('找不到「独家音源」')
  process.exit(1)
}

const script = api.source

console.log('='.repeat(72))
console.log('终止机制分析')
console.log('='.repeat(72))

/* ------------------------------------------------------------------ *
 * 1. Constructs that can kill a process from pure JS
 * ------------------------------------------------------------------ */

console.log('\n--- 可能导致进程级终止的结构 ---')

const PATTERNS = [
  ['WebAssembly', /WebAssembly/g, 'wasm 可触发不可捕获的 trap'],
  ['Atomics.wait', /Atomics\s*\.\s*wait/g, '可永久阻塞主线程'],
  ['SharedArrayBuffer', /SharedArrayBuffer/g, '配合 Atomics 使用'],
  ['process.exit', /process\s*\.\s*exit/g, '显式退出'],
  ['process.abort', /process\s*\.\s*abort/g, '强制 abort'],
  ['process.kill', /process\s*\.\s*kill/g, '发送信号'],
  ['process.binding', /process\s*\.\s*binding/g, '访问内部绑定'],
  ['% 语法 (V8 原生)', /%[A-Za-z]\w*\s*\(/g, 'V8 内部函数，可强制终止'],
  ['debugger', /(?<![.\w$])debugger\b/g, '断点指令'],
  ['Function 构造器', /new\s+Function|Function\s*\(/g, '动态代码'],
  ['eval', /(?<![.\w$])eval\s*\(/g, '动态代码'],
  ['while(true)', /while\s*\(\s*(?:true|1|!!\[\])\s*\)/g, '死循环'],
  ['for(;;)', /for\s*\(\s*;[^;]*;\s*\)/g, '死循环'],
  ['大数组分配', /new\s+(?:Uint8Array|Array)\s*\(\s*\d{6,}/g, '可能 OOM'],
  ['递归自调用', /arguments\s*\.\s*callee/g, '可造成栈溢出']
]

for (const [label, re, note] of PATTERNS) {
  const matches = script.match(re)
  if (matches && matches.length > 0) {
    console.log(`  ${label.padEnd(22)} ×${String(matches.length).padEnd(4)} ${note}`)
  }
}

/* ------------------------------------------------------------------ *
 * 2. What the script's very first statements touch
 * ------------------------------------------------------------------ */

console.log('\n--- 脚本开头（前 600 字符的非注释部分）---')
const body = script.replace(/^\/\*![\s\S]*?\*\//, '').trim()
console.log(body.slice(0, 600))

/* ------------------------------------------------------------------ *
 * 3. Does it survive a plain parse?
 * ------------------------------------------------------------------ */

console.log('\n--- 纯解析测试 ---')
try {
  // `new Function` parses without executing, which separates a syntax/runtime
  // rejection from a parse-time one.
  // eslint-disable-next-line no-new-func
  new Function(script)
  console.log('  ✓ 解析通过（问题发生在执行阶段）')
} catch (error) {
  console.log(`  ✗ 解析失败: ${error.name}: ${error.message}`)
}

/* ------------------------------------------------------------------ *
 * 4. Does merely referencing it in a fresh context kill us?
 * ------------------------------------------------------------------ */

console.log('\n--- 编译为 vm.Script（不执行）---')
const { Script } = await import('node:vm')
try {
  new Script(script, { filename: 'obfuscated.js' })
  console.log('  ✓ 编译通过')
} catch (error) {
  console.log(`  ✗ 编译失败: ${error.name}: ${error.message}`)
}

console.log(`\n${'='.repeat(72)}`)
console.log('说明')
console.log('='.repeat(72))
console.log(`
轨迹停在 "evaluating" 且没有捕获到任何异常，同时 stderr 为空、
退出码为 1 —— 这不是普通 JS 错误的表现。

普通抛错会打印堆栈；process.exit 会被我的包装记录；abort 会给出 134。
三者都不是。

最可能的解释：脚本带有反调试/自我保护逻辑，检测到运行环境与预期
不符（非浏览器、被沙箱包裹、缺乏某个全局），于是主动终止。
这类脚本在 LX Music 里能跑，是因为那里的宿主是真实的 BrowserWindow。

对我们的意义不变：**进程隔离是必需的**，因为它无论怎么死都只死自己。
`)

rmSync(scratch, { recursive: true, force: true })
