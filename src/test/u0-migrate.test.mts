import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'

const script = resolve('build/u0-migrate.ps1')
const roots = []
after(async () => {
  for (const root of roots) {
    assert.equal(dirname(resolve(root)), resolve(tmpdir()))
    assert.ok(basename(root).startsWith('jj-u0-migrate-'))
    await rm(root, { recursive: true, force: true })
  }
})

async function fixture(withData = true) {
  const root = await mkdtemp(join(tmpdir(), 'jj-u0-migrate-'))
  roots.push(root)
  const install = join(root, 'install')
  const appdata = join(root, 'appdata')
  await mkdir(install, { recursive: true })
  await mkdir(appdata)
  if (withData) {
    await mkdir(join(install, 'data'))
    await writeFile(join(install, 'data', 'settings.json'), '{"theme":"dark"}\n')
  }
  return { root, install, appdata }
}

function run({ install, appdata }, mode = 'CurrentUser') {
  const result = spawnSync('powershell.exe', [
    '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script,
    '-InstallDir', install, '-InstallMode', mode, '-AppDataRoot', appdata
  ], { encoding: 'utf8', timeout: 30000 })
  if (result.error) throw result.error
  return result
}

test('installed-directory data is copied and verified outside the program folder', async () => {
  const f = await fixture()
  const first = run(f)
  assert.equal(first.status, 0, first.stdout + first.stderr)
  assert.equal(await readFile(join(f.appdata, 'jj-music', 'settings.json'), 'utf8'), '{"theme":"dark"}\n')
  assert.equal(await readFile(join(f.install, 'data', 'settings.json'), 'utf8'), '{"theme":"dark"}\n')
  const retry = run(f)
  assert.equal(retry.status, 0, retry.stdout + retry.stderr)
})

test('an existing different profile stops the install before old data is touched', async () => {
  const f = await fixture()
  await mkdir(join(f.appdata, 'jj-music'))
  await writeFile(join(f.appdata, 'jj-music', 'settings.json'), '{"theme":"light"}\n')
  assert.equal(run(f).status, 40)
  assert.equal(await readFile(join(f.install, 'data', 'settings.json'), 'utf8'), '{"theme":"dark"}\n')
  assert.equal(await readFile(join(f.appdata, 'jj-music', 'settings.json'), 'utf8'), '{"theme":"light"}\n')
})

test('an empty AppData profile directory can be replaced by verified legacy data', async () => {
  const f = await fixture()
  await mkdir(join(f.appdata, 'jj-music'))
  const result = run(f)
  assert.equal(result.status, 0, result.stdout + result.stderr)
  assert.equal(await readFile(join(f.appdata, 'jj-music', 'settings.json'), 'utf8'), '{"theme":"dark"}\n')
})

test('migration copies long nested Electron cache paths through a short staging directory', async () => {
  const f = await fixture()
  const relative = join('Code Cache', 'electron-preload', `${'a'.repeat(150)}.cache`)
  await mkdir(join(f.install, 'data', 'Code Cache', 'electron-preload'), { recursive: true })
  await writeFile(join(f.install, 'data', relative), 'cache sample')
  const result = run(f)
  assert.equal(result.status, 0, result.stdout + result.stderr)
  assert.equal(await readFile(join(f.appdata, 'jj-music', relative), 'utf8'), 'cache sample')
})

test('a relocated directory keeps its pointer and backs up stale install data', async () => {
  const f = await fixture()
  const external = join(f.root, 'external')
  await mkdir(external)
  await writeFile(join(external, 'library.json'), '{"tracks":1}\n')
  await writeFile(join(f.install, 'data-location.json'), JSON.stringify({ dir: external }))
  const result = run(f)
  assert.equal(result.status, 0, result.stdout + result.stderr)
  assert.equal(JSON.parse(await readFile(join(f.appdata, '.jj-music-data-location.json'), 'utf8')).dir, external)
  assert.equal(await readFile(join(f.appdata, 'jj-music-u0-legacy-backup', 'settings.json'), 'utf8'), '{"theme":"dark"}\n')
  assert.equal(await readFile(join(external, 'library.json'), 'utf8'), '{"tracks":1}\n')
})

test('per-machine legacy data fails closed because the current account cannot claim other profiles', async () => {
  const f = await fixture()
  assert.equal(run(f, 'all').status, 42)
  assert.equal(await readFile(join(f.install, 'data', 'settings.json'), 'utf8'), '{"theme":"dark"}\n')
})

test('per-machine install allows an empty legacy data directory with no profiles to claim', async () => {
  const f = await fixture(false)
  await mkdir(join(f.install, 'data'))
  const result = run(f, 'all')
  assert.equal(result.status, 0, result.stdout + result.stderr)
})

test('per-machine legacy pointer alone also fails closed before copying it into an account', async () => {
  const f = await fixture(false)
  const pointer = JSON.stringify({ dir: join(f.root, 'external') })
  await writeFile(join(f.install, 'data-location.json'), pointer)
  assert.equal(run(f, 'all').status, 42)
  assert.equal(await readFile(join(f.install, 'data-location.json'), 'utf8'), pointer)
})
