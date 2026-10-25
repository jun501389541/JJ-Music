import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DownloadManager } from './downloads/download-manager.js'
import { DEFAULT_SETTINGS } from './store/settings-store.js'

// Actual mono PCM samples, not a metadata parser stub or header-only fixture.
function wav(seconds) {
  const rate = 8000, size = seconds * rate * 2
  const bytes = Buffer.alloc(44 + size)
  bytes.write('RIFF'); bytes.writeUInt32LE(36 + size, 4); bytes.write('WAVEfmt ', 8)
  bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22)
  bytes.writeUInt32LE(rate, 24); bytes.writeUInt32LE(rate * 2, 28)
  bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34)
  bytes.write('data', 36); bytes.writeUInt32LE(size, 40)
  return bytes
}

for (const [interval, seconds, warned] of [
  ['04:16', 60, true], ['00:30', 60, true],
  ['01:00', 60, false], ['01:05', 60, false], ['01:06', 60, true],
  ['04:10', 240, false], ['04:20', 240, true],
  ['03:20', 190, false], ['03:20', 189, true],
  [undefined, 60, false], ['', 60, false], ['garbage', 60, false],
  ['00:00', 60, false], ['00:99', 60, false], ['-1:00', 60, false]
]) test(`download duration ${seconds}s vs ${String(interval)}: warning=${warned}`, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'jj-download-duration-'))
  const audio = wav(seconds)
  let requests = 0, imports = 0
  const manager = new DownloadManager(dir, {
    settings: () => ({ ...DEFAULT_SETTINGS, downloadFolder: dir, downloadLyric: false, downloadEmbedLyric: false, downloadEmbedCover: false }),
    defaultFolder: dir,
    resolve: async () => ({ url: 'https://fixture.example/audio', quality: '128k' }),
    lyrics: async () => { throw Error('unexpected lyrics request') },
    cover: async () => { throw Error('unexpected cover request') },
    fetch: async () => { requests++; return new Response(audio, { headers: { 'content-length': String(audio.length) } }) },
    trash: async () => {},
    importFile: async () => { imports++; return 'local-fixture' }
  })
  try {
    manager.add([{ id: 'duration', source: 'tx', name: 'Fixture', singer: 'Test', interval, meta: { songmid: 'fixture' } }], '128k')
    const deadline = Date.now() + 5000
    while (Date.now() < deadline && !['imported', 'failed'].includes(manager.list()[0]?.libraryStatus) && manager.list()[0]?.status !== 'failed') {
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    await manager.shutdown()
    const task = manager.list()[0]
    assert.equal(task.status, 'completed', task.error)
    assert.equal(task.libraryStatus, 'imported')
    assert.equal(imports, 1)
    assert.equal(requests, 1)
    assert.equal((await stat(task.path)).size, audio.length)
    const warnings = task.warnings.filter(value => value.includes('时长'))
    assert.equal(warnings.length, warned ? 1 : 0)
    if (warned) {
      assert.match(warnings[0], new RegExp(`音频时长约 ${seconds} 秒`))
      assert.match(warnings[0], /目录标注.*不符.*核对/)
      assert.doesNotMatch(warnings[0], /试听|全曲|完整/)
    }
    const saved = JSON.parse(await readFile(join(dir, 'downloads.json'), 'utf8'))
    assert.deepEqual(saved[0].warnings, task.warnings)
    const reloaded = new DownloadManager(dir, { settings: () => DEFAULT_SETTINGS, defaultFolder: dir })
    await reloaded.load()
    assert.deepEqual(reloaded.list()[0].warnings, task.warnings)
    await reloaded.shutdown()
  } finally {
    await manager.shutdown()
    await rm(dir, { recursive: true, force: true })
  }
})

test('cancelling a short result then retrying a matching result removes the old duration warning', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'jj-download-duration-retry-'))
  let attempt = 0, imports = 0, lyricStarted
  const lyricGate = new Promise(resolve => { lyricStarted = resolve })
  const manager = new DownloadManager(dir, {
    settings: () => ({ ...DEFAULT_SETTINGS, downloadFolder: dir, downloadLyric: true, downloadEmbedLyric: false, downloadEmbedCover: false }),
    defaultFolder: dir,
    resolve: async () => { attempt++; return { url: 'https://fixture.example/audio', quality: '128k' } },
    fetch: async () => new Response(wav(attempt === 1 ? 60 : 256)),
    lyrics: async () => {
      if (attempt === 1) { lyricStarted(); return new Promise(() => {}) }
      return { lyric: '' }
    },
    cover: async () => '', trash: async () => {},
    importFile: async () => { imports++; return 'local-retry' }
  })
  try {
    const [id] = manager.add([{ id: 'retry', source: 'tx', name: 'Fixture', singer: 'Test', interval: '04:16', meta: { songmid: 'retry' } }], '128k')
    // A deadline prevents a regression before lyric fetching from hanging this suite.
    let timer
    try {
      await Promise.race([lyricGate, new Promise((_, reject) => { timer = setTimeout(() => reject(Error('lyric gate not reached')), 5000) })])
    } finally { clearTimeout(timer) }
    assert.match(manager.list()[0].warnings.join(''), /音频时长约 60 秒/)
    manager.cancel(id)
    const deadline = Date.now() + 5000
    // retry() deliberately refuses while cancellation is still settling.
    for (;;) {
      try { manager.retry(id); break } catch (error) {
        if (!String(error).includes('尚未停止') || Date.now() >= deadline) throw error
        await new Promise(resolve => setTimeout(resolve, 5))
      }
    }
    assert.deepEqual(manager.list()[0].warnings, [])
    while (Date.now() < deadline && manager.list()[0].libraryStatus !== 'imported' && manager.list()[0].status !== 'failed') {
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    await manager.shutdown()
    const task = manager.list()[0]
    assert.equal(task.status, 'completed', task.error)
    assert.equal(task.libraryStatus, 'imported')
    assert.equal(attempt, 2)
    assert.equal(imports, 1, 'cancelled audio must never be imported')
    assert.equal(task.warnings.some(value => value.includes('时长')), false)
    const saved = JSON.parse(await readFile(join(dir, 'downloads.json'), 'utf8'))
    assert.equal(saved[0].warnings.some(value => value.includes('时长')), false)
  } finally {
    await manager.shutdown()
    await rm(dir, { recursive: true, force: true })
  }
})
