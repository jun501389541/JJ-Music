/** Offline generated MP3/FLAC acceptance against the production test bundle. */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { parseFile } from 'music-metadata'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const ffmpeg = process.argv.find(arg => arg.startsWith('--ffmpeg='))?.slice(9) || 'ffmpeg.exe'
const output = join(root, '.cache/download-duration-media')
await mkdir(output, { recursive: true })
const report = { runId: randomUUID(), startedAt: new Date().toISOString(), status: 'running', offline: true, listeningTested: false, results: [], fixtureCleaned: false }
const bundle = join(root, 'out/test/downloads/download-manager.js')
report.bundleSha256 = createHash('sha256').update(await readFile(bundle)).digest('hex')
const { DownloadManager } = await import(pathToFileURL(bundle).href)
const { DEFAULT_SETTINGS } = await import(pathToFileURL(join(root, 'out/test/store/settings-store.js')).href)
const fixture = await mkdtemp(join(output, 'fixture-'))
try {
  for (const [extension, codec, quality] of [['mp3', 'libmp3lame', '128k'], ['flac', 'flac', 'flac']]) {
    const input = join(fixture, `generated.${extension}`)
    const generated = spawnSync(ffmpeg, ['-hide_banner', '-nostdin', '-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=44100:duration=60', '-ac', '2', '-c:a', codec, '-y', input], { windowsHide: true, timeout: 30000, maxBuffer: 1024 * 1024 })
    assert.ifError(generated.error)
    assert.equal(generated.status, 0, generated.stderr?.toString())
    const bytes = await readFile(input)
    for (const [interval, warningExpected] of [['04:16', true], ['01:00', false]]) {
      const dir = await mkdtemp(join(fixture, `${extension}-`))
      let requests = 0, imports = 0
      const manager = new DownloadManager(dir, {
        settings: () => ({ ...DEFAULT_SETTINGS, downloadFolder: dir, downloadLyric: false, downloadEmbedLyric: false, downloadEmbedCover: false }),
        defaultFolder: dir,
        resolve: async () => ({ url: 'https://offline.invalid/generated', quality }),
        fetch: async () => { requests++; return new Response(bytes, { headers: { 'content-length': String(bytes.length) } }) },
        lyrics: async () => { throw Error('Unexpected lyric request') },
        cover: async () => { throw Error('Unexpected cover request') },
        trash: async () => {},
        importFile: async () => { imports++; return 'generated-local' }
      })
      try {
        manager.add([{ id: `${extension}-${interval}`, name: 'Generated', singer: 'Fixture', source: 'tx', interval, meta: { songmid: 'offline' } }], quality)
        const deadline = Date.now() + 10000
        while (Date.now() < deadline && manager.list()[0]?.libraryStatus !== 'imported' && manager.list()[0]?.status !== 'failed') await new Promise(resolve => setTimeout(resolve, 10))
        await manager.shutdown()
        const task = manager.list()[0]
        assert.equal(task.status, 'completed', task.error)
        assert.equal(task.libraryStatus, 'imported')
        assert.equal(requests, 1)
        assert.equal(imports, 1)
        const warnings = task.warnings.filter(value => value.includes('时长'))
        assert.equal(warnings.length, warningExpected ? 1 : 0)
        if (warningExpected) assert.match(warnings[0], /音频时长约 60 秒，与目录标注 256 秒不符/)
        const saved = JSON.parse(await readFile(join(dir, 'downloads.json'), 'utf8'))
        assert.deepEqual(saved[0].warnings, task.warnings)
        const metadata = await parseFile(task.path)
        assert.ok(Math.abs(metadata.format.duration - 60) < 1)
        const decoded = spawnSync(ffmpeg, ['-hide_banner', '-nostdin', '-v', 'error', '-xerror', '-err_detect', 'explode', '-i', task.path, '-map', '0:a:0', '-f', 'null', '-'], { windowsHide: true, timeout: 30000, maxBuffer: 1024 * 1024 })
        assert.ifError(decoded.error)
        assert.equal(decoded.status, 0, decoded.stderr?.toString())
        assert.equal(decoded.stderr.length, 0)
        report.results.push({ format: extension, interval, status: 'passed', mediaSeconds: metadata.format.duration, warningExpected, warnings, requests, imports, strictDecodeExit: decoded.status })
      } finally { await manager.shutdown() }
    }
  }
  report.status = 'passed'
} catch (error) {
  report.status = 'failed'
  report.error = error instanceof Error ? error.message : String(error)
  process.exitCode = 1
} finally {
  // Only this invocation's mkdtemp-owned directory can be removed.
  assert.equal(dirname(fixture), output)
  await rm(fixture, { recursive: true, force: true })
  report.fixtureCleaned = true
  report.finishedAt = new Date().toISOString()
  await writeFile(join(output, 'report.json'), JSON.stringify(report, null, 2))
}
console.log(JSON.stringify(report))
