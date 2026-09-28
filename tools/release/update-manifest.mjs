/** Fixed, signed Windows x64 release contract. Requires Node 24. */
import { createHash, createPrivateKey, sign } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { lstat, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { checkLatestMetadata, parseAndVerifyManifest } from '../../src/main/updates/manifest.ts'

async function digest(file) {
  const before = await lstat(file)
  if (!before.isFile() || before.isSymbolicLink()) throw new Error('Setup is not a regular file')
  const sha256 = createHash('sha256')
  const sha512 = createHash('sha512')
  let size = 0
  for await (const chunk of createReadStream(file)) {
    size += chunk.length
    sha256.update(chunk)
    sha512.update(chunk)
  }
  const after = await lstat(file)
  if (size !== before.size || after.size !== before.size ||
      after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) {
    throw new Error('Setup changed while hashing')
  }
  return { size, sha256: sha256.digest('hex'), sha512: sha512.digest('base64') }
}

async function main() {
  const [mode, dir, version, ...extra] = process.argv.slice(2)
  if (!['create', 'verify'].includes(mode) || !dir || !version || extra.length ||
      !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version)) {
    throw new Error('Usage: update-manifest.mjs create|verify <release-dir> <X.Y.Z>')
  }
  const name = `JJ-Music-${version}-Setup-x64.exe`
  const setupFile = join(dir, name)
  const manifestFile = join(dir, 'update-manifest.json')
  const signatureFile = join(dir, 'update-manifest.sig')
  const latest = await readFile(join(dir, 'latest.yml'), 'utf8')
  const setup = { name, ...await digest(setupFile) }
  const publicKeyPem = process.env.JJ_UPDATE_PUBLIC_KEY_PEM
  if (!publicKeyPem) throw new Error('JJ_UPDATE_PUBLIC_KEY_PEM is required')

  if (mode === 'create') {
    const privateKeyPem = process.env.JJ_UPDATE_SIGNING_KEY_PEM
    if (!privateKeyPem) throw new Error('JJ_UPDATE_SIGNING_KEY_PEM is required')
    const manifest = { schemaVersion: 1, tag: `v${version}`, version, channel: 'stable', platform: 'win32', arch: 'x64', setup }
    checkLatestMetadata(latest, manifest)
    const bytes = Buffer.from(JSON.stringify(manifest, null, 2) + '\n')
    const signature = sign(null, bytes, createPrivateKey(privateKeyPem)).toString('base64')
    parseAndVerifyManifest(bytes, signature, publicKeyPem, '0.0.0')
    await writeFile(manifestFile, bytes, { flag: 'wx' })
    await writeFile(signatureFile, signature + '\n', { flag: 'wx' })
    console.log('Signed update-manifest.json and update-manifest.sig')
    return
  }

  const bytes = await readFile(manifestFile)
  const signature = (await readFile(signatureFile, 'utf8')).trim()
  const manifest = parseAndVerifyManifest(bytes, signature, publicKeyPem, '0.0.0')
  if (manifest.version !== version || manifest.setup.name !== name ||
      manifest.setup.size !== setup.size || manifest.setup.sha256 !== setup.sha256 ||
      manifest.setup.sha512 !== setup.sha512) throw new Error('Setup no longer matches the signed manifest')
  checkLatestMetadata(latest, manifest)
  console.log('Signed update asset set verified')
}

main().catch(error => {
  // Never print the signing key or the raw environment.
  console.error(error instanceof Error ? error.message : 'Release check failed')
  process.exitCode = 2
})
