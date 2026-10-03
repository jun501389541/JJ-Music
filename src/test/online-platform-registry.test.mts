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
  let consent = false
  const enabled = new Set(['kw-api', 'tx-no-music-url'])
  let runtimes = [
    { apiId: 'kw-api', sources: [source('kw')] },
    { apiId: 'tx-no-music-url', sources: [source('tx', ['lyric'])] },
    { apiId: 'disabled-api', sources: [source('wy')] },
    { apiId: 'local-api', sources: [source('local')] }
  ]
  const registry = new OnlinePlatformRegistry({
    sourcesByScript: () => runtimes,
    isScriptEnabled: apiId => enabled.has(apiId),
    catalogConsent: () => consent
  })
  return {
    registry,
    enabled,
    setConsent(value) { consent = value },
    setRuntimes(value) { runtimes = value }
  }
}

test('unconfirmed catalog consent keeps every platform capability closed', () => {
  const { registry } = fixture()

  assert.deepEqual(registry.eligiblePlatforms(), ['kw'])
  assert.deepEqual(registry.platforms('search'), [])
  assert.equal(registry.allows('kw', 'search'), false)
})

test('a sole enabled kw source opens only kw capabilities it can serve', () => {
  const { registry, setConsent } = fixture()
  setConsent(true)

  assert.deepEqual(registry.platforms('search'), ['kw'])
  assert.deepEqual(registry.platforms('hotWords'), ['kw'])
  assert.deepEqual(registry.platforms('lyrics'), ['kw'])
  assert.deepEqual(registry.platforms('playlistImport'), ['kw'])
  assert.deepEqual(registry.platforms('artistImage'), [])
  assert.deepEqual(registry.platforms('artistDetail'), [])
  assert.deepEqual(registry.platforms('albumDetail'), [])
  assert.equal(registry.allows('tx', 'search'), false)
  assert.equal(registry.allows('local', 'search'), false)
})

test('precision artist and album details are enabled only for an active wy source', () => {
  const { registry, enabled, setConsent, setRuntimes } = fixture()
  enabled.add('wy-api')
  setConsent(true)
  setRuntimes([{ apiId: 'wy-api', sources: [source('wy')] }])

  assert.deepEqual(registry.platforms('artistDetail'), ['wy'])
  assert.deepEqual(registry.platforms('albumDetail'), ['wy'])

  enabled.delete('wy-api')
  assert.deepEqual(registry.platforms('artistDetail'), [])
  assert.deepEqual(registry.platforms('albumDetail'), [])
})

test('eligibility is re-evaluated from enabled healthy scripts and musicUrl declarations', () => {
  const { registry, enabled, setConsent, setRuntimes } = fixture()
  setConsent(true)

  enabled.delete('kw-api')
  assert.deepEqual(registry.platforms('search'), [])

  enabled.add('kw-api')
  setRuntimes([{ apiId: 'kw-api', sources: [source('kw', ['lyric'])] }])
  assert.deepEqual(registry.platforms('search'), [])

  setRuntimes([{ apiId: 'kw-api', sources: [source('kw')] }])
  assert.deepEqual(registry.platforms('search'), ['kw'])

  setRuntimes([])
  assert.deepEqual(registry.platforms('search'), [])
})
