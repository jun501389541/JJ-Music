import assert from 'node:assert/strict'
import { test } from 'node:test'
import { lyricFromOtherPlatforms, lyricSourceOrder, resolveOnlineLyricByOrder } from './library/lyric-service.js'

const music = { id: 'wy_1', name: '晴天', singer: '周杰伦', source: 'wy', albumName: '叶惠美', interval: '04:29', meta: { songmid: '1' } }

test('在线歌词来源顺序：首选在前、可关兜底、手动指定时只问那一种', () => {
  assert.deepEqual(lyricSourceOrder('platform', true), ['platform', 'script', 'search'])
  assert.deepEqual(lyricSourceOrder('search', true), ['search', 'script', 'platform'])
  // 关掉兜底 = 只问首选。用户说"我就要平台接口"时不该再被别的来源覆盖。
  assert.deepEqual(lyricSourceOrder('script', false), ['script'])
  assert.deepEqual(lyricSourceOrder('script', true, 'search'), ['search'])
  assert.deepEqual(lyricSourceOrder('script', false, 'platform'), ['platform'])
})

test('逐个来源试到有人给出歌词为止，抛错的一家不算答案', async () => {
  const asked = []
  const steps = {
    script: async () => { asked.push('script'); throw new Error('音源未实现 lyric') },
    platform: async () => { asked.push('platform'); return { lyric: '   ' } },
    search: async () => { asked.push('search'); return { lyric: '[00:01.00]第一行' } }
  }
  const result = await resolveOnlineLyricByOrder(lyricSourceOrder('script', true), steps)
  assert.deepEqual(asked, ['script', 'platform', 'search'])
  assert.equal(result.asset.provider, 'search')
  assert.equal(result.lyric.lyric, '[00:01.00]第一行')

  const quiet = { script: async () => ({ lyric: '' }), platform: async () => ({ lyric: '' }), search: async () => ({ lyric: '' }) }
  assert.equal((await resolveOnlineLyricByOrder(['script', 'platform'], quiet)).asset, null)
  // 首选就命中时，后面的来源根本不该被问。
  let calls = 0
  const hit = { script: async () => { calls++; return { lyric: 'x' } }, platform: async () => { calls++; return { lyric: 'y' } }, search: async () => { calls++; return { lyric: 'z' } } }
  assert.equal((await resolveOnlineLyricByOrder(['script', 'platform', 'search'], hit)).asset.provider, 'script')
  assert.equal(calls, 1)
})

test('跨平台匹配歌词：排除本平台、低分不要、拿到空歌词就继续找下一档', async () => {
  const seen = []
  const fetched = []
  const candidates = [
    { score: 0.42, music: { id: 'tx_low', source: 'tx', name: '晴天 (现场)', singer: '周杰伦', meta: {} } },
    { score: 0.71, music: { id: 'tx_empty', source: 'tx', name: '晴天', singer: '周杰伦', meta: {} } },
    { score: 0.66, music: { id: 'kw_ok', source: 'kw', name: '晴天', singer: '周杰伦', meta: {} } }
  ]
  const result = await lyricFromOtherPlatforms(music, {
    match: async (query, options) => { seen.push({ query, sources: options.sources }); return candidates },
    fetchLyric: async (target) => { fetched.push(target.id); return { lyric: target.id === 'kw_ok' ? '[00:00.00]天气很好' : '' } }
  })
  assert.equal(result.lyric, '[00:00.00]天气很好')
  // 网易云自己的行不能算"其他平台"。
  assert.deepEqual(seen[0].sources, ['tx', 'kw', 'kg', 'mg'])
  assert.equal(seen[0].query.name, '晴天')
  // 0.42 的那首"现场版"连歌词都不该去取。
  assert.deepEqual(fetched, ['tx_empty', 'kw_ok'])

  const failing = await lyricFromOtherPlatforms(music, { match: async () => { throw new Error('搜索失败') }, fetchLyric: async () => ({ lyric: '不该被取' }) })
  assert.equal(failing.lyric, '')
})
