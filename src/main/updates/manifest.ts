import { createPublicKey, verify } from 'node:crypto'
import { parse as parseYaml } from 'yaml'

export interface VerifiedManifest {
  schemaVersion: 1
  tag: string
  version: string
  channel: 'stable'
  platform: 'win32'
  arch: 'x64'
  setup: { name: string; size: number; sha256: string; sha512: string }
}

function object(value: unknown, keys: string[], label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`)
  }
  const record = value as Record<string, unknown>
  if (Object.keys(record).sort().join('\0') !== [...keys].sort().join('\0')) {
    throw new Error(`${label} has missing or unexpected fields`)
  }
  return record
}

function versionParts(value: unknown): number[] {
  if (typeof value !== 'string' || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value)) {
    throw new Error('Expected a stable X.Y.Z version')
  }
  const parts = value.split('.').map(Number)
  if (parts.some(part => !Number.isSafeInteger(part))) throw new Error('Version number is too large')
  return parts
}

function isNewer(next: number[], current: number[]): boolean {
  for (let i = 0; i < 3; i++) {
    if (next[i] !== current[i]) return next[i] > current[i]
  }
  return false
}

export function parseAndVerifyManifest(
  bytes: Buffer | Uint8Array,
  signatureBase64: string,
  publicKeyPem: string,
  currentVersion: string,
  allowEqual = false
): VerifiedManifest {
  if (bytes.length > 16_384 || bytes.length === 0) throw new Error('Update manifest length is invalid')
  if (typeof signatureBase64 !== 'string' || !/^[A-Za-z0-9+/]{86}==$/.test(signatureBase64)) {
    throw new Error('Update manifest signature is invalid')
  }
  const signature = Buffer.from(signatureBase64, 'base64')
  if (signature.length !== 64 || signature.toString('base64') !== signatureBase64 ||
      !verify(null, Buffer.from(bytes), createPublicKey(publicKeyPem), signature)) {
    throw new Error('Update manifest signature is invalid')
  }

  const root = object(JSON.parse(Buffer.from(bytes).toString('utf8')), [
    'schemaVersion', 'tag', 'version', 'channel', 'platform', 'arch', 'setup'
  ], 'Update manifest')
  if (root.schemaVersion !== 1 || root.channel !== 'stable' || root.platform !== 'win32' || root.arch !== 'x64') {
    throw new Error('Unsupported update manifest target')
  }
  const next = versionParts(root.version)
  if (!isNewer(next, versionParts(currentVersion)) && !(allowEqual && root.version === currentVersion)) {
    throw new Error('Update must be newer than this app')
  }
  if (root.tag !== `v${root.version}`) throw new Error('Release tag does not match version')
  const setup = object(root.setup, ['name', 'size', 'sha256', 'sha512'], 'Setup asset')
  if (setup.name !== `JJ-Music-${root.version}-Setup-x64.exe` ||
      typeof setup.size !== 'number' || !Number.isSafeInteger(setup.size) || setup.size <= 0 ||
      typeof setup.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(setup.sha256) ||
      typeof setup.sha512 !== 'string' || Buffer.from(setup.sha512, 'base64').length !== 64 ||
      Buffer.from(setup.sha512, 'base64').toString('base64') !== setup.sha512) {
    throw new Error('Setup asset does not match the stable Windows x64 contract')
  }
  return root as unknown as VerifiedManifest
}

/** electron-updater consumes latest.yml; it is accepted only as transfer metadata. */
export function checkLatestMetadata(latestYaml: string, manifest: VerifiedManifest): void {
  if (latestYaml.length > 32_768) throw new Error('latest.yml is too large')
  const latest = parseYaml(latestYaml, { uniqueKeys: true }) as unknown
  if (latest === null || typeof latest !== 'object' || Array.isArray(latest)) {
    throw new Error('Invalid latest.yml')
  }
  const meta = latest as Record<string, unknown>
  if (meta.version !== manifest.version || meta.path !== manifest.setup.name ||
      meta.sha512 !== manifest.setup.sha512 || !Array.isArray(meta.files) || meta.files.length !== 1) {
    throw new Error('latest.yml does not match the signed manifest')
  }
  const file = meta.files[0] as Record<string, unknown> | null
  if (!file || typeof file !== 'object' || Array.isArray(file) ||
      file.url !== manifest.setup.name || file.sha512 !== manifest.setup.sha512 ||
      file.size !== manifest.setup.size) {
    throw new Error('latest.yml asset does not match the signed manifest')
  }
}
