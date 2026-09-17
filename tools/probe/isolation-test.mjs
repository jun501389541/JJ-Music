/**
 * Verify that each installed 音源 is properly isolated from the app.
 *
 * This is the regression test for the bug where importing a source made the app
 * unstartable: a self-defending obfuscated script terminated its own process,
 * and because sources ran on a worker *thread* — which shares the host process
 * — it took the whole app down with it. Sources now run in forked child
 * processes, and this proves the isolation actually holds.
 *
 * The key assertion is not just "does the bad source fail" but "does the parent
 * survive it", which a worker thread could not guarantee.
 *
 * Usage: node tools/probe/isolation-test.mjs
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { deflateSync } from 'node:zlib'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const load = (rel) => import(pathToFileURL(join(repoRoot, 'out', 'test', rel)).href)

const { SourceStore } = await load('sources/source-store.js')
const { SourceEngine } = await load('sources/source-engine.js')

const hostPath = join(repoRoot, 'out', 'test', 'source-host.cjs')
const sourcesPath = join(process.env.APPDATA ?? '', 'jj-music', 'sources', 'user_api.json')

if (!existsSync(hostPath)) {
  console.error('source-host.cjs missing - run: node tools/build-test.mjs')
  process.exit(1)
}

console.log('='.repeat(72))
console.log('音源隔离测试')
console.log('='.repeat(72))

/** Run a set of sources through the real engine and report each outcome. */
async function runSuite(label, filePath) {
  console.log(`\n### ${label}`)
  console.log(`文件: ${filePath}`)

  if (!existsSync(filePath)) {
    console.log('  跳过：文件不存在')
    return { total: 0, ok: 0, failed: 0 }
  }

  const scratch = mkdtempSync(join(tmpdir(), 'jj-iso-'))
  const store = new SourceStore(scratch)
  store.load()

  const imported = store.importLxFile(readFileSync(filePath, 'utf8'))
  console.log(`导入 ${imported.length} 个音源`)

  const engine = new SourceEngine(store, hostPath)
  const errors = new Map()
  engine.on({
    scriptError: (id, error) => {
      if (!errors.has(id)) errors.set(id, error)
    }
  })

  const started = Date.now()
  // The engine must never reject here, however badly a script behaves.
  let threw = false
  try {
    await engine.startAll()
  } catch {
    threw = true
  }
  const elapsed = Date.now() - started

  const live = engine.getSources()
  console.log(`\n启动完成，用时 ${elapsed} ms${threw ? '（startAll 抛异常，不符合预期）' : ''}`)
  console.log(`存活平台: ${live.map((s) => s.id).join(', ') || '(无)'}`)

  const metas = store.metas()
  console.log('\n逐个音源:')

  // A script that reported `ready` is alive; `lastError` is only set when init
  // actually failed, so it is the reliable signal rather than the error map
  // (which also collects non-fatal `scriptError` events).
  let alive = 0
  let dead = 0
  for (const meta of metas) {
    const failure = meta.lastError ?? errors.get(meta.id)
    const isAlive = !meta.lastError
    if (isAlive) alive += 1
    else dead += 1

    if (isAlive) {
      console.log(`  ✓ ${meta.name}`)
    } else {
      console.log(`  ✗ ${meta.name}`)
      console.log(`      ${String(failure).slice(0, 260)}`)
    }
  }

  await engine.stopAll()
  rmSync(scratch, { recursive: true, force: true })

  return { total: metas.length, ok: alive, failed: dead }
}

/* ------------------------------------------------------------------ *
 * 1. The real installed sources — the ones that caused the bug
 * ------------------------------------------------------------------ */

const real = await runSuite('用户实际安装的音源', sourcesPath)

/* ------------------------------------------------------------------ *
 * 2. A deliberately destructive source, to prove the boundary itself
 * ------------------------------------------------------------------ */

const suicidePath = join(repoRoot, '.cache', 'suicide-source.json')
{
  const script = `/*!
 * @name 破坏性测试音源
 * @description deliberately terminates its own process
 * @version 1.0.0
 * @author test
 */
const { EVENT_NAMES, on, send } = globalThis.lx
// A self-defending obfuscated source can do this; the sandbox must contain it.
process.abort()
`
  mkdirSync(dirname(suicidePath), { recursive: true })
  writeFileSync(
    suicidePath,
    JSON.stringify({
      userApis: [
        {
          id: 'suicide_test',
          name: '破坏性测试音源',
          description: '',
          version: '1.0.0',
          author: 'test',
          homepage: '',
          allowShowUpdateAlert: false,
          script: `gz_${deflateSync(Buffer.from(script)).toString('base64')}`,
          enabled: true
        }
      ]
    }),
    'utf8'
  )
}

const destructive = await runSuite('破坏性音源（会自杀）', suicidePath)

/* ------------------------------------------------------------------ *
 * Verdict
 * ------------------------------------------------------------------ */

console.log(`\n${'='.repeat(72)}`)
console.log('结论')
console.log('='.repeat(72))
console.log(`
本进程仍然存活 —— 这本身就是隔离生效的证据（worker 线程做不到这一点）。

用户安装的音源:  ${real.ok}/${real.total} 正常启动，${real.failed} 失败并被隔离
破坏性音源:      ${destructive.failed > 0 ? '已被隔离' : '未按预期失败'}
`)

if (destructive.total > 0 && destructive.failed === 0) {
  console.log('注意：破坏性音源竟然启动成功，说明隔离没有生效。')
  process.exit(1)
}

console.log('隔离验证通过。')
