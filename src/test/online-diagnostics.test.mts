import assert from 'node:assert/strict'
import { test } from 'node:test'
import { OnlineDiagnostics } from './online/online-diagnostics.js'

test('auxiliary capability and internal aliases are retained without opening the field whitelist', () => {
  const log = new OnlineDiagnostics()
  for (const capability of ['artistImage','trackDetail','downloadCover','lyrics','playlistImport']) log.record({capability,url:'secret',message:'secret'})
  assert.deepEqual(log.export().events.map(event=>event.capability), ['artistImage','trackDetail','downloadCover','lyric','playlist'])
  assert.equal(JSON.stringify(log.export()).includes('secret'),false)
})

test('diagnostic export uses a strict whitelist and bounded identifiers', async () => {
  let stored
  const log = new OnlineDiagnostics({ write: async v => { stored = v } })
  for (let i = 0; i < 510; i++) log.record({
    requestId: 'https://secret:token@host/path?search=private', intentId: 'C:/private',
    platform: 'wy', capability: 'search', stage: 'catalog', code: 'network', elapsedMs: 12,
    message: 'token private', keyword: 'private', path: 'private', url: 'https://token:password@music.163.com/private?token=private',
    providerVersion: 'private', error: { message: 'private' }
  })
  await log.flush()
  const output = JSON.stringify(log.export())
  assert.equal(log.export().events.length, 500)
  for (const secret of ['secret', 'private', 'password', 'token', 'C:/']) assert.equal(output.includes(secret), false)
  assert.ok(Buffer.byteLength(JSON.stringify(stored)) <= 2 * 1024 * 1024)
  log.setEnabled(false); log.record({ platform: 'tx', code: 'unknown' })
  assert.equal(log.export().events.length, 500)
  log.clear(); await log.flush(); assert.equal(log.export().events.length, 0)
})
