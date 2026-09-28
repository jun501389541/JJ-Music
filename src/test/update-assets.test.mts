import assert from 'node:assert/strict'
import { test, after } from 'node:test'
import { createHash } from 'node:crypto'
import { mkdtemp, writeFile, unlink, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, dirname, basename } from 'node:path'
import { spawnSync } from 'node:child_process'

const checker = resolve('tools/release/check-assets.mjs')
const roots = []
after(async () => { for (const root of roots) { assert.equal(dirname(resolve(root)), resolve(tmpdir())); assert.ok(basename(root).startsWith('jj-assets-')); await rm(root, { recursive: true, force: true }) } })

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'jj-assets-'))
  roots.push(dir)
  const assets = [
    ['JJ-Music-0.3.0-Portable-x64.zip', 'zip'],
    ['JJ-Music-0.3.0-Setup-x64.exe', 'setup']
  ]
  for (const [name, body] of assets) await writeFile(join(dir, name), body)
  const sums = assets.map(([name, body]) => `${createHash('sha256').update(body).digest('hex')}  ${name}`).join('\n') + '\n'
  await writeFile(join(dir, 'SHA256SUMS.txt'), sums)
  for (const name of ['latest.yml', 'update-manifest.json', 'update-manifest.sig']) await writeFile(join(dir, name), 'sample')
  return dir
}

function run(dir) {
  const result = spawnSync(process.execPath, [checker, dir, '0.3.0'], { encoding: 'utf8' })
  if (result.error) throw result.error
  return result
}

test('only a complete installer, zip and checksum asset set passes', async () => {
  const dir = await fixture()
  assert.equal(run(dir).status, 0)
  await unlink(join(dir, 'latest.yml'))
  assert.equal(run(dir).status, 2)
})

test('changed ZIP or wrong checksum list fails', async () => {
  const dir = await fixture()
  await writeFile(join(dir, 'JJ-Music-0.3.0-Portable-x64.zip'), 'changed')
  assert.equal(run(dir).status, 2)
  const replacement = await fixture()
  await writeFile(join(replacement, 'SHA256SUMS.txt'), '')
  assert.equal(run(replacement).status, 2)
})
