/**
 * Run the end-to-end verification, then restore a clean production build.
 *
 * The E2E harness needs a build carrying the dev-only test hook, but that build
 * must never be what sits in `out/`. This wrapper therefore:
 *
 *   1. builds with VITE_E2E=1,
 *   2. runs the verifier against that build,
 *   3. rebuilds **without** VITE_E2E, so the app on disk is the shipping one,
 *   4. proves the hook is unreachable in that final build, and
 *   5. reports the verifier's result.
 *
 * Step 4 launches the built app and asks the renderer, rather than grepping the
 * bundle. A text search is not valid here: Vite compiles
 * `import.meta.env['VITE_E2E']` into a *runtime* property access on an inlined
 * env object, so the guarded assignment remains in the bundle as a dead branch
 * and the identifier always appears regardless of whether it can execute.
 *
 * Usage: node tools/run-e2e.mjs
 */
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const electronVite = join(repoRoot, 'node_modules', 'electron-vite', 'bin', 'electron-vite.js')

function build(env, label) {
  process.stdout.write(`\n>>> building (${label})\n`)
  const result = spawnSync(process.execPath, [electronVite, 'build'], {
    cwd: repoRoot,
    stdio: 'inherit',
    // `undefined` values are omitted from the child environment by Node, which
    // is what makes the clean build genuinely clean.
    env: { ...process.env, ...env }
  })
  if (result.status !== 0) {
    console.error(`build failed (${label})`)
    process.exit(1)
  }
}

/** Cheap pre-check: is the guarded assignment emitted at all? */
function hookEmitted() {
  const assets = join(repoRoot, 'out', 'renderer', 'assets')
  if (!existsSync(assets)) return false
  return readdirSync(assets)
    .filter((name) => name.endsWith('.js'))
    .some((name) => readFileSync(join(assets, name), 'utf8').includes('__jj_player'))
}

/**
 * Authoritative check: launch the built app and inspect `window`.
 * Returns true when the hook is reachable (i.e. the build is instrumented).
 */
function hookReachable() {
  const probe = spawnSync(process.execPath, [join(repoRoot, 'tools', 'probe', 'probe-hook.mjs')], {
    cwd: repoRoot,
    stdio: 'inherit'
  })
  // probe-hook exits 1 when the hook is reachable, 0 when it is absent.
  return probe.status === 1
}

// 1. instrumented build
build({ VITE_E2E: '1' }, 'with E2E hook')

if (!hookEmitted()) {
  console.error('the E2E hook was not emitted; the verifier cannot drive the app')
  process.exit(1)
}
console.log('E2E hook emitted in the instrumented build')

// 2. run the verifier against the instrumented build
const verify = spawnSync(process.execPath, [join(repoRoot, 'tools', 'e2e-verify.mjs')], {
  cwd: repoRoot,
  stdio: 'inherit'
})
const verifyStatus = verify.status ?? 1

// 3. always restore a clean build, even if verification failed
build({ VITE_E2E: undefined }, 'clean production')

// 4. prove the hook is unreachable in the shipping build
console.log('\n>>> confirming the production build has no reachable test hook')
const leaked = hookReachable()
if (leaked) {
  console.error('\nERROR: the test hook is reachable in the production build')
  process.exit(1)
}
console.log('confirmed: test hook unreachable in the production build')

process.exit(verifyStatus === 0 ? 0 : 1)
