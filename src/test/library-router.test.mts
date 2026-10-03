import assert from 'node:assert/strict'
import { test } from 'node:test'
import { LibraryRouter } from './online/library-router.js'
import { OnlinePlatformRegistry } from './online/platform-registry.js'

const track = { id: 'kw_1', name: '测试曲目', singer: '歌手', source: 'kw', interval: '03:00' }
const playlist = { name: '测试歌单', source: 'kw', sourceListId: '123', tracks: [track], total: 2, warnings: ['平台返回了部分结果'] }

function registry(platforms = [], consent = true) {
  return new OnlinePlatformRegistry({
    sourcesByScript: () => platforms.map(id => ({ apiId: `${id}-api`, sources: [{ id, name: id, actions: ['musicUrl'], qualitys: ['128k'] }] })),
    isScriptEnabled: () => true,
    catalogConsent: () => consent
  })
}

test('playlist import cannot request a platform without a healthy source and catalog consent', async () => {
  const calls = []
  const router = new LibraryRouter({
    registry: registry(['kw'], false),
    importBuiltin: async (...args) => { calls.push(args); return playlist }
  })

  const result = await router.importTracks('kw', 'https://example.test/playlist/123', '123')

  assert.deepEqual(result.list, [])
  assert.equal(result.servedBy, 'none')
  assert.equal(result.reason, 'noProvider')
  assert.match(result.message ?? '', /不可用/)
  assert.deepEqual(calls, [])
  assert.deepEqual(router.playablePlatforms(), [])
})

test('a sole kw source enables only kw playlist imports and preserves metadata', async () => {
  const calls = []
  const router = new LibraryRouter({
    registry: registry(['kw']),
    importBuiltin: async (...args) => { calls.push(args.slice(0, 2)); return { ...playlist, coverUrl: 'https://example.test/cover.jpg' } }
  })

  const result = await router.importTracks('kw', 'https://example.test/playlist/123', '123')
  const denied = await router.importTracks('tx', '123', '123')

  assert.equal(result.servedBy, 'builtin')
  assert.equal(result.name, '测试歌单')
  assert.equal(result.coverUrl, 'https://example.test/cover.jpg')
  assert.deepEqual(result.warnings, ['平台返回了部分结果'])
  assert.deepEqual(result.list, [track])
  assert.deepEqual(calls, [['kw', 'https://example.test/playlist/123']])
  assert.deepEqual(router.playablePlatforms(), ['kw'])
  assert.equal(denied.servedBy, 'none')
  assert.deepEqual(calls.length, 1)
})

test('playlist importer receives a live admission check for every request', async () => {
  let enabled = true
  let checks = 0
  const liveRegistry = new OnlinePlatformRegistry({
    sourcesByScript: () => [{ apiId: 'kw-api', sources: [{ id: 'kw', name: 'kw', actions: ['musicUrl'], qualitys: ['128k'] }] }],
    isScriptEnabled: () => enabled,
    catalogConsent: () => true
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
  assert.equal(result.reason, 'builtinFailed')
  assert.match(result.message ?? '', /授权已撤销/)
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
