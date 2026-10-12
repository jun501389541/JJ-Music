import assert from 'node:assert/strict'
import { test } from 'node:test'
import { LibraryRouter } from './online/library-router.js'
import { OnlinePlatformRegistry } from './online/platform-registry.js'

const track = { id: 'kw_1', name: '测试曲目', singer: '歌手', source: 'kw', interval: '03:00' }
const playlist = { name: '测试歌单', source: 'kw', sourceListId: '123', tracks: [track], total: 2, warnings: ['平台返回了部分结果'] }

function registry(platforms = []) {
  return new OnlinePlatformRegistry({
    sourcesByScript: () => platforms.map(id => ({ apiId: `${id}-api`, sources: [{ id, name: id, actions: ['musicUrl'], qualitys: ['128k'] }] })),
    isScriptEnabled: () => true
  })
}

test('unsupported platform cannot issue playlist requests', async () => {
  const calls = []
  const router = new LibraryRouter({
    registry: registry(['kw']),
    importBuiltin: async (...args) => { calls.push(args); return playlist }
  })

  const result = await router.importTracks('local', 'https://example.test/playlist/123', '123')

  assert.deepEqual(result.list, [])
  assert.equal(result.servedBy, 'none')
  assert.equal(result.reason, 'noProvider')
  assert.match(result.message ?? '', /不可用/)
  assert.deepEqual(calls, [])
  assert.deepEqual(router.playablePlatforms(), ['tx', 'wy', 'kw', 'kg', 'mg'])
})

test('app playlist adapters are available independently of LX playback sources', async () => {
  const calls = []
  let enabled = true
  const router = new LibraryRouter({
    registry: new OnlinePlatformRegistry({
      sourcesByScript: () => [{ apiId: 'kw-api', sources: [{ id: 'kw', name: 'kw', actions: ['musicUrl'], qualitys: ['128k'] }] }],
      isScriptEnabled: () => enabled
    }),
    importBuiltin: async (...args) => { calls.push(args.slice(0, 2)); return { ...playlist, coverUrl: 'https://example.test/cover.jpg' } }
  })

  const result = await router.importTracks('kw', 'https://example.test/playlist/123', '123')
  enabled = false
  const otherAdapter = await router.importTracks('tx', 'https://example.test/playlist/456', '456')

  assert.equal(result.servedBy, 'builtin')
  assert.equal(result.name, '测试歌单')
  assert.equal(result.coverUrl, 'https://example.test/cover.jpg')
  assert.deepEqual(result.warnings, ['平台返回了部分结果'])
  assert.deepEqual(result.list, [track])
  assert.deepEqual(calls, [['kw', 'https://example.test/playlist/123'], ['tx', 'https://example.test/playlist/456']])
  assert.deepEqual(router.playablePlatforms(), ['tx', 'wy', 'kw', 'kg', 'mg'])
  assert.equal(otherAdapter.servedBy, 'builtin')
})

test('stopping a playback source does not revoke a running playlist request', async () => {
  let enabled = true
  let checks = 0
  const liveRegistry = new OnlinePlatformRegistry({
    sourcesByScript: () => [{ apiId: 'kw-api', sources: [{ id: 'kw', name: 'kw', actions: ['musicUrl'], qualitys: ['128k'] }] }],
    isScriptEnabled: () => enabled
  })
  const router = new LibraryRouter({
    registry: liveRegistry,
    importBuiltin: async (_source, _input, assertAllowed) => {
      assertAllowed()
      enabled = false
      checks += 1
      assertAllowed()
      return playlist
    }
  })

  const result = await router.importTracks('kw', '123', '123')
  assert.equal(result.servedBy, 'builtin')
  assert.deepEqual(result.list, [track])
  assert.equal(checks, 1)
})

test('playlist adapter failures are returned as a visible failure', async () => {
  const router = new LibraryRouter({
    registry: registry(['kw']),
    importBuiltin: async () => { throw new Error('connection refused') }
  })

  const result = await router.importTracks('kw', '123', '123')

  assert.deepEqual(result.list, [])
  assert.equal(result.reason, 'builtinFailed')
  assert.match(result.message ?? '', /connection refused/)
})

test('JJ-only leaderboards are unavailable and expose no active platform entry', async () => {
  const router = new LibraryRouter({ registry: registry(['kw']) })

  assert.deepEqual(router.leaderboardPlatforms(), [])
  assert.equal(router.hasLeaderboards(), false)
  assert.equal((await router.leaderboards()).reason, 'noProvider')
  assert.equal((await router.leaderboardTracks('legacy-source', 'top500')).reason, 'noProvider')
})
