import assert from 'node:assert/strict'
import { test, after } from 'node:test'
import { mkdtemp, mkdir, writeFile, readdir, rm, utimes } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, dirname, basename } from 'node:path'
import { spawnSync } from 'node:child_process'
import { createPackage } from '@electron/asar'
import { createHash } from 'node:crypto'

const tool = resolve('tools/probe/verify-package.mjs')
const roots = []
after(async () => {
  for (const root of roots) {
    assert.equal(dirname(root), resolve(tmpdir()))
    assert.ok(basename(root).startsWith('jj-package-check-'))
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
})

async function fixture({ version = '0.5.0', markerMissing = false, dependencyMissing = false, brokenMetadata = false, native = false, helper = false, tampered = false } = {}) {
  const root = await mkdtemp(join(resolve(tmpdir()), 'jj-package-check-'))
  roots.push(root)
  const source = join(root, 'input'), resources = join(root, 'app', 'resources'), scratch = join(root, 'scratch')
  for (const dir of [join(source, 'out', 'main'), join(source, 'out', 'preload'), join(source, 'out', 'renderer'), resources, scratch]) await mkdir(dir, { recursive: true })
  await writeFile(join(source, 'package.json'), brokenMetadata ? '{broken' : JSON.stringify({ name: 'jj-music', version }))
  await writeFile(join(source, 'out', 'main', 'index.js'), 'readEmbeddedLyric resolveLocalLyric fetchOnlineLyric matchMetadata buildVorbisComment isStale --jj-desktop-lyric' + (native?' source-launcher.exe':''))
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
  if(helper){
    const bytes=Buffer.alloc(256);bytes.write('MZ');bytes.writeUInt32LE(64,60);bytes.write('PE\0\0',64);bytes.writeUInt16LE(0x8664,68);bytes.writeUInt16LE(0x20b,88);bytes.writeUInt16LE(2,156)
    await mkdir(join(resources,'native'),{recursive:true})
    await writeFile(join(resources,'native/source-launcher.exe'),bytes)
    await writeFile(join(resources,'native/manifest.json'),JSON.stringify({schema:1,protocol:1,arch:'x64',sha256:tampered?'0'.repeat(64):createHash('sha256').update(bytes).digest('hex')}))
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
test('native-launcher packages require a matching x64 GUI helper resource',async()=>{
  const missing=await fixture({native:true}),bad=await fixture({native:true,helper:true,tampered:true}),good=await fixture({native:true,helper:true})
  assert.equal(run(missing,[missing.asar,'--artifact-version=0.5.0']).status,1,'missing native resource must fail')
  assert.equal(run(bad,[bad.asar,'--artifact-version=0.5.0']).status,1,'native digest mismatch must fail')
  const result=run(good,[good.asar,'--artifact-version=0.5.0']);assert.equal(result.status,0,result.output)
  for(const f of [missing,bad,good])await clean(f)
})
test('required native mode rejects an old integration even with valid helper files',async()=>{
  const old=await fixture({helper:true}),good=await fixture({native:true,helper:true})
  const absent=run(old,[old.asar,'--artifact-version=0.5.0','--require-native-launcher'])
  assert.equal(absent.status,1,absent.output);assert.match(absent.output,/native integration/i)
  const present=run(good,[good.asar,'--artifact-version=0.5.0','--require-native-launcher'])
  assert.equal(present.status,0,present.output)
  await clean(old);await clean(good)
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
