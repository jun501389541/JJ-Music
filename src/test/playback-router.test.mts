import assert from 'node:assert/strict'
import { test } from 'node:test'
import { PlaybackError, PlaybackRouter } from './sources/playback-router.js'

function makeTrack(extra = {}) {
  return {
    id: 'tx_1',
    name: '测试曲目',
    singer: '歌手',
    source: 'tx',
    interval: '03:00',
    ...extra
  }
}

function createRouter() {
  const calls = []
  const sourceEngine = {
    supports: (source, action) => source === 'tx' && action === 'musicUrl',
    supportsProvider: (source, providerId, action) => source === 'tx' && providerId === 'stable-b' && action === 'musicUrl',
    getMusicUrl: async (...args) => {
      calls.push(['musicUrl', ...args])
      return { url: 'https://example.test/song.mp3', quality: '128k', apiId: 'legacy-lx-id' }
    },
    getLyric: async (...args) => {
      calls.push(['lyric', ...args])
      return { lyric: '歌词' }
    },
    getPic: async (...args) => {
      calls.push(['pic', ...args])
      return 'https://example.test/cover.jpg'
    }
  }
  return { calls, router: new PlaybackRouter({ sourceEngine }) }
}

test('unstamped legacy tracks continue through the shared LX source lifecycle', async () => {
  const { calls, router } = createRouter()
  const oldTrack = makeTrack()
  const signal = new AbortController().signal

  const url = await router.musicUrl(oldTrack, '128k', true)
  const lyric = await router.lyric(oldTrack, signal)
  const picture = await router.pic(oldTrack, signal)

  assert.equal(url.url, 'https://example.test/song.mp3')
  assert.equal(url.apiId, 'legacy-lx-id')
  assert.deepEqual(lyric, { lyric: '歌词' })
  assert.equal(picture, 'https://example.test/cover.jpg')
  assert.equal(calls.length, 3)
  assert.deepEqual(calls[0], ['musicUrl', 'tx', oldTrack, '128k', true])
  assert.deepEqual(calls[1], ['lyric', 'tx', oldTrack, signal])
  assert.deepEqual(calls[2], ['pic', 'tx', oldTrack, signal])
})

test('old JJ providerId records are not silently rebound to an LX script', async () => {
  const { calls, router } = createRouter()
  const stamped = makeTrack({ providerId: 'old-source-instance' })

  assert.equal(router.ownerOf(stamped), 'old-source-instance')
  await assert.rejects(() => router.musicUrl(stamped, '320k'), (error) => {
    assert.ok(error instanceof PlaybackError)
    assert.equal(error.reason, 'providerMissing')
    assert.equal(error.providerId, 'old-source-instance')
    assert.match(error.message, /重新匹配/)
    return true
  })
  await assert.rejects(() => router.lyric(stamped), { reason: 'providerMissing' })
  await assert.rejects(() => router.pic(stamped), { reason: 'providerMissing' })

  assert.deepEqual(calls, [])
})

test('supports only maps legacy playback capabilities to LX actions for unstamped tracks', () => {
  const { router } = createRouter()
  const oldTrack = makeTrack()

  assert.equal(router.supports(oldTrack, 'getMusicUrl'), true)
  assert.equal(router.supports(oldTrack, 'getLyric'), false)
  assert.equal(router.supports(makeTrack({ providerId: 'old-source-instance' }), 'getMusicUrl'), false)
  assert.equal(router.ownerOf(oldTrack), null)
})

test('a known LX stable provider id is routed to that provider', async () => {
  const { calls, router } = createRouter()
  const stamped = makeTrack({ providerId: 'stable-b' })
  const result = await router.musicUrl(stamped, '128k')
  assert.equal(result.apiId, 'legacy-lx-id')
  assert.deepEqual(calls[0], ['musicUrl', 'tx', stamped, '128k', false])
  assert.equal(router.supports(stamped, 'getMusicUrl'), true)
})
