import assert from 'node:assert/strict'
import { test } from 'node:test'
import { playbackUrlLease, mediaFailure, canRecoverMedia } from './shared/playback-reliability.js'
test('URL lease caps at five minutes and trusted expiry minus thirty seconds, with no URL parameter inference',()=>{
  const now=1_000_000
  assert.deepEqual(playbackUrlLease({url:'https://x.test/?expires=1'},now),{fetchedAt:now,cacheUntil:now+300_000})
  assert.equal(playbackUrlLease({resolvedAt:now,expiresAt:now+60_000},now).cacheUntil,now+30_000)
  assert.equal(playbackUrlLease({resolvedAt:now-301_000},now),null)
  assert.equal(playbackUrlLease({resolvedAt:now+1},now),null)
  assert.equal(playbackUrlLease({expiresAt:now+29_000},now),null)
  assert.equal(playbackUrlLease({expiresAt:NaN},now),null)
})
test('cancel, decode, unsupported and ordinary HTTP denial are not URL expiry recovery evidence',()=>{
  for(const code of ['cancelled','decode','unsupported','forbidden','unknown'])assert.equal(canRecoverMedia({code}),false)
  assert.equal(canRecoverMedia({code:'network'}),true)
  assert.equal(canRecoverMedia({code:'urlExpired'}),true)
  assert.equal(mediaFailure(1).code,'cancelled');assert.equal(mediaFailure(2).code,'network');assert.equal(mediaFailure(3).code,'decode');assert.equal(mediaFailure(4).code,'unsupported')
})
