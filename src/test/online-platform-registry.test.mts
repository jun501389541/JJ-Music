import assert from 'node:assert/strict'
import { test } from 'node:test'
import { OnlinePlatformRegistry } from './online/platform-registry.js'

const source = (id, actions = ['musicUrl']) => ({
  id,
  name: id,
  actions,
  qualitys: ['128k']
})

function fixture() {
  const enabled = new Set(['kw-api', 'tx-no-music-url'])
  let runtimes = [
    { apiId: 'kw-api', sources: [source('kw')] },
    { apiId: 'tx-no-music-url', sources: [source('tx', ['lyric'])] },
    { apiId: 'disabled-api', sources: [source('wy')] },
    { apiId: 'local-api', sources: [source('local')] }
  ]
  const registry = new OnlinePlatformRegistry({
    sourcesByScript: () => runtimes,
    isScriptEnabled: apiId => enabled.has(apiId)
  })
  return {
    registry,
    enabled,
    setRuntimes(value) { runtimes = value }
  }
}

test('catalog capabilities are available by default', () => {
  const { registry } = fixture()

  assert.deepEqual(registry.eligiblePlatforms(), ['kw'])
  assert.deepEqual(registry.platforms('search'), ['tx', 'wy', 'kw', 'kg', 'mg'])
  assert.equal(registry.allows('kw', 'search'), true)
})

test('app adapter capabilities are available without an LX source', () => {
  const { registry, setRuntimes } = fixture()
  setRuntimes([])

  assert.deepEqual(registry.platforms('search'), ['tx', 'wy', 'kw', 'kg', 'mg'])
  assert.deepEqual(registry.platforms('hotWords'), ['tx', 'wy', 'kw', 'kg'])
  assert.deepEqual(registry.platforms('lyrics'), ['tx', 'wy', 'kw', 'mg'])
  assert.deepEqual(registry.platforms('playlistImport'), ['tx', 'wy', 'kw', 'kg', 'mg'])
  assert.deepEqual(registry.platforms('artistImage'), ['tx', 'wy', 'kg', 'mg'])
  assert.deepEqual(registry.platforms('artistDetail'), ['wy'])
  assert.deepEqual(registry.platforms('albumDetail'), ['wy'])
  assert.equal(registry.allows('tx', 'search'), true)
  assert.equal(registry.allows('local', 'search'), false)
})

test('source eligibility remains independent from default directory capability', () => {
  const { registry, enabled, setRuntimes } = fixture()

  assert.deepEqual(registry.eligiblePlatforms(), ['kw'])
  enabled.delete('kw-api')
  assert.deepEqual(registry.eligiblePlatforms(), [])
  assert.deepEqual(registry.platforms('search'), ['tx', 'wy', 'kw', 'kg', 'mg'])

  enabled.add('kw-api')
  setRuntimes([{ apiId: 'kw-api', sources: [source('kw', ['lyric'])] }])
  assert.deepEqual(registry.eligiblePlatforms(), [])
  assert.deepEqual(registry.platforms('search'), ['tx', 'wy', 'kw', 'kg', 'mg'])

  setRuntimes([{ apiId: 'kw-api', sources: [source('kw')] }])
  assert.deepEqual(registry.eligiblePlatforms(), ['kw'])
  assert.deepEqual(registry.platforms('search'), ['tx', 'wy', 'kw', 'kg', 'mg'])

  setRuntimes([])
  assert.deepEqual(registry.eligiblePlatforms(), [])
  assert.deepEqual(registry.platforms('search'), ['tx', 'wy', 'kw', 'kg', 'mg'])
})
