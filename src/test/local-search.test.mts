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

/**
 * Pinyin matching (需求 11): what people type when the IME is off. Each case has
 * a counterpart that must return nothing, otherwise "found it" is satisfied by any
 * implementation that ignores the query.
 */
test('local search matches titles and artists by pinyin initials and full spelling', () => {
  const tracks = [track('qt', '晴天'), track('bn', '偏爱'), track('sh', '上海一九四三')]
  assert.deepEqual(searchLocalTracks(tracks, 'qt').map(t => t.id), ['qt'])
  assert.deepEqual(searchLocalTracks(tracks, 'qingtian').map(t => t.id), ['qt'])
  assert.deepEqual(searchLocalTracks(tracks, 'pa').map(t => t.id), ['bn'])
  // The fixture's artist is 周杰伦 on every row, so the abbreviation has to reach
  // the artist field, not just the title.
  assert.deepEqual(searchLocalTracks(tracks, 'zjl').map(t => t.id).length, 3)
  assert.equal(searchLocalTracks(tracks, 'zzzz').length, 0, 'a nonsense abbreviation finds nothing')
  assert.equal(searchLocalTracks(tracks, 'qqqqqq').length, 0)
})

test('pinyin matching never swallows a query that is not plain letters', () => {
  const tracks = [track('love', '热爱105°C你'), track('qt', '晴天')]
  assert.deepEqual(searchLocalTracks(tracks, '105').map(t => t.id), ['love'])
  assert.equal(searchLocalTracks(tracks, 'qt1').length, 0, 'letters plus digits is not an abbreviation')
  assert.equal(searchLocalTracks(tracks, 'a b').length, 0, 'spaced letters are two terms, not one syllable run')
})
