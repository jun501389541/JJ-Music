/**
 * U0 evidence helper. Run with the app CLOSED, before upgrading and again before
 * the first new-version launch. Reads every regular file, never migrates data.
 *
 * node tools/probe/upgrade-data.mjs snapshot <profile-dir> <new-manifest.json>
 * node tools/probe/upgrade-data.mjs compare <manifest.json> <profile-dir>
 * Exit: 0 identical/snapshot saved, 1 differences, 2 invalid input or I/O error.
 */
import { createHash } from 'node:crypto'
import { lstat, open, readdir, readFile, realpath, writeFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

async function fingerprint(file) {
  const handle = await open(file, 'r')
  try {
    const before = await handle.stat()
    if (!before.isFile()) throw new Error(`Not a regular file: ${file}`)
    const hash = createHash('sha256')
    let bytes = 0
    for await (const chunk of handle.createReadStream({ autoClose: false })) {
      hash.update(chunk)
      bytes += chunk.length
    }
    const after = await handle.stat()
    if (bytes !== before.size || before.size !== after.size ||
        before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) {
      throw new Error(`File changed while reading; close the app first: ${file}`)
    }
    return { size: bytes, sha256: hash.digest('hex') }
  } finally {
    await handle.close()
  }
}

async function scan(root) {
  const files = []
  async function visit(path, parts) {
    const info = await lstat(path)
    if (info.isSymbolicLink()) throw new Error(`Refusing symbolic link/junction: ${path}`)
    if (info.isDirectory()) {
      const names = (await readdir(path)).sort()
      for (const name of names) await visit(join(path, name), [...parts, name])
    } else if (info.isFile() && parts.length) {
      files.push({ path: parts.join('/'), ...await fingerprint(path) })
    } else {
      throw new Error(`Expected a profile directory containing regular files: ${path}`)
    }
  }
  await visit(root, [])
  return files.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0)
}

function validateManifest(manifest) {
  const invalid = () => { throw new Error('Invalid manifest: expected a nonempty schemaVersion 1 file inventory') }
  if (manifest?.schemaVersion !== 1 || !Array.isArray(manifest.files) || !manifest.files.length) invalid()
  const seen = new Set()
  for (const file of manifest.files) {
    if (!file || typeof file.path !== 'string' || /[\\:\x00-\x1f]/.test(file.path) ||
        file.path.split('/').some(part => !part || part === '.' || part === '..') ||
        !Number.isSafeInteger(file.size) || file.size < 0 ||
        typeof file.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(file.sha256)) invalid()
    const key = process.platform === 'win32' ? file.path.toLowerCase() : file.path
    if (seen.has(key)) invalid()
    seen.add(key)
  }
  return manifest.files
}

async function main() {
  const [command, first, second, ...extra] = process.argv.slice(2)
  if (!['snapshot', 'compare'].includes(command) || !first || !second || extra.length) {
    throw new Error('Usage: upgrade-data.mjs snapshot <profile-dir> <new-manifest.json> | compare <manifest.json> <profile-dir>')
  }
  if (command === 'snapshot') {
    const root = await realpath(first)
    const destination = join(await realpath(dirname(resolve(second))), basename(second))
    const inside = relative(root, destination)
    if (!inside || (!isAbsolute(inside) && inside !== '..' && !inside.startsWith(`..${sep}`))) {
      throw new Error('Snapshot manifest must be outside the profile directory')
    }
    // Use the supplied path so a root junction is refused too.
    const files = await scan(resolve(first))
    if (!files.length) throw new Error('Empty profile: refusing to record a passing baseline')
    await writeFile(destination, JSON.stringify({ schemaVersion: 1, files }, null, 2) + '\n', { flag: 'wx' })
    console.log(JSON.stringify({ files: files.length, manifest: destination }))
    return
  }
  let baseline
  try {
    baseline = validateManifest(JSON.parse(await readFile(first, 'utf8')))
  } catch (error) {
    throw new Error(`Cannot read manifest: ${error.message}`)
  }
  const actual = await scan(resolve(second))
  const current = new Map(actual.map(file => [file.path, file]))
  const expected = new Set(baseline.map(file => file.path))
  const missing = []
  const changed = []
  for (const file of baseline) {
    const found = current.get(file.path)
    if (!found) missing.push(file.path)
    else if (found.size !== file.size || found.sha256 !== file.sha256) changed.push(file.path)
  }
  const added = actual.filter(file => !expected.has(file.path)).map(file => file.path)
  const ok = !missing.length && !changed.length && !added.length
  console.log(JSON.stringify({ ok, missing: missing.sort(), changed: changed.sort(), added: added.sort() }))
  if (!ok) process.exitCode = 1
}

main().catch(error => {
  console.error(error.message)
  process.exitCode = 2
})
