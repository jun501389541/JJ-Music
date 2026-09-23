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
 * A full `dist` also writes `release/SHA256SUMS.txt` for the version in
 * `package.json`, and stops if that version produced no artifacts.
 *
 * Usage:
 *   node tools/package.mjs          # NSIS installer → release/JJ Music-<v>-x64.exe
 *   node tools/package.mjs --dir    # portable folder → release/win-unpacked/JJ Music.exe
 */
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
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

/*
 * Checksums, written here rather than by hand.
 *
 * The README links `SHA256SUMS.txt` as a release asset, and until now it was
 * assembled manually every time — so it could go stale silently, and a user
 * following the link would get hashes that matched nothing they downloaded.
 *
 * Selection is by version, exactly like the report below: `release/` keeps every
 * artifact ever built, and a sums file that listed the leftovers from 0.1.2
 * beside the new files would be worse than no file at all.
 */
if (!wantDirOnly) {
  const version = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')).version
  const assets = existsSync(releaseDir)
    ? readdirSync(releaseDir)
      // `-${version}-`, not `${version}`: `release/` accumulates every build ever
      // made, and a bare substring test lets `0.1.1` collect the leftovers from
      // `0.1.10` (measured: `'JJ-Music-0.1.10-Setup-x64.exe'.includes('0.1.1')`
      // is true). Both names below are `JJ-Music-<version>-<kind>-<arch>.<ext>`.
      .filter(name => name.includes(`-${version}-`) && (name.endsWith('.exe') || name.endsWith('.zip')))
      .sort()
    : []

  // A build that produced no installer is a failed build, and the sums file is
  // the last place that could notice before the release page is filled in.
  if (assets.length === 0) {
    console.error(
      `\nERROR: no ${version} installer or ZIP in ${releaseDir} — refusing to write SHA256SUMS.txt`
    )
    process.exit(1)
  }

  const lines = assets.map(name => {
    const digest = createHash('sha256').update(readFileSync(join(releaseDir, name))).digest('hex')
    console.log(`  ${name}  ${(statSync(join(releaseDir, name)).size / 1024 / 1024).toFixed(1)} MB`)
    return `${digest}  ${name}`
  })
  const sumsPath = join(releaseDir, 'SHA256SUMS.txt')
  writeFileSync(sumsPath, `${lines.join('\n')}\n`)
  console.log(`\n${'='.repeat(66)}`)
  console.log(`SHA256SUMS.txt（${assets.length} 个文件）→ ${sumsPath}`)
  console.log('校验：sha256sum -c SHA256SUMS.txt')
}

if (existsSync(releaseDir)) {
  // Select by version, not by product-name prefix. The artifact names moved
  // from `JJ Music-` to `JJ-Music-` (GitHub turns spaces in release-asset
  // filenames into dots), and the old prefix test had been matching only the
  // leftover files from earlier releases -- so it reported filenames that were
  // never built by this run.
  const version = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')).version
  for (const name of readdirSync(releaseDir).sort()) {
    // Same version boundary as the sums file above — see the note there.
    if (!name.includes(`-${version}-`)) continue
    if (name.endsWith('.exe')) report(join(releaseDir, name), '安装包')
    if (name.endsWith('.zip')) report(join(releaseDir, name), '免安装 ZIP（完整解压后运行）')
  }
}
