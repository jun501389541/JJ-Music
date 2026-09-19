/**
 * Build a distributable Windows app.
 *
 * Wraps `electron-vite build` + `electron-builder` and handles the two things
 * that otherwise make packaging fail on a machine behind a firewall:
 *
 *   1. **Mirrors.** electron-builder fetches its NSIS and winCodeSign tooling
 *      from GitHub releases via @electron/get, and Electron's own prebuilt
 *      binary likewise. Those reads happen inside a child process, so an
 *      `.npmrc` mirror setting is *not* visible to them — the variables must be
 *      in the environment. They are also read from several different names, so
 *      all of them are set. Override any of them by exporting the variable
 *      yourself before running this script.
 *
 *   2. **`ELECTRON_RUN_AS_NODE`.** If inherited, the Electron binary starts as
 *      plain Node and the app cannot launch. It is cleared for the child.
 *
 * Usage:
 *   node tools/package.mjs          # NSIS installer → release/JJ Music-<v>-x64.exe
 *   node tools/package.mjs --dir    # portable folder → release/win-unpacked/JJ Music.exe
 */
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const wantDirOnly = process.argv.includes('--dir')
const outputArg = process.argv.find(arg => arg.startsWith('--output='))
const releaseDir = resolve(repoRoot, outputArg?.slice('--output='.length) || 'release')

const ELECTRON_VITE = join(repoRoot, 'node_modules', 'electron-vite', 'bin', 'electron-vite.js')
const ELECTRON_BUILDER = join(
  repoRoot,
  'node_modules',
  'electron-builder',
  'out',
  'cli',
  'cli.js'
)

/** Mirrors that are reachable without a proxy. Exported vars win. */
const MIRRORS = {
  ELECTRON_MIRROR: 'https://npmmirror.com/mirrors/electron/',
  // Read by @electron/get when resolving Electron itself.
  npm_config_electron_mirror: 'https://npmmirror.com/mirrors/electron/',
  // Read by app-builder-lib for the NSIS / winCodeSign bundles. The release tag
  // is appended to this prefix, which is why it must end with a slash.
  ELECTRON_BUILDER_BINARIES_MIRROR:
    'https://registry.npmmirror.com/-/binary/electron-builder-binaries/',
  npm_config_electron_builder_binaries_mirror:
    'https://registry.npmmirror.com/-/binary/electron-builder-binaries/'
}

const env = { ...process.env }
for (const [key, value] of Object.entries(MIRRORS)) {
  // Respect an explicit override from the caller.
  if (!env[key]) env[key] = value
}
// A packaged app must run as Electron, never as Node.
delete env.ELECTRON_RUN_AS_NODE
delete env.VITE_E2E
// Keep electron-builder's tooling cache inside the workspace so it survives a
// clean checkout and does not need the global cache directory to be writable.
env.ELECTRON_BUILDER_CACHE ??= join(repoRoot, '.cache', 'electron-builder')

function run(label, args) {
  console.log(`\n>>> ${label}`)
  const result = spawnSync(process.execPath, args, {
    cwd: repoRoot,
    stdio: 'inherit',
    env
  })
  if (result.status !== 0) {
    console.error(`\n${label} failed (exit ${result.status})`)
    process.exit(result.status ?? 1)
  }
}

// 1. regenerate the icon if it is missing, so a fresh clone still packages
if (!existsSync(join(repoRoot, 'build', 'icon.ico'))) {
  run('generating icon', [join(repoRoot, 'tools', 'make-icon.mjs')])
}

// 2. compile main / preload / renderer
run('building app', [ELECTRON_VITE, 'build'])

// 3. package
run(
  wantDirOnly ? 'packaging portable folder' : 'packaging installer',
  [
    ELECTRON_BUILDER,
    '--win',
    ...(wantDirOnly ? ['--dir'] : []),
    '--config',
    'electron-builder.yml',
    `--config.directories.output=${releaseDir}`
  ]
)

// 4. report what was produced
console.log('\n' + '='.repeat(66))
console.log('OUTPUT')
console.log('='.repeat(66))

const report = (path, label) => {
  if (!existsSync(path)) return
  const isDir = statSync(path).isDirectory()
  const size = isDir ? '' : ` (${(statSync(path).size / 1024 / 1024).toFixed(1)} MB)`
  console.log(`  ${label}\n    ${path}${size}`)
}

report(join(releaseDir, 'win-unpacked', 'JJ Music.exe'), '免安装版（双击即用）')

if (existsSync(releaseDir)) {
  // Select by version, not by product-name prefix. The artifact names moved
  // from `JJ Music-` to `JJ-Music-` (GitHub turns spaces in release-asset
  // filenames into dots), and the old prefix test had been matching only the
  // leftover files from earlier releases -- so it reported filenames that were
  // never built by this run.
  const version = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')).version
  for (const name of readdirSync(releaseDir).sort()) {
    if (!name.includes(version)) continue
    if (name.endsWith('.exe')) report(join(releaseDir, name), '安装包')
    if (name.endsWith('.zip')) report(join(releaseDir, name), '免安装 ZIP（完整解压后运行）')
  }
}
