/**
 * Build and run every headless test suite.
 *
 * The suites import the *compiled* engine (see `tools/build-test.mjs`), so they
 * exercise the same code the app ships rather than a parallel implementation.
 *
 * Usage: node tools/run-tests.mjs [--online]
 *        `--online` runs only the suites that reach the live lyric endpoints.
 */
import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const outDir = join(repoRoot, 'out', 'test')
const srcTestDir = join(repoRoot, 'src', 'test')
const online = process.argv.includes('--online')

function run(command, args, label) {
  process.stdout.write(`\n${'#'.repeat(72)}\n# ${label}\n${'#'.repeat(72)}\n`)
  const result = spawnSync(command, args, {
    cwd: repoRoot, stdio: 'inherit',
    env: { ...process.env, JJ_LIVE_TESTS: online ? '1' : '0' }
  })
  return result.status === 0
}

/** Compile the engine + worker into out/test. */
function buildEngine() {
  const result = spawnSync(process.execPath, [join(repoRoot, 'tools', 'build-test.mjs')], {
    cwd: repoRoot,
    stdio: 'inherit'
  })
  if (result.status !== 0) {
    console.error('engine bundle failed')
    process.exit(1)
  }
}

/** Copy the .mts suites next to the bundle as .mjs so Node can run them. */
function stageSuites() {
  mkdirSync(outDir, { recursive: true })
  const suites = readdirSync(srcTestDir).filter((name) => name.endsWith('.test.mts'))
  for (const name of suites) {
    copyFileSync(join(srcTestDir, name), join(outDir, name.replace(/\.mts$/, '.mjs')))
  }
  return suites.map((name) => name.replace(/\.mts$/, '.mjs'))
}

// Start from a clean output tree so a renamed module cannot linger and be
// imported by mistake.
if (existsSync(outDir)) rmSync(outDir, { recursive: true, force: true })

console.log('building engine bundle…')
buildEngine()

const staged = stageSuites()
// Live endpoint checks are separate from the repeatable regression run.
const ONLINE_SUITES = ['lyrics-search.test.mjs', 'lyrics-tags.test.mjs']
const suites = online ? staged.filter((name) => ONLINE_SUITES.includes(name)) : staged
// An empty run is a green run by the arithmetic below, which is the one outcome
// a gate must never produce: rename a live suite and `--online` would report
// success having executed nothing.
const missing = online ? ONLINE_SUITES.filter((name) => !suites.includes(name)) : []
if (missing.length || suites.length === 0) {
  console.error(
    `没有可跑的套件不等于通过。选中 ${suites.length} 个` +
      (missing.length ? `，--online 预期却没有 ${missing.join(', ')}` : '')
  )
  process.exit(1)
}
console.log(`staged ${suites.length} suite(s): ${suites.join(', ')}`)

const results = []
for (const suite of suites) {
  const ok = run(process.execPath, [join(outDir, suite)], suite)
  results.push({ suite, ok })
}

console.log(`\n${'='.repeat(72)}`)
console.log('SUMMARY')
console.log('='.repeat(72))
for (const { suite, ok } of results) {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${suite}`)
}

const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} suites passed`)
process.exit(failed.length === 0 ? 0 : 1)
