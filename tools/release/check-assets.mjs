/** Check the exact asset list passed to `gh release create --draft`. */
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { lstat, readFile } from 'node:fs/promises'
import { join } from 'node:path'

async function regularFile(path) {
  const info = await lstat(path)
  if (!info.isFile() || info.isSymbolicLink() || info.size === 0) {
    throw new Error(`Missing or empty regular release asset: ${path}`)
  }
  return info
}

async function sha256(file) {
  const digest = createHash('sha256')
  for await (const chunk of createReadStream(file)) digest.update(chunk)
  return digest.digest('hex')
}

async function main() {
  const [dir, version, ...extra] = process.argv.slice(2)
  if (!dir || !version || extra.length || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version)) {
    throw new Error('Usage: check-assets.mjs <release-dir> <X.Y.Z>')
  }
  const binaryNames = [
    `JJ-Music-${version}-Portable-x64.zip`,
    `JJ-Music-${version}-Setup-x64.exe`
  ]
  const names = [...binaryNames, 'SHA256SUMS.txt', 'latest.yml', 'update-manifest.json', 'update-manifest.sig']
  for (const name of names) await regularFile(join(dir, name))
  const lines = (await readFile(join(dir, 'SHA256SUMS.txt'), 'utf8')).trimEnd().split('\n')
  if (lines.length !== binaryNames.length) throw new Error('SHA256SUMS.txt must list exactly the two binaries')
  for (let i = 0; i < binaryNames.length; i++) {
    const actual = await sha256(join(dir, binaryNames[i]))
    if (lines[i].replace(/\r$/, '') !== `${actual}  ${binaryNames[i]}`) {
      throw new Error(`SHA256SUMS.txt does not match ${binaryNames[i]}`)
    }
  }
  console.log(`Release asset set verified for v${version}`)
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : 'Asset check failed')
  process.exitCode = 2
})
