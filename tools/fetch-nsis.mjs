/**
 * Fetch electron-builder's NSIS tooling through the local HTTP proxy.
 *
 * electron-builder downloads `nsis-3.0.4.1` and `nsis-resources-3.4.1` from
 * GitHub releases into its cache directory. On this machine GitHub is only
 * reachable through the local proxy at 127.0.0.1:7890, and electron-builder's
 * own downloader does not honour HTTPS_PROXY, so the installer target fails
 * with ECONNREFUSED 127.0.0.1:443.
 *
 * This pre-populates the cache so `electron-builder --win` (NSIS target) works
 * offline afterwards. The unpacked `--dir` target does not need any of this.
 *
 * Usage: node tools/fetch-nsis.mjs
 */
import { createReadStream, createWriteStream, existsSync, mkdirSync, renameSync, rmSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const cacheDir = join(repoRoot, '.cache', 'electron-builder')
const PROXY = process.env.JJ_PROXY ?? 'http://127.0.0.1:7890'

/** Artifacts electron-builder expects, in the layout it expects. */
const ARTIFACTS = [
  {
    name: 'nsis-3.0.4.1',
    url: 'https://github.com/electron-userland/electron-builder-binaries/releases/download/nsis-3.0.4.1/nsis-3.0.4.1.7z',
    sha256: '9877df902530f96357d13a7a31ae2b9df67f48b11ffc9a1700a7c961574ec5fa'
  },
  {
    name: 'nsis-resources-3.4.1',
    url: 'https://github.com/electron-userland/electron-builder-binaries/releases/download/nsis-resources-3.4.1/nsis-resources-3.4.1.7z',
    sha256: '593a9a92ef958321293ac6a2ee61e64bf1bd543142a5bd6b3d310709cc924103'
  },
  {
    // Required even without a code-signing certificate: the NSIS target uses
    // tools from this bundle while assembling the installer. Missing it makes
    // the build fail *after* packaging, with a bare network error.
    name: 'winCodeSign-2.6.0',
    url: 'https://github.com/electron-userland/electron-builder-binaries/releases/download/winCodeSign-2.6.0/winCodeSign-2.6.0.7z',
    sha256: 'cdaec7154dda7cc31f88d886e2489379a0625a737d610b5ae7f62a12f16743a4'
  }
]

/**
 * Fetch a URL through the proxy using undici's ProxyAgent.
 * Node's global fetch does not read HTTPS_PROXY on its own.
 */async function fetchViaProxy(url) {
  let ProxyAgent
  try {
    ;({ ProxyAgent } = await import('undici'))
  } catch {
    // Node bundles undici; this import should always succeed.
    console.error('undici is unavailable; cannot use the proxy')
    process.exit(1)
  }
  const response = await fetch(url, { dispatcher: new ProxyAgent(PROXY), redirect: 'follow' })
  if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`)
  return response
}

/** SHA-256 of a file, computed by streaming so large archives stay off-heap. */
function sha256Of(path) {
  return new Promise((resolveHash, reject) => {
    const hash = createHash('sha256')
    const stream = createReadStream(path)
    stream.on('error', reject)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('end', () => resolveHash(hash.digest('hex')))
  })
}

console.log(`proxy: ${PROXY}`)
console.log(`cache: ${cacheDir}\n`)

let failures = 0

for (const artifact of ARTIFACTS) {
  const target = join(cacheDir, `${artifact.name}.7z`)

  if (existsSync(target)) {
    // A downloaded-but-corrupt archive is worse than a missing one: the build
    // fails later with an unrelated error. Verify what is already there.
    const actual = await sha256Of(target)
    if (actual === artifact.sha256) {
      console.log(`already cached and verified: ${artifact.name}`)
      continue
    }
    console.log(`cached copy of ${artifact.name} is corrupt; re-downloading`)
    rmSync(target, { force: true })
  }

  process.stdout.write(`downloading ${artifact.name} … `)
  try {
    const response = await fetchViaProxy(artifact.url)
    mkdirSync(dirname(target), { recursive: true })
    const partial = `${target}.part`
    await pipeline(Readable.fromWeb(response.body), createWriteStream(partial))

    const actual = await sha256Of(partial)
    if (actual !== artifact.sha256) {
      throw new Error(`checksum mismatch (got ${actual.slice(0, 16)}…)`)
    }

    // Rename only once the whole file has landed and verified, so a dropped
    // connection cannot leave a truncated archive that looks cached.
    renameSync(partial, target)
    console.log('ok (checksum verified)')
  } catch (error) {
    console.log(`FAILED: ${error.message}`)
    rmSync(`${target}.part`, { force: true })
    failures += 1
  }
}

if (failures > 0) {
  console.log(
    `\n${failures} artifact(s) could not be fetched.` +
      `\nThe proxy at ${PROXY} must be running, and GitHub must be reachable through it.` +
      `\n\nNote: this only affects the NSIS installer target.` +
      `\nUse \`npm run pack\` to produce a portable release/win-unpacked/JJ Music.exe instead.`
  )
  process.exit(1)
}

console.log(
  '\nNSIS tooling cached. electron-builder still needs to extract it, which it does on first run.' +
    '\nNote: extraction requires 7-Zip support inside electron-builder; if it still fails,' +
    '\nuse `npm run pack` for the portable build.'
)
