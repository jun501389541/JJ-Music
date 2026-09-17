import assert from 'node:assert/strict'
import { test } from 'node:test'
import { searchLocalTracks } from './renderer/utils/local-search.js'

const track = (id, name, singer = '周杰伦', albumName = '叶惠美') => ({ id, name, singer, albumName, path: `D:/music/${id}.flac` })

test('local search ranks exact titles first and matches terms across metadata', () => {
  const tracks = [track('live', '晴天 (Live)'), track('exact', '晴天'), track('album', '三年二班')]
  assert.deepEqual(searchLocalTracks(tracks, '晴天').map(t => t.id), ['exact', 'live'])
  assert.deepEqual(searchLocalTracks(tracks, '周杰伦 晴天').map(t => t.id), ['exact', 'live'])
  assert.equal(searchLocalTracks(tracks, '叶惠美').length, 3)
  assert.equal(searchLocalTracks(tracks, '   ').length, 0)
  assert.equal(searchLocalTracks(tracks, '不存在').length, 0)
  assert.equal(tracks[0].id, 'live')
})

test('local search normalizes case and full width characters', () => {
  assert.equal(searchLocalTracks([track('a', 'ＡＢＣ')], 'abc').length, 1)
})
