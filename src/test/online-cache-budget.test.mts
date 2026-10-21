import assert from 'node:assert/strict'
import test from 'node:test'
import { ONLINE_CACHE_BYTES, ONLINE_CACHE_DISK_LIMIT } from './online/cache-budget.js'

test('default online disk buckets fit the documented total with envelope headroom', () => {
  const total = Object.values(ONLINE_CACHE_BYTES).reduce((sum, bytes) => sum + bytes, 0)
  assert.equal(ONLINE_CACHE_DISK_LIMIT, 256 * 1024 * 1024)
  assert.ok(total < ONLINE_CACHE_DISK_LIMIT)
  assert.ok(ONLINE_CACHE_BYTES.artistDetail + ONLINE_CACHE_BYTES.albumDetail + ONLINE_CACHE_BYTES.playlists + ONLINE_CACHE_BYTES.hotWords <= 48 * 1024 * 1024)
  assert.ok(ONLINE_CACHE_BYTES.lyrics <= 16 * 1024 * 1024)
  assert.ok(ONLINE_CACHE_BYTES.coverBytes <= 192 * 1024 * 1024)
})
