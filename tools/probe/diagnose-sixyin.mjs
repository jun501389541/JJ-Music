/**
 * Find out why the bundled 鍏煶 sub-source throws
 * `TypeError: _0x5a1ace is not a function`.
 *
 * That error comes from obfuscated code inside the aggregator, and it is the
 * one failure in the diagnosis that is NOT obviously a dead relay. If our
 * sandbox is missing something the obfuscator relies on, that is our bug and it
 * would affect every obfuscated source.
 *
 * The approach: run the real script, capture the stack of the thrown error, and
 * check whether the obfuscator's own helpers (its string-array decoder, its
 * `Function`-based reconstruction) are intact.
 *
 * Usage: node tools/probe/diagnose-sixyin.mjs
 */
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const load = (rel) => import(pathToFileURL(join(repoRoot, 'out', 'test', rel)).href)
const { SourceStore } = await load('sources/source-store.js')
const { SourceEngine } = await load('sources/source-engine.js')

const sample = join(repoRoot, 'docs', 'research', 'samples', 'user_api_0.decoded.js')
if (!existsSync(sample)) {
  console.log('sample script not present; skipping')
  process.exit(0)
}

/* ------------------------------------------------------------------ *
 * 1. What does the obfuscator need?
 * ------------------------------------------------------------------ */

console.log('='.repeat(72))
console.log('1. 娣锋穯浠ｇ爜依赖鐨勭幆澧冭兘鍔?)
console.log('='.repeat(72))

const source = readFileSync(sample, 'utf8')

// The 鍏煶 payload is the first BUNDLED entry. Pull it out so we can run it
// standalone and get a clean stack trace.
const sixyinMatch = /"SixYin":\s*\{\s*rawScript:\s*"((?:[^"\\]|\\.)*)"/.exec(source)
let sixyin = null
if (sixyinMatch) {
  sixyin = JSON.parse(`"${sixyinMatch[1]}"`)
  console.log(`  閹绘劕褰囬崗顓㈢叾鐎涙劘鍓奸張? ${sixyin.length} 鐎涙顑乣)
} else {
  console.log('  鏈兘提取鍏煶瀛愯剼鏈紙鑱氬悎鍣ㄧ粨鏋勫彲鑳藉凡鍙橈級')
}

const PATTERNS = [
  ['Function 构造器', /\bnew Function\b|\bFunction\s*\(/g],
  ['eval', /(?<![.\w$])eval\s*\(/g],
  ['window', /(?<![.\w$])window\b/g],
  ['document', /(?<![.\w$])document\b/g],
  ['atob', /(?<![.\w$])atob\b/g],
  ['btoa', /(?<![.\w$])btoa\b/g],
  ['crypto', /(?<![.\w$])crypto\b/g],
  ['TextDecoder', /(?<![.\w$])TextDecoder\b/g],
  ['Uint8Array', /(?<![.\w$])Uint8Array\b/g],
  ['Buffer', /(?<![.\w$])Buffer\b/g],
  ['JSON', /(?<![.\w$])JSON\b/g],
  ['String.fromCharCode', /String\.fromCharCode/g],
  ['charCodeAt', /\.charCodeAt\b/g]
]

const target = sixyin ?? source
for (const [label, re] of PATTERNS) {
  const count = (target.match(re) ?? []).length
  if (count > 0) console.log(`  ${label.padEnd(22)} ${count}`)
}

/* ------------------------------------------------------------------ *
 * 2. Run the real aggregator and capture the full failure
 * ------------------------------------------------------------------ */

console.log(`\n${'='.repeat(72)}`)
console.log('2. 实际运行锛屾崟鑾峰畬鏁撮敊璇?)
console.log('='.repeat(72))

const tmp = mkdtempSync(join(tmpdir(), 'jj-sixyin-'))
const store = new SourceStore(tmp)
store.load()
const imported = store.import(source, 'codex')
const engine = new SourceEngine(store, join(repoRoot, 'out', 'test', 'source-host.cjs'))

try {
  await engine.startAll()
  console.log(`  骞冲彴: ${engine.getSources().map((s) => s.id).join(', ')}`)

  const track = {
    id: 'kw_474678847',
    name: '鑺辨捣',
    singer: '閸涖劍婢冩导?,
    source: 'kw',
    meta: { songmid: '474678847', qualitys: [{ type: '128k' }] }
  }

  try {
    const result = await engine.getMusicUrl('kw', track, '128k')
    console.log(`  鉁?鎴愬姛: ${result.url.slice(0, 100)}`)
  } catch (error) {
    console.log(`  鉁?澶辫触: ${error.message.slice(0, 400)}`)
  }

  // The script's own logs are the aggregator explaining itself.
  const logs = engine.getLogs(imported.id)
  console.log(`\n  鑴氭湰鏃ュ織 (${logs.length} 鏉?:`)
  for (const line of logs.slice(-25)) console.log(`    ${line.slice(0, 220)}`)
} finally {
  await engine.stopAll()
  rmSync(tmp, { recursive: true, force: true })
}

/* ------------------------------------------------------------------ *
 * 3. Are the relays actually reachable?
 * ------------------------------------------------------------------ */

console.log(`\n${'='.repeat(72)}`)
console.log('3. 閼辨艾鎮庨崳銊ュ敶閸氬嫬鎮楃粩顖滄畱 API 娑撶粯婧€閸欘垵鎻幀?)
console.log('='.repeat(72))

// Hosts referenced by the bundled backends.
const HOSTS = [
  'https://lxmusicapi.onrender.com',
  'https://api.ikunshare.com',
  'https://music.3e0.cn',
  'https://api.xinghai.com'
]

for (const url of HOSTS) {
  const started = Date.now()
  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 8000)
    const response = await fetch(url, { signal: controller.signal })
    clearTimeout(timer)
    console.log(`  ${response.status}  ${url}  (${Date.now() - started} ms)`)
  } catch (error) {
    const code = error.cause?.code ?? error.name
    console.log(`  ERR  ${url}  ${code}: ${error.message}  (${Date.now() - started} ms)`)
  }
}
