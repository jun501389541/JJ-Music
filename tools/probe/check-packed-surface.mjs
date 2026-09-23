/**
 * The shipped binary's debug surface, measured rather than assumed.
 *
 * Three fixes in this round are only real if they hold in a *packaged* build,
 * because that is the binary a user downloads:
 *
 *   - `JJ_DEBUG_PORT` must be ignored on its own. An inherited environment
 *     variable must not open a CDP port in a build the user never configured.
 *   - `--remote-debugging-port` on argv must be ignored too. Chromium parses
 *     that switch before any app code runs, so gating the environment variable
 *     is not enough: `app.commandLine.removeSwitch` is the only thing that
 *     takes it back, and it has to happen before `app.ready`.
 *   - `--inspect` must not open a Node inspector. The
 *     `enableNodeCliInspectArguments` fuse is what closes that one.
 *
 * The last scenario is the control, and it is not optional. It launches the
 * same exe with `JJ_ALLOW_DEBUG_PORT=1` and requires CDP to **answer**. Without
 * it every "no CDP" result above is vacuous: a build that never starts also
 * never answers on that port, and that exact confusion already made
 * `tools/probe/probe-hook.mjs` print `ERROR: the test hook is reachable in the
 * production build` when the truth was just that the electron binary was
 * missing.
 *
 * Usage:
 *   node tools/probe/check-packed-surface.mjs
 *   node tools/probe/check-packed-surface.mjs --app=release/win-unpacked
 *   node tools/probe/check-packed-surface.mjs --wait=15000
 *
 * Exit codes: 0 = every scenario as expected, 1 = at least one mismatch,
 * 2 = nothing was judged (no packaged exe, or the control never came up).
 */
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const arg = (name, fallback) =>
  process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback

const appDir = resolve(repoRoot, arg('app', join('release', 'win-unpacked')))
const exeName = process.platform === 'win32' ? 'JJ Music.exe' : 'JJ Music'
const exe = join(appDir, exeName)
const waitMs = Number(arg('wait', '10000'))

if (!existsSync(exe)) {
  console.error(`packaged app not found: ${exe}`)
  console.error('run `npm run pack` first — this probe measures the shipped binary, not out/.')
  process.exit(2)
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/**
 * Ask the OS for a port rather than hard-coding one.
 *
 * A fixed number once failed with `bind() … (0x271D)` because the previous
 * run's endpoint had not let go of it, which reads as "the app never started"
 * — a lie. `tools/probe/probe-hook.mjs` and `tools/e2e-verify.mjs` both ask
 * this way; this probe should not disagree with them about it.
 */
function freePort() {
  return new Promise((res, rej) => {
    const server = createServer()
    server.unref()
    server.on('error', rej)
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      server.close(() => res(port))
    })
  })
}

/**
 * Does anything answer on this port within the window?
 *
 * One function for both polarities: a positive check returns as soon as it
 * answers, a negative one keeps asking until the window closes. Both Chromium's
 * DevTools endpoint and Node's inspector serve `/json/version`, so the same
 * question works for the `--inspect` scenario.
 */
async function answersOn(port, ms) {
  const deadline = Date.now() + ms
  for (;;) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/version`, {
        signal: AbortSignal.timeout(1500)
      })
      if (res.ok) return true
    } catch {
      /* not up yet — or gone for good */
    }
    if (Date.now() >= deadline) return false
    await sleep(250)
  }
}

/**
 * Kill the whole process tree.
 *
 * `child.kill()` leaves Electron's renderer and GPU children behind on
 * Windows, and a stray process still holding the profile is what makes the
 * *next* scenario flaky. `taskkill /T` takes the tree.
 */
function killTree(child) {
  if (child.exitCode !== null) return
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
  } else {
    child.kill('SIGKILL')
  }
}

const scenarios = [
  {
    label: 'JJ_DEBUG_PORT alone',
    args: () => [],
    env: (port) => ({ JJ_DEBUG_PORT: String(port) }),
    expectAnswer: false,
    why: 'an inherited env var must not open CDP in a build the user did not configure'
  },
  {
    label: '--remote-debugging-port on argv',
    args: (port) => [`--remote-debugging-port=${port}`],
    env: () => ({}),
    expectAnswer: false,
    why: 'Chromium parses this before app code, so the switch must be removed'
  },
  {
    label: '--inspect on argv',
    args: (port) => [`--inspect=${port}`],
    env: () => ({}),
    expectAnswer: false,
    why: 'the enableNodeCliInspectArguments fuse must be disabled'
  },
  {
    label: 'control: JJ_DEBUG_PORT + JJ_ALLOW_DEBUG_PORT=1',
    args: () => [],
    env: (port) => ({ JJ_DEBUG_PORT: String(port), JJ_ALLOW_DEBUG_PORT: '1' }),
    expectAnswer: true,
    why: 'proves CDP is detectable here at all; without it the negatives prove nothing'
  }
]

async function run(scenario) {
  const port = await freePort()
  const profile = mkdtempSync(join(tmpdir(), 'jj-surface-'))
  const child = spawn(exe, [...scenario.args(port), `--user-data-dir=${profile}`], {
    cwd: repoRoot,
    stdio: 'ignore',
    env: {
      ...process.env,
      // A probe testing what the shipped binary does must not itself arrive
      // inside a Node runtime instead of the app.
      ELECTRON_RUN_AS_NODE: undefined,
      ...scenario.env(port)
    }
  })

  const answered = await answersOn(port, waitMs)
  const aliveWhenDone = child.exitCode === null
  killTree(child)
  rmSync(profile, { recursive: true, force: true })

  return { ...scenario, port, answered, aliveWhenDone }
}

const results = []
for (const scenario of scenarios) {
  process.stdout.write(`… ${scenario.label}\n`)
  results.push(await run(scenario))
  // Let the port be released before the next scenario asks for one.
  await sleep(600)
}

const control = results[results.length - 1]
const negatives = results.slice(0, -1)

console.log(`\napp: ${exe}`)
console.log(`window per scenario: ${waitMs} ms\n`)
for (const r of results) {
  const ok = r.answered === r.expectAnswer
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${r.label}`)
  console.log(`        port ${r.port}: ${r.answered ? 'answered' : 'silent'} (expected ${r.expectAnswer ? 'answered' : 'silent'})`)
  console.log(`        process still running when the window closed: ${r.aliveWhenDone ? 'yes' : 'no'}`)
  console.log(`        ${r.why}`)
}

if (!control.answered) {
  console.error(
    '\n无法判断：control 场景也没等到 CDP。这说明这次测量区分不出「按设计关掉了」和「根本没启动」。'
  )
  console.error('先确认 release/win-unpacked 是本次 npm run pack 的产物，再重跑。')
  process.exit(2)
}

const failed = negatives.filter((r) => r.answered !== r.expectAnswer || !r.aliveWhenDone)
if (failed.length) {
  console.error(`\n${failed.length} 个场景与预期不符。`)
  process.exit(1)
}
console.log('\n所有场景符合预期：成品 exe 的调试面是关的，而 control 证明这个测量看得见它。')
process.exit(0)
