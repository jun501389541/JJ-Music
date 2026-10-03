import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DownloadManager } from './downloads/download-manager.js'

test('download deduplication is scoped by platform and LX provider identity', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'jj-download-provider-'))
  const manager = new DownloadManager(dir, {
    settings: () => ({ downloadFolder: dir }),
    defaultFolder: dir,
    resolve: () => new Promise(() => {}),
    lyrics: async () => ({ lyric: '' }),
    cover: async () => '',
    trash: async () => {}
  })
  const row = (source, providerId) => ({
    id: 'same-platform-id',
    name: 'Same song',
    singer: 'Artist',
    source,
    providerId,
    meta: { songmid: 'same-platform-id' }
  })

  try {
    const [scriptA, scriptB, otherPlatform, duplicateA] = manager.add([
      row('wy', 'stable-a'),
      row('wy', 'stable-b'),
      row('tx', 'stable-a'),
      row('wy', 'stable-a')
    ], '320k')
    const tasks = manager.list()
    assert.equal(tasks.length, 3)
    assert.notEqual(scriptA, scriptB, 'two LX scripts must have separate download records')
    assert.notEqual(scriptA, otherPlatform, 'platform-scoped ids must not collide across platforms')
    assert.equal(duplicateA, scriptA, 'a repeated provider/platform/song/quality request reuses its task')
    assert.deepEqual(tasks.map(task => [task.track.source, task.track.providerId]), [
      ['wy', 'stable-a'],
      ['wy', 'stable-b'],
      ['tx', 'stable-a']
    ])
  } finally {
    await manager.shutdown()
    await rm(dir, { recursive: true, force: true })
  }
})

test('download history records the LX script that actually resolved its URL', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'jj-download-provider-result-'))
  const manager = new DownloadManager(dir, {
    settings: () => ({ downloadFolder: dir }),
    defaultFolder: dir,
    resolve: async () => ({
      url: 'https://cdn.example.test/audio',
      quality: '320k',
      providerId: 'stable-b',
      providerName: '音源 B'
    }),
    lyrics: async () => ({ lyric: '' }),
    cover: async () => '',
    fetch: async () => new Response('unavailable', { status: 503 }),
    trash: async () => {}
  })
  try {
    const [id] = manager.add([{
      id: 'wy_1', name: 'Song', singer: 'Artist', source: 'wy', meta: { songmid: '1' }
    }], '320k')
    let task
    for (let attempt = 0; attempt < 100; attempt++) {
      task = manager.list().find(item => item.id === id)
      if (task.status === 'failed') break
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    assert.equal(task.status, 'failed')
    assert.equal(task.resolvedProviderId, 'stable-b')
    assert.equal(task.resolvedProviderName, '音源 B')
  } finally {
    await manager.shutdown()
    await rm(dir, { recursive: true, force: true })
  }
})

test('retry resolving through another LX script discards the old partial and validators', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'jj-download-provider-switch-'))
  let resolution = 0
  const requests = []
  const manager = new DownloadManager(dir, {
    settings: () => ({ downloadFolder: dir }),
    defaultFolder: dir,
    resolve: async () => ++resolution === 1
      ? { url: 'https://a.example.test/song', quality: '320k', providerId: 'stable-a', providerName: '音源 A' }
      : { url: 'https://b.example.test/song', quality: '320k', providerId: 'stable-b', providerName: '音源 B' },
    lyrics: async () => ({ lyric: '' }),
    cover: async () => '',
    fetch: async (url, init) => {
      requests.push({ url, headers: init.headers })
      if (String(url).startsWith('https://a.')) {
        return new Response('AAAA', {
          status: 206,
          headers: { 'content-range': 'bytes 0-3/8', 'content-length': '4', etag: '"provider-a"' }
        })
      }
      return new Response('BBBBBBBB', { headers: { 'content-length': '8', etag: '"provider-b"' } })
    },
    trash: async () => {}
  })
  try {
    const [id] = manager.add([{
      id: 'wy_1', name: 'Song', singer: 'Artist', source: 'wy', meta: { songmid: '1' }
    }], '320k')
    const waitForFailed = async () => {
      for (let attempt = 0; attempt < 200; attempt++) {
        const task = manager.list().find(item => item.id === id)
        if (task?.status === 'failed') return task
        await new Promise(resolve => setTimeout(resolve, 10))
      }
      throw new Error('download did not fail in time')
    }
    await waitForFailed()
    assert.equal(manager.list().find(item => item.id === id)?.received, 4)
    manager.retry(id)
    await waitForFailed()
    assert.equal(requests.length, 2)
    assert.equal(requests[1].headers.Range, undefined, 'bytes from A must never be appended to B')
    assert.equal(requests[1].headers['If-Range'], undefined, 'validators from A must not be sent to B')
    assert.equal(manager.list().find(item => item.id === id)?.resolvedProviderId, 'stable-b')
  } finally {
    await manager.shutdown()
    await rm(dir, { recursive: true, force: true })
  }
})
