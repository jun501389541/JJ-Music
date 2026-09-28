/** Sign and verify a local dist with a throwaway key. Never publish this signature. */
import { generateKeyPairSync } from 'node:crypto'
import { existsSync } from 'node:fs'
import { unlink } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { spawnSync } from 'node:child_process'

const dir = resolve(process.argv[2] ?? 'release')
const version = process.argv[3]
if (!version || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version)) {
  throw new Error('Usage: smoke-update-release.mjs <release-dir> <X.Y.Z>')
}
const generated = ['update-manifest.json', 'update-manifest.sig'].map(name => join(dir, name))
if (generated.some(existsSync)) throw new Error('Refusing to replace an existing signed manifest')
const { privateKey, publicKey } = generateKeyPairSync('ed25519')
const env = {
  ...process.env,
  JJ_UPDATE_SIGNING_KEY_PEM: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
  JJ_UPDATE_PUBLIC_KEY_PEM: publicKey.export({ type: 'spki', format: 'pem' }).toString()
}
function run(args) {
  const result = spawnSync(process.execPath, args, { stdio: 'inherit', env })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`Release smoke check failed with exit ${result.status}`)
}
try {
  run(['tools/release/update-manifest.mjs', 'create', dir, version])
  run(['tools/release/update-manifest.mjs', 'verify', dir, version])
  run(['tools/release/check-assets.mjs', dir, version])
  console.log('Real dist passed ephemeral-key release checks; signature is not for publication')
} finally {
  for (const file of generated) if (existsSync(file)) await unlink(file)
}
