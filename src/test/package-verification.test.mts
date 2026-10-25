import assert from 'node:assert/strict'
import { test, after } from 'node:test'
import { mkdtemp, mkdir, writeFile, readdir, rm, utimes } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, dirname, basename } from 'node:path'
import { spawnSync } from 'node:child_process'
import { createPackage } from '@electron/asar'

const tool = resolve('tools/probe/verify-package.mjs')
const roots = []
after(async () => {
  for (const root of roots) {
    assert.equal(dirname(root), resolve(tmpdir()))
    assert.ok(basename(root).startsWith('jj-package-check-'))
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
})

async function fixture({ version = '0.5.0', markerMissing = false, dependencyMissing = false, brokenMetadata = false } = {}) {
  const root = await mkdtemp(join(resolve(tmpdir()), 'jj-package-check-'))
  roots.push(root)
  const source = join(root, 'input'), resources = join(root, 'app', 'resources'), scratch = join(root, 'scratch')
  for (const dir of [join(source, 'out', 'main'), join(source, 'out', 'preload'), join(source, 'out', 'renderer'), resources, scratch]) await mkdir(dir, { recursive: true })
  await writeFile(join(source, 'package.json'), brokenMetadata ? '{broken' : JSON.stringify({ name: 'jj-music', version }))
  await writeFile(join(source, 'out', 'main', 'index.js'), 'readEmbeddedLyric resolveLocalLyric fetchOnlineLyric matchMetadata buildVorbisComment isStale --jj-desktop-lyric')
  await writeFile(join(source, 'out', 'preload', 'index.js'), '// fixture preload')
  await writeFile(join(source, 'out', 'renderer', 'index.js'), 'toIpcPayload 在线匹配 写入预览 打时间戳 ' + (markerMissing ? '' : '逐行'))
  const asar = join(resources, 'app.asar')
  await createPackage(source, asar)
  await utimes(asar, new Date('2000-01-01T00:00:00Z'), new Date('2000-01-01T00:00:00Z'))
  for (const name of ['out/main/source-host.js', 'node_modules/iconv-lite/package.json', 'node_modules/safer-buffer/package.json']) {
    if (dependencyMissing && name === 'out/main/source-host.js') continue
    const file = join(resources, 'app.asar.unpacked', name)
    await mkdir(dirname(file), { recursive: true })
    await writeFile(file, '{}')
  }
  return { root, asar, scratch }
}
function run(f, args) {
  const result = spawnSync(process.execPath, [tool, ...args], {
    cwd: resolve('.'), encoding: 'utf8', timeout: 30000,
    env: { ...process.env, TEMP: f.scratch, TMP: f.scratch }
  })
  assert.ifError(result.error)
  return { ...result, output: result.stdout + result.stderr }
}
async function clean(f) { assert.deepEqual(await readdir(f.scratch), [], 'probe must remove its own extraction directory on success and failure') }

test('artifact content mode accepts a correct old-timestamp archive without asserting checkout freshness', async () => {
  const f = await fixture(), r = run(f, [f.asar, '--artifact-version=0.5.0'])
  assert.equal(r.status, 0, r.output)
  assert.match(r.output, /artifact content/i)
  assert.match(r.output, /0\.5\.0/)
  assert.doesNotMatch(r.output, /STALE PACKAGE|newer than all sources/)
  await clean(f)
})
test('default local mode still rejects an old package and cleans extraction on failure', async () => {
  const f = await fixture(), r = run(f, [f.asar])
  assert.equal(r.status, 1, r.output)
  assert.match(r.output, /STALE PACKAGE/)
  await clean(f)
})
test('default local mode accepts a newer package and cleans extraction on success', async () => {
  const f = await fixture(), newer = new Date(Date.now() + 60000)
  await utimes(f.asar, newer, newer)
  const r = run(f, [f.asar])
  assert.equal(r.status, 0, r.output)
  assert.match(r.output, /newer than all sources/)
  await clean(f)
})
test('artifact mode refuses a wrong package version', async () => {
  const f = await fixture({ version: '0.4.6' }), r = run(f, [f.asar, '--artifact-version=0.5.0'])
  assert.equal(r.status, 1, r.output)
  assert.match(r.output, /package version mismatch/i)
  await clean(f)
})
test('artifact mode still refuses a missing feature marker', async () => {
  const f = await fixture({ markerMissing: true }), r = run(f, [f.asar, '--artifact-version=0.5.0'])
  assert.equal(r.status, 1, r.output)
  assert.match(r.output, /MISS.*歌词可用徽章/)
  await clean(f)
})
test('artifact mode still refuses missing unpacked source dependencies', async () => {
  const f = await fixture({ dependencyMissing: true }), r = run(f, [f.asar, '--artifact-version=0.5.0'])
  assert.equal(r.status, 1, r.output)
  assert.match(r.output, /MISS.*source-host/)
  await clean(f)
})
test('artifact mode refuses malformed package metadata and cleans extraction', async () => {
  const f = await fixture({ brokenMetadata: true }), r = run(f, [f.asar, '--artifact-version=0.5.0'])
  assert.equal(r.status, 1, r.output)
  assert.match(r.output, /invalid package metadata/i)
  await clean(f)
})
test('artifact mode requires an explicit archive, one valid stable version and no unknown arguments', async () => {
  const f = await fixture()
  for (const args of [
    ['--artifact-version=0.5.0'], [f.asar, '--artifact-version=bad'],
    [f.asar, '--artifact-version=01.5.0'], [f.asar, '--artifact-version=0.5.0', '--artifact-version=0.5.0'],
    [f.asar, '--skip-stale'], [f.asar, f.asar]
  ]) assert.equal(run(f, args).status, 2, JSON.stringify(args))
  await clean(f)
})