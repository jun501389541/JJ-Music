/** FFmpeg-generated media acceptance against existing production bundles; never builds shared out/. */
import assert from 'node:assert/strict'
import { randomUUID, createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile, copyFile, stat } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { parseFile } from 'music-metadata'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const bundle = resolve(process.argv.find(arg => arg.startsWith('--bundle='))?.slice(9) ?? join(root, 'out/test/library'))
const load = name => import(pathToFileURL(join(bundle, name + '.js')).href)
const { exportAssets, flushAssetWrites } = await load('asset-export')
const { writeTags } = await load('tag-writer')
const { readEmbeddedLyric } = await load('embedded-lyrics')
const { sidecarPathFor, coverSidecarPathFor } = await load('asset-files')
const runId = randomUUID(), output = join(root, '.cache/or8-generated-assets'), fixture = join(output, runId)
await mkdir(fixture, { recursive: true })
const report = { runId, started: new Date().toISOString(), status: 'running', fixture, bundle, checks: [], formats: [], commands: [], listeningTested: false, queueFailureTested: false }
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const check = (label, value) => { assert.ok(value, label); report.checks.push(label) }
function ffmpeg(args, label) {
  const result = spawnSync('ffmpeg.exe', ['-hide_banner', '-nostdin', ...args], { windowsHide: true, timeout: 30_000, maxBuffer: 16 * 1024 * 1024 })
  const stderr = result.stderr?.toString('utf8') ?? ''
  report.commands.push({ label, args, status: result.status, stderr: stderr.trim() })
  assert.ifError(result.error)
  assert.equal(result.status, 0, `${label}: ${stderr}`)
  return result.stdout
}
function pcm(file, label) {
  const bytes = ffmpeg(['-v', 'error', '-xerror', '-err_detect', 'explode', '-i', file, '-map', '0:a:0', '-vn', '-c:a', 'pcm_s32le', '-ar', '48000', '-ac', '2', '-f', 's32le', 'pipe:1'], label)
  check(`${label}: actual decoded PCM is nonempty`, bytes.length > 48000 * 2 * 4)
  return { bytes: bytes.length, sha256: sha(bytes) }
}
try {
  report.ffmpegVersion = ffmpeg(['-version'], 'ffmpeg-version').toString('utf8').split(/\r?\n/)[0]
  report.bundleFiles = []
  for (const name of ['asset-export', 'tag-writer', 'embedded-lyrics', 'asset-files']) {
    const file = join(bundle, name + '.js')
    report.bundleFiles.push({ file, sha256: sha(await readFile(file)), mtime: (await stat(file)).mtime.toISOString() })
  }
  const coverFile = join(fixture, 'generated-cover.png')
  ffmpeg(['-v', 'error', '-f', 'lavfi', '-i', 'color=c=0x4268c8:s=16x16:d=0.04', '-frames:v', '1', '-threads', '1', '-y', coverFile], 'generate-cover')
  // The production FLAC reader canonicalizes synchronized timestamps to milliseconds.
  const cover = await readFile(coverFile), lyric = '[00:00.000]OR8 generated first line\n[00:01.000]OR8 generated second line'
  for (const [extension, codec] of [['mp3', 'libmp3lame'], ['flac', 'flac'], ['ogg', 'libvorbis'], ['wav', 'pcm_s16le']]) {
    const file = join(fixture, `generated-${extension}.${extension}`)
    ffmpeg(['-v', 'error', '-f', 'lavfi', '-i', 'aevalsrc=0.14*sin(2*PI*440*t)+0.08*sin(2*PI*880*t):s=48000:d=2', '-ac', '2', '-c:a', codec, '-y', file], `generate-${extension}`)
    const original = await readFile(file), before = pcm(file, `${extension}-before`)
    const evidence = { extension, codec, originalBytes: original.length, originalSha256: sha(original), before }
    report.formats.push(evidence)
    const patch = { title: `OR8 ${extension} title`, artist: 'OR8 synthetic artist', album: 'OR8 generated album', lyrics: lyric, cover: { data: cover, mimeType: 'image/png' } }
    const written = await exportAssets({ audioPath: file, patch, to: ['embedded'], noClobber: true })
    evidence.export = written
    check(`${extension}: asset exporter reports a landed write`, written.written)
    const after = pcm(file, `${extension}-after-export`)
    evidence.afterExport = after
    check(`${extension}: decoded PCM unchanged after exporter`, before.bytes === after.bytes && before.sha256 === after.sha256)
    if (['mp3', 'flac'].includes(extension)) {
      check(`${extension}: exporter actually embedded assets`, written.embeddedWritten && written.landed.includes('文件内嵌'))
      const metadata = await parseFile(file)
      check(`${extension}: title/artist/album read back`, metadata.common.title === patch.title && metadata.common.artist === patch.artist && metadata.common.album === patch.album)
      check(`${extension}: cover bytes read back`, metadata.common.picture?.some(picture => sha(picture.data) === sha(cover)))
      check(`${extension}: lyric read back through production reader`, (await readEmbeddedLyric(file))?.lyric.trim() === lyric)
      check(`${extension}: backup contains exact original file`, sha(await readFile(file + '.bak')) === sha(original))
      check(`${extension}: embedded-only export creates no sidecars`, !existsSync(sidecarPathFor(file)) && !existsSync(coverSidecarPathFor(file, 'image/png')))
      const secondTitle = `OR8 ${extension} second title`
      const second = await writeTags(file, { title: secondTitle })
      check(`${extension}: direct production writer succeeds on independent patch`, second.written)
      const updated = await parseFile(file)
      check(`${extension}: independent patch preserves other tags/assets`, updated.common.title === secondTitle && updated.common.artist === patch.artist && updated.common.picture?.some(picture => sha(picture.data) === sha(cover)) && (await readEmbeddedLyric(file))?.lyric.trim() === lyric)
      const afterSecond = pcm(file, `${extension}-after-second-patch`)
      evidence.afterSecond = afterSecond
      check(`${extension}: second patch preserves decoded PCM`, before.bytes === afterSecond.bytes && before.sha256 === afterSecond.sha256)
      check(`${extension}: repeated writes preserve first backup`, sha(await readFile(file + '.bak')) === sha(original))
      const restored = join(fixture, `restored.${extension}`)
      await copyFile(file + '.bak', restored)
      check(`${extension}: backup restoration recovers original bytes`, sha(await readFile(restored)) === sha(original))
      const recovered = pcm(restored, `${extension}-restored`)
      evidence.restored = recovered
      check(`${extension}: restored backup strictly decodes to original PCM`, before.bytes === recovered.bytes && before.sha256 === recovered.sha256)
    } else {
      check(`${extension}: unsupported embedded format falls back to sidecar`, !written.embeddedWritten && written.landed.includes('同目录文件') && written.notes.some(note => note.includes('不支持写入标签')))
      check(`${extension}: fallback leaves all original audio bytes unchanged`, sha(await readFile(file)) === sha(original))
      check(`${extension}: sidecar lyric exact`, await readFile(sidecarPathFor(file), 'utf8') === lyric)
      check(`${extension}: sidecar cover exact`, sha(await readFile(coverSidecarPathFor(file, 'image/png'))) === sha(cover))
      check(`${extension}: fallback creates no audio backup`, !existsSync(file + '.bak'))
    }
  }
  await flushAssetWrites()
  report.status = 'passed'
} catch (error) { report.status = 'failed'; report.error = error.stack ?? String(error); process.exitCode = 1 }
finally {
  report.finished = new Date().toISOString()
  const text = JSON.stringify(report, null, 2) + '\n'
  await writeFile(join(output, `${runId}-report.json`), text)
  await writeFile(join(output, 'report.json'), text)
  console.log(JSON.stringify({ status: report.status, checks: report.checks.length, report: join(output, `${runId}-report.json`), error: report.error }))
}
