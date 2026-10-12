import assert from 'node:assert/strict'
import { test } from 'node:test'
import { matchRecording, recordingCandidates } from './renderer/utils/recording-match.js'
import { resolveOnlinePlayback, ResolutionError, resolutionCacheKey } from './renderer/utils/online-resolver.js'

const song = (source = 'tx', extra = {}) => ({ id: `${source}_one`, source, name: '光年之外', singer: '歌手甲、歌手乙', interval: '03:20', ...extra })
const result = (quality, extra = {}) => ({ url: 'https://example.test/audio', quality, providerId: 'stable', providerName: 'test', providerVersion: 'v1', ...extra })
function fixture(overrides = {}) {
  const calls = []
  return {
    calls,
    options: {
      track: song(), preferred: 'flac', signal: new AbortController().signal,
      platforms: async () => ['tx', 'wy'],
      search: async source => { calls.push(`search:${source}`); return [song(source)] },
      url: async (track, quality) => { calls.push(`${track.source}:${quality}`); return result(quality) },
      ...overrides
    }
  }
}

test('recording matching normalizes artist order, full-width text and punctuation', () => {
  assert.equal(matchRecording(song('tx', { name: 'Ｓｏｎｇ（正式版）' }), song('wy', { name: 'Song (正式版)', singer: '歌手乙 / 歌手甲', interval: '03:24' })), true)
})
test('different recording versions and incomplete durations never match automatically', () => {
  for (const suffix of ['Live', '伴奏', 'Cover', 'Remix', 'Demo', 'Acoustic', 'Remastered', '日语版']) {
    assert.equal(matchRecording(song(), song('wy', { name: `光年之外 (${suffix})` })), false, suffix)
  }
  for (const interval of [undefined, '03:99', '03:26']) assert.equal(matchRecording(song(), song('wy', { interval })), false)
  assert.equal(matchRecording(song(), song('wy', { singer: '未知歌手' })), false)
})
test('album version evidence rejects re-recordings, conflicting editions and remaster years', () => {
  for (const [left, right] of [
    ['精选 (2018 Remaster)', '精选 (2024 重新录制)'],
    ['精选', '精选 (特别版)'], ['精选', '精选 (重录版)'],
    ['Album', "Album (Taylor’s Version)"],
    ['精选 (2018 Remaster)', '精选 (2024 Remaster)']
  ]) assert.equal(matchRecording(song('tx', { albumName: left }), song('wy', { albumName: right })), false, `${left} vs ${right}`)
  assert.equal(matchRecording(song('tx', { albumName: '原专辑' }), song('wy', { albumName: '普通精选' })), true)
})
test('matching candidates are bounded, deduplicated and prefer album agreement', () => {
  const base = song('tx', { albumName: '专辑一' })
  const list = [song('wy', { id: 'b', albumName: '专辑二' }), song('wy', { id: 'a', albumName: '专辑一' }), song('wy', { id: 'a', albumName: '专辑一' }), ...Array.from({length: 25}, (_, i) => song('wy', { id: `x${i}` }))]
  assert.equal(recordingCandidates(base, list).length, 3)
  assert.equal(recordingCandidates(base, list)[0].id, 'a')
})
test('another platform target tier wins before original platform lower tier', async () => {
  const f = fixture()
  f.options.url = async (track, quality) => {
    f.calls.push(`${track.source}:${quality}`)
    if (track.source === 'tx') throw new Error('unavailable')
    return result(quality)
  }
  const original = structuredClone(f.options.track)
  const resolved = await resolveOnlinePlayback(f.options)
  assert.deepEqual(f.calls, ['tx:flac', 'search:wy', 'wy:flac'])
  assert.equal(resolved.resource.actual.source, 'wy')
  assert.equal(resolved.resource.original.id, original.id)
  assert.equal(resolved.resource.specification.state, 'unverified')
  assert.deepEqual(f.options.track, original)
})
test('each lower tier restarts with original platform and never exceeds the target', async () => {
  const f = fixture({ preferred: '320k' })
  f.options.url = async (track, quality) => {
    f.calls.push(`${track.source}:${quality}`)
    if (quality !== '128k') throw new Error('unavailable')
    return result(quality)
  }
  const resolved = await resolveOnlinePlayback(f.options)
  assert.deepEqual(f.calls, ['tx:320k', 'search:wy', 'wy:320k', 'tx:128k'])
  assert.equal(resolved.resource.targetQuality, '320k')
  assert.equal(resolved.resource.resolvedQuality, '128k')
})
test('an early matching platform is resolved before searching a later slow platform', async () => {
  const f = fixture({ platforms: async () => ['tx', 'wy', 'mg'] })
  f.options.url = async (track, quality) => {
    if (track.source === 'tx') throw new Error('fail')
    return result(quality)
  }
  f.options.search = async source => {
    assert.equal(source, 'wy', 'mg must not delay the already usable wy candidate')
    return [song(source)]
  }
  assert.equal((await resolveOnlinePlayback(f.options)).resource.actual.source, 'wy')
})
test('a strict result returning a lower tier cannot end target-tier search', async () => {
  const f = fixture()
  f.options.url = async (track, quality) => track.source === 'tx' ? result('128k') : result(quality)
  assert.equal((await resolveOnlinePlayback(f.options)).resource.actual.source, 'wy')
})
test('bound and opaque tracks are not rebound to different instances or platforms', async () => {
  const f = fixture({ track: song('tx', { providerId: 'old-owner', providerData: { token: 'opaque' } }) })
  f.options.url = async () => { throw new Error('绑定实例 missing') }
  await assert.rejects(resolveOnlinePlayback(f.options), /绑定|missing/)
  assert.deepEqual(f.calls, [])
  const g = fixture({ track: song('tx', { providerData: { token: 'opaque' } }) })
  await assert.rejects(resolveOnlinePlayback(g.options), /私有参数/)
})
test('alternate requests use their own metadata instead of original private fields', async () => {
  const f = fixture()
  f.options.track.meta = { songmid: 'original-id' }
  f.options.search = async source => [song(source, { meta: { songmid: 'candidate-id' } })]
  f.options.url = async (track, quality) => {
    if (track.source === 'tx') throw new Error('fail')
    assert.deepEqual(track.meta, { songmid: 'candidate-id' })
    return result(quality)
  }
  await resolveOnlinePlayback(f.options)
})
test('abort ends a hung request and cancels its transport signal', async () => {
  const controller = new AbortController()
  let requestSignal
  const f = fixture({ signal: controller.signal, url: async (_track, _quality, signal) => { requestSignal = signal; return new Promise(() => {}) } })
  const pending = resolveOnlinePlayback(f.options)
  await new Promise(resolve => setImmediate(resolve))
  controller.abort()
  await assert.rejects(pending, error => error instanceof ResolutionError && error.reason === 'cancelled')
  assert.equal(requestSignal.aborted, true)
})
test('budget exhaustion cancels a hung request without beginning another candidate', async () => {
  let requestSignal, attempts = 0
  const f = fixture({ budgetMs: 10, url: async (_track, _quality, signal) => { attempts++; requestSignal = signal; return new Promise(() => {}) } })
  await assert.rejects(resolveOnlinePlayback(f.options), error => error.reason === 'timeout')
  assert.equal(attempts, 1)
  assert.equal(requestSignal.aborted, true)
})
test('cache identity includes match data and opaque parameters as well as requested tier', () => {
  const base = song()
  const key = resolutionCacheKey(base, 'flac')
  for (const changed of [song('tx', { singer: 'other' }), song('tx', { meta: { hash: 'new' } }), song('tx', { providerData: { a: 1 } })]) {
    assert.notEqual(resolutionCacheKey(changed, 'flac'), key)
  }
  assert.notEqual(resolutionCacheKey(base, '128k'), key)
})
