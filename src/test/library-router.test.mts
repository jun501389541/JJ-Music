import assert from 'node:assert/strict'
import { test } from 'node:test'
import { LibraryRouter } from './online/library-router.js'

const track = {
  id: 'tx_1',
  name: '测试曲目',
  singer: '歌手',
  source: 'tx',
  interval: '03:00'
}

const playlist = {
  name: '测试歌单',
  source: 'tx',
  sourceListId: '123',
  tracks: [track],
  total: 1,
  warnings: []
}

test('global gate closed means playlist import cannot reach a built-in adapter', async () => {
  const calls = []
  const router = new LibraryRouter({
    allowBuiltin: () => false,
    importBuiltin: async (...args) => {
      calls.push(args)
      return playlist
    }
  })

  const result = await router.importTracks('tx', 'https://example.test/playlist/123', '123')

  assert.deepEqual(result.list, [])
  assert.equal(result.servedBy, 'none')
  assert.equal(result.reason, 'noProvider')
  assert.match(result.message ?? '', /不可用/)
  assert.deepEqual(calls, [])
  assert.deepEqual(router.playablePlatforms(), [])
})

test('enabled playlist import uses the built-in adapter and preserves its returned metadata', async () => {
  const calls = []
  const router = new LibraryRouter({
    allowBuiltin: () => true,
    importBuiltin: async (...args) => {
      calls.push(args)
      return { ...playlist, coverUrl: 'https://example.test/cover.jpg' }
    }
  })

  const result = await router.importTracks('tx', 'https://example.test/playlist/123', '123')

  assert.equal(result.servedBy, 'builtin')
  assert.equal(result.name, '测试歌单')
  assert.equal(result.coverUrl, 'https://example.test/cover.jpg')
  assert.deepEqual(result.list, [track])
  assert.deepEqual(calls, [['tx', 'https://example.test/playlist/123']])
  assert.deepEqual(router.playablePlatforms().sort(), ['kg', 'kw', 'mg', 'tx', 'wy'])
})

test('playlist adapter failures are returned as a visible failure', async () => {
  const router = new LibraryRouter({
    allowBuiltin: () => true,
    importBuiltin: async () => { throw new Error('connection refused') }
  })

  const result = await router.importTracks('tx', '123', '123')

  assert.deepEqual(result.list, [])
  assert.equal(result.reason, 'builtinFailed')
  assert.match(result.message ?? '', /connection refused/)
})

test('JJ-only leaderboards are unavailable and expose no active platform entry', async () => {
  const router = new LibraryRouter({ allowBuiltin: () => true })

  assert.deepEqual(router.leaderboardPlatforms(), [])
  assert.equal(router.hasLeaderboards(), false)
  assert.equal((await router.leaderboards()).reason, 'noProvider')
  assert.equal((await router.leaderboardTracks('legacy-source', 'top500')).reason, 'noProvider')
})
