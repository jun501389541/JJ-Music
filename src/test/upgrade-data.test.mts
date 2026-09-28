import assert from 'node:assert/strict'
import { test, after } from 'node:test'
import { mkdtemp, mkdir, writeFile, readFile, cp, unlink, symlink, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, dirname, basename } from 'node:path'
import { spawnSync } from 'node:child_process'

const tool = resolve('tools/probe/upgrade-data.mjs')
const run = (...args) => {
  const result = spawnSync(process.execPath, [tool, ...args], { encoding: 'utf8' })
  if (result.error) throw result.error
  return result
}
const fixtureRoots = []
after(async () => {
  for (const root of fixtureRoots) {
    assert.equal(dirname(resolve(root)), resolve(tmpdir()))
    assert.ok(basename(root).startsWith('jj-upgrade-data-'))
    await rm(root, { recursive: true, force: true })
  }
})

// Real temporary profiles: comparing only names or sizes must not hide loss or
// a same-length replacement. No user's profile or installed application is read.
async function fixture() {
  const base = await mkdtemp(join(tmpdir(), 'jj-upgrade-data-'))
  fixtureRoots.push(base)
  const profile = join(base, 'profile')
  await mkdir(join(profile, 'sources'), { recursive: true })
  await writeFile(join(profile, 'settings.json'), 'abc')
  await writeFile(join(profile, 'sources', 'user_api.json'), '{}')
  return { base, profile, manifest: join(base, 'before.json') }
}

test('a copied profile has the same contents even at a different path', async () => {
  const f = await fixture()
  const snapshot = run('snapshot', f.profile, f.manifest)
  assert.equal(snapshot.status, 0, snapshot.stderr)
  const manifest = JSON.parse(await readFile(f.manifest, 'utf8'))
  assert.deepEqual(manifest.files, [
    { path: 'settings.json', size: 3, sha256: 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad' },
    { path: 'sources/user_api.json', size: 2, sha256: '44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a' }
  ])
  const migrated = join(f.base, 'migrated')
  await cp(f.profile, migrated, { recursive: true })
  const compared = run('compare', f.manifest, migrated)
  assert.equal(compared.status, 0, compared.stderr)
  assert.deepEqual(JSON.parse(compared.stdout), { ok: true, missing: [], changed: [], added: [] })
})

test('same-length replacement, missing source and unexpected file are reported separately', async () => {
  const f = await fixture()
  assert.equal(run('snapshot', f.profile, f.manifest).status, 0)
  await writeFile(join(f.profile, 'settings.json'), 'xyz')
  await unlink(join(f.profile, 'sources', 'user_api.json'))
  await writeFile(join(f.profile, 'new.json'), '{}')
  const compared = run('compare', f.manifest, f.profile)
  assert.equal(compared.status, 1, compared.stderr)
  assert.deepEqual(JSON.parse(compared.stdout), {
    ok: false, missing: ['sources/user_api.json'], changed: ['settings.json'], added: ['new.json']
  })
})

test('snapshots cannot overwrite the baseline or be created inside the profile', async () => {
  const f = await fixture()
  assert.equal(run('snapshot', f.profile, f.manifest).status, 0)
  const original = await readFile(f.manifest, 'utf8')
  assert.equal(run('snapshot', f.profile, f.manifest).status, 2)
  assert.equal(await readFile(f.manifest, 'utf8'), original)
  const inside = run('snapshot', f.profile, join(f.profile, 'baseline.json'))
  assert.equal(inside.status, 2)
  await assert.rejects(readFile(join(f.profile, 'baseline.json')), { code: 'ENOENT' })
})

test('empty or missing profiles cannot produce a passing baseline', async () => {
  const f = await fixture()
  const empty = join(f.base, 'empty')
  await mkdir(empty)
  for (const root of [empty, join(f.base, 'missing')]) {
    assert.equal(run('snapshot', root, f.manifest).status, 2)
  }
})

test('directory junctions are refused rather than following data outside the profile', async () => {
  const f = await fixture()
  const outside = join(f.base, 'outside')
  await mkdir(outside)
  await writeFile(join(outside, 'private.txt'), 'outside')
  await symlink(outside, join(f.profile, 'linked'), process.platform === 'win32' ? 'junction' : 'dir')
  const snapshot = run('snapshot', f.profile, f.manifest)
  assert.equal(snapshot.status, 2)
  assert.match(snapshot.stderr, /link|链接/i)
})

test('malformed, empty and duplicate manifest entries never pass verification', async () => {
  const f = await fixture()
  assert.equal(run('snapshot', f.profile, f.manifest).status, 0)
  const valid = JSON.parse(await readFile(f.manifest, 'utf8'))
  for (const bad of [
    { ...valid, schemaVersion: 99 },
    { ...valid, files: [] },
    { ...valid, files: [valid.files[0], valid.files[0]] },
    { ...valid, files: [{ ...valid.files[0], path: '../settings.json' }] },
    { ...valid, files: [{ ...valid.files[0], sha256: 'not-a-hash' }] }
  ]) {
    await writeFile(f.manifest, JSON.stringify(bad))
    const compared = run('compare', f.manifest, f.profile)
    assert.equal(compared.status, 2)
    assert.match(compared.stderr, /manifest|清单/i)
  }
})
