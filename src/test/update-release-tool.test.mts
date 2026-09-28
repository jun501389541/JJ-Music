import assert from 'node:assert/strict'
import { test, after } from 'node:test'
import { generateKeyPairSync, createHash } from 'node:crypto'
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, dirname, basename } from 'node:path'
import { spawnSync } from 'node:child_process'

const tool = resolve('tools/release/update-manifest.mjs')
const { privateKey, publicKey } = generateKeyPairSync('ed25519')
const privatePem = privateKey.export({ format: 'pem', type: 'pkcs8' }).toString()
const publicPem = publicKey.export({ format: 'pem', type: 'spki' }).toString()
const roots = []
after(async () => { for (const root of roots) { assert.equal(dirname(resolve(root)), resolve(tmpdir())); assert.ok(basename(root).startsWith('jj-release-')); await rm(root, { recursive: true, force: true }) } })

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'jj-release-'))
  roots.push(root)
  const dir = join(root, 'release')
  await mkdir(dir)
  const setup = Buffer.from('abc')
  const sha512 = createHash('sha512').update(setup).digest('base64')
  const name = 'JJ-Music-0.3.0-Setup-x64.exe'
  await writeFile(join(dir, name), setup)
  await writeFile(join(dir, 'latest.yml'), `version: 0.3.0\nfiles:\n  - url: ${name}\n    sha512: ${sha512}\n    size: 3\npath: ${name}\nsha512: ${sha512}\n`)
  return { dir, name }
}

const run = (mode, dir, env = {}) => {
  const result = spawnSync(process.execPath, [tool, mode, dir, '0.3.0'], {
    encoding: 'utf8', env: { ...process.env, JJ_UPDATE_SIGNING_KEY_PEM: privatePem, JJ_UPDATE_PUBLIC_KEY_PEM: publicPem, ...env }
  })
  if (result.error) throw result.error
  return result
}

test('create and verify a fixed signed release asset set', async () => {
  const { dir } = await fixture()
  const created = run('create', dir)
  assert.equal(created.status, 0, created.stderr)
  assert.doesNotMatch(created.stdout + created.stderr, /BEGIN PRIVATE KEY/)
  const manifest = JSON.parse(await readFile(join(dir, 'update-manifest.json'), 'utf8'))
  assert.equal(manifest.setup.sha256, createHash('sha256').update('abc').digest('hex'))
  assert.equal(run('verify', dir).status, 0)
  await writeFile(join(dir, 'JJ-Music-0.3.0-Setup-x64.exe'), 'xyz')
  assert.equal(run('verify', dir).status, 2, 'same-size replacement must fail')
})

test('no secret and inconsistent latest.yml refuse signing', async () => {
  const { dir } = await fixture()
  assert.equal(run('create', dir, { JJ_UPDATE_SIGNING_KEY_PEM: '' }).status, 2)
  assert.equal(await readFile(join(dir, 'latest.yml'), 'utf8') !== '', true)
  await writeFile(join(dir, 'latest.yml'), 'version: 0.4.0\nfiles: []\n')
  assert.equal(run('create', dir).status, 2)
})
