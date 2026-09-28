import assert from 'node:assert/strict'
import { generateKeyPairSync, sign, createHash } from 'node:crypto'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { UpdateService } from '../../out/test/updates/service.js'

const pair = generateKeyPairSync('ed25519')
const publicKey = pair.publicKey.export({ type: 'spki', format: 'pem' }).toString()
const name = 'JJ-Music-0.3.0-Setup-x64.exe'
const body = Buffer.from('installer contents')
const sha256 = createHash('sha256').update(body).digest('hex')
const sha512 = createHash('sha512').update(body).digest('base64')
const manifest = { schemaVersion: 1, tag: 'v0.3.0', version: '0.3.0', channel: 'stable', platform: 'win32', arch: 'x64', setup: { name, size: body.length, sha256, sha512 } }
const bytes = Buffer.from(JSON.stringify(manifest))
const signature = sign(null, bytes, pair.privateKey).toString('base64')
const latest = `version: 0.3.0\nfiles:\n  - url: ${name}\n    sha512: ${sha512}\n    size: ${body.length}\npath: ${name}\nsha512: ${sha512}\n`

function fixture(overrides = {}) {
  const calls = { check: 0, download: 0, install: 0, cancel: 0 }
  let downloadedPath = ''
  const updater = {
    checkForUpdates: async () => { calls.check++; return { version: '0.3.0', files: [{ url: name, sha512 }] } },
    downloadUpdate: async () => { calls.download++; return [downloadedPath] },
    quitAndInstall: () => { calls.install++ },
    onProgress: () => {},
    onDownloaded: () => {}
  }
  const service = new UpdateService({
    currentVersion: '0.2.0', publicKey, available: true,
    source: { load: async () => ({ bytes, signature, latest, tag: 'v0.3.0', assetName: name, assetSize: body.length, notes: 'Fixed release notes' }) },
    updater, token: () => ({ cancel() { calls.cancel++ } }),
    ...overrides
  })
  return { service, calls, setPath: path => { downloadedPath = path } }
}

test('closed gate never calls network or updater', async () => {
  const { service, calls } = fixture({ available: false })
  assert.equal(service.getState().phase, 'unavailable')
  await assert.rejects(service.check())
  await assert.rejects(service.download())
  await assert.rejects(service.install())
  assert.deepEqual(calls, { check: 0, download: 0, install: 0, cancel: 0 })
})

test('check only reports a signed update and never downloads automatically', async () => {
  const { service, calls } = fixture()
  assert.equal((await service.check()).phase, 'available')
  assert.equal(calls.check, 1)
  assert.equal(calls.download, 0)
  assert.equal(service.getState().releaseUrl, 'https://github.com/jun501389541/JJ-Music/releases/tag/v0.3.0')
})

test('updater metadata mismatch is rejected before download', async () => {
  const { service, calls } = fixture({ updater: { checkForUpdates: async () => ({ version: '0.4.0', files: [] }), downloadUpdate: async () => { calls.download++; return [] }, quitAndInstall: () => { calls.install++ }, onProgress: () => {}, onDownloaded: () => {} } })
  await assert.rejects(service.check())
  assert.equal(service.getState().phase, 'error')
  assert.equal(calls.download, 0)
})

test('downloaded file is hashed again before install', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'jj-update-test-'))
  try {
    const path = join(dir, name)
    await writeFile(path, body)
    const { service, calls, setPath } = fixture()
    setPath(path)
    await service.check()
    assert.equal((await service.download()).phase, 'ready')
    await writeFile(path, 'replaced')
    await assert.rejects(service.install())
    assert.equal(calls.install, 0)
    assert.equal(service.getState().phase, 'error')
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('download digest mismatch cannot reach ready or install', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'jj-update-test-'))
  try {
    const path = join(dir, name)
    await writeFile(path, 'wrong')
    const { service, calls, setPath } = fixture()
    setPath(path)
    await service.check()
    await assert.rejects(service.download())
    assert.equal(service.getState().phase, 'error')
    assert.equal(calls.install, 0)
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('cancel returns to available and permits a later explicit retry', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'jj-update-test-'))
  try {
    const path = join(dir, name)
    await writeFile(path, body)
    let complete
    let count = 0
    let canceled = 0
    const updater = {
      checkForUpdates: async () => ({ version: '0.3.0', files: [{ url: name, sha512 }] }),
      downloadUpdate: async () => { count++; return count === 1 ? new Promise(resolve => { complete = resolve }) : [path] },
      quitAndInstall: () => {}, onProgress: () => {}, onDownloaded: () => {}
    }
    const { service } = fixture({ updater, token: () => ({ cancel() { canceled++ } }) })
    await service.check()
    const first = service.download()
    assert.equal(service.getState().phase, 'downloading')
    service.cancel()
    assert.equal(canceled, 1)
    assert.equal(service.getState().phase, 'available')
    complete([path])
    await first
    assert.equal(service.getState().phase, 'available')
    assert.equal((await service.download()).phase, 'ready')
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('same signed release reports current without asking updater to download', async () => {
  const same = { ...manifest, version: '0.2.0', tag: 'v0.2.0', setup: { ...manifest.setup, name: 'JJ-Music-0.2.0-Setup-x64.exe' } }
  const sameBytes = Buffer.from(JSON.stringify(same))
  const sameSignature = sign(null, sameBytes, pair.privateKey).toString('base64')
  const sameLatest = `version: 0.2.0\nfiles:\n  - url: ${same.setup.name}\n    sha512: ${sha512}\n    size: ${body.length}\npath: ${same.setup.name}\nsha512: ${sha512}\n`
  const { service, calls } = fixture({ source: { load: async () => ({ bytes: sameBytes, signature: sameSignature, latest: sameLatest, tag: same.tag, assetName: same.setup.name, assetSize: body.length, notes: '' }) } })
  assert.equal((await service.check()).phase, 'current')
  assert.equal(calls.check, 0)
})
