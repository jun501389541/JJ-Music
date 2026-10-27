/** Native Electron crossfade acceptance using generated loopback WAV files only. */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { withDisposableProfile } from './isolated-profile.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const output = join(root, '.cache', 'crossfade-lifecycle')
const electronDist = process.env.JJ_CROSSFADE_ELECTRON_DIST ?? join(root, 'node_modules', 'electron', 'dist')
const electronExecutable = join(electronDist, process.platform === 'win32' ? 'electron.exe' : 'electron')
await mkdir(output, { recursive: true })

function run(command, args, options = {}) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(command, args, { cwd: root, windowsHide: true, stdio: 'inherit', ...options })
    let timedOut = false
    const timer = setTimeout(() => { timedOut = true; child.kill() }, 150_000)
    child.once('error', error => { clearTimeout(timer); reject(error) })
    child.once('close', (code, signal) => {
      clearTimeout(timer)
      if (timedOut) reject(new Error('Native crossfade probe exceeded 150 seconds'))
      else code === 0 ? resolveRun() : reject(new Error(`Probe exited ${code ?? signal}`))
    })
  })
}

const reportPath = join(output, 'native-acceptance.json')
const runId = `${Date.now()}-${process.pid}`
let profilePath
await writeFile(reportPath, JSON.stringify({ runId, status: 'starting', startedAt: new Date().toISOString() }, null, 2) + '\n')
try {
  // Always rebuild the probe bundle from the current production player sources.
  await run(process.execPath, [join(root, 'tools', 'build-test.mjs')])
  if (!existsSync(electronExecutable)) throw new Error(`Electron executable is missing: ${electronExecutable}`)
  await withDisposableProfile(output, async profile => {
    profilePath = profile
    await run(
      electronExecutable,
      [join(root, 'tools', 'probe', 'crossfade-lifecycle-main.cjs')],
      {
        env: {
          ...process.env,
          ELECTRON_RUN_AS_NODE: undefined,
          NODE_OPTIONS: undefined,
          JJ_CROSSFADE_PROFILE: profile,
          JJ_CROSSFADE_OUTPUT: reportPath,
          JJ_CROSSFADE_RUN_ID: runId
        }
      }
    )
  })
  const evidence = JSON.parse(await readFile(reportPath, 'utf8'))
  await writeFile(reportPath, JSON.stringify({ ...evidence, disposableProfileRemoved: !existsSync(profilePath) }, null, 2) + '\n')
  if (existsSync(profilePath)) throw new Error('Disposable Electron profile was not removed')
} catch (error) {
  let evidence = {}
  try { evidence = JSON.parse(await readFile(reportPath, 'utf8')) } catch { /* the launcher creates the file first */ }
  await writeFile(reportPath, JSON.stringify({
    ...evidence,
    runId,
    status: 'failed',
    disposableProfileRemoved: profilePath ? !existsSync(profilePath) : null,
    launcherError: error instanceof Error ? error.message : String(error)
  }, null, 2) + '\n')
  throw error
}
