/**
 * Build and run every headless test suite.
 *
 * The suites import the *compiled* engine (see `tools/build-test.mjs`), so they
 * exercise the same code the app ships rather than a parallel implementation.
 *
 * Usage: node tools/run-tests.mjs [--online] [--music-dir ABSOLUTE_FOLDER]
 *        `--online` runs only the suites that reach the live lyric endpoints.
 */
import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createTestMusicFixture } from './test-music-fixture.mjs'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const outDir = join(repoRoot, 'out', 'test')
const srcTestDir = join(repoRoot, 'src', 'test')
const online = process.argv.includes('--online')
const musicFlag=process.argv.indexOf('--music-dir'),explicitMusic=musicFlag<0?undefined:process.argv[musicFlag+1]
if(musicFlag>=0&&(!explicitMusic||!isAbsolute(explicitMusic))){console.error('--music-dir requires an explicit absolute folder');process.exit(2)}
if(explicitMusic){try{if(!statSync(explicitMusic).isDirectory())throw Error('not a directory')}catch{console.error('--music-dir must name an existing directory');process.exit(2)}}
const musicFixture=explicitMusic?null:createTestMusicFixture()
const musicDirectory=explicitMusic??musicFixture.dir
if(musicFixture)process.once('exit',musicFixture.cleanup)
console.log(explicitMusic?'Music samples: explicit opt-in folder':'Music samples: owned generated offline fixture')
const RETIRED_SUITES = new Map([
  ['jj-provider-engine.test.mjs', 'JJ capability runtime routes were retired by E1; JJ-only review items R2–R6 remain deferred.']
])

function run(command, args, label) {
  process.stdout.write(`\n${'#'.repeat(72)}\n# ${label}\n${'#'.repeat(72)}\n`)
  const result = spawnSync(command, args, {
    cwd: repoRoot, stdio: 'inherit',
    env: { ...process.env, JJ_LIVE_TESTS: online ? '1' : '0', JJ_TEST_MUSIC_DIR: musicDirectory }
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
for (const [name, reason] of RETIRED_SUITES) {
  if (staged.includes(name)) console.log(`SKIP  ${name}: ${reason}`)
}
// Live endpoint checks are separate from the repeatable regression run.
const ONLINE_SUITES = ['lyrics-search.test.mjs', 'lyrics-tags.test.mjs']
const active = staged.filter((name) => !RETIRED_SUITES.has(name))
const suites = online ? active.filter((name) => ONLINE_SUITES.includes(name)) : active
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
