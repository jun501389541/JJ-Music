import assert from 'node:assert/strict'
import { generateKeyPairSync, sign } from 'node:crypto'
import { test } from 'node:test'
import { checkLatestMetadata, parseAndVerifyManifest } from './updates/manifest.js'

const { privateKey, publicKey } = generateKeyPairSync('ed25519')
const publicPem = publicKey.export({ format: 'pem', type: 'spki' }).toString()
const valid = {
  schemaVersion: 1,
  tag: 'v0.3.0', version: '0.3.0', channel: 'stable', platform: 'win32', arch: 'x64',
  setup: { name: 'JJ-Music-0.3.0-Setup-x64.exe', size: 3,
    sha256: 'a'.repeat(64), sha512: Buffer.alloc(64, 7).toString('base64') }
}
const signed = value => {
  const bytes = Buffer.from(JSON.stringify(value))
  return [bytes, sign(null, bytes, privateKey).toString('base64')]
}
const verify = value => parseAndVerifyManifest(...signed(value), publicPem, '0.2.0')

test('valid signed stable x64 setup for a newer version is accepted', () => {
  assert.deepEqual(verify(valid), valid)
})

test('signature is checked on exact bytes before parsing release fields', () => {
  const [bytes, signature] = signed(valid)
  const tampered = Buffer.from(bytes.toString().replace('0.3.0', '0.4.0'))
  assert.throws(() => parseAndVerifyManifest(tampered, signature, publicPem, '0.2.0'), /signature/i)
  assert.throws(() => parseAndVerifyManifest(bytes, 'bad!', publicPem, '0.2.0'), /signature/i)
})

test('tag, version ordering, channel, architecture and asset shape are strict', () => {
  const invalid = [
    { ...valid, tag: 'v0.4.0' },
    { ...valid, version: '0.2.0', tag: 'v0.2.0', setup: { ...valid.setup, name: 'JJ-Music-0.2.0-Setup-x64.exe' } },
    { ...valid, version: '0.3.0-beta.1', tag: 'v0.3.0-beta.1' },
    { ...valid, channel: 'beta' },
    { ...valid, arch: 'arm64' },
    { ...valid, platform: 'linux' },
    { ...valid, setup: { ...valid.setup, name: '../other.exe' } },
    { ...valid, setup: { ...valid.setup, sha256: '123' } },
    { ...valid, setup: { ...valid.setup, size: 0 } },
    { ...valid, url: 'https://attacker.example/setup.exe' }
  ]
  for (const value of invalid) assert.throws(() => verify(value), undefined, JSON.stringify(value))
})

const latest = `version: 0.3.0\nfiles:\n  - url: JJ-Music-0.3.0-Setup-x64.exe\n    sha512: ${valid.setup.sha512}\n    size: 3\npath: JJ-Music-0.3.0-Setup-x64.exe\nsha512: ${valid.setup.sha512}\nreleaseDate: '2026-09-26T00:00:00.000Z'\n`

test('latest.yml must identify exactly the signed setup, size and SHA-512', () => {
  assert.doesNotThrow(() => checkLatestMetadata(latest, valid))
  for (const bad of [
    latest.replace('version: 0.3.0', 'version: 0.4.0'),
    latest.replace('size: 3', 'size: 4'),
    latest.replace('Setup-x64.exe', 'Portable-x64.zip'),
    latest.replace(valid.setup.sha512, Buffer.alloc(64, 9).toString('base64')),
    latest.replace('files:', 'files:\n  - url: second.exe\n    sha512: bad\n    size: 1\n'),
    latest.replace('JJ-Music-0.3.0-Setup-x64.exe', 'https://attacker.example/a.exe')
  ]) assert.throws(() => checkLatestMetadata(bad, valid))
})
