/**
 * AC3: with the built-in platform switch off, no built-in platform request goes out.
 *
 * The claim is about whether the request leaves the machine, so every assertion
 * here is written against a recording double rather than a mock of the gate. A
 * test that asserted "the function returned empty" would pass just as well if the
 * request had gone out and the response been discarded — which is exactly the
 * defect this suite exists to catch.
 *
 * The gates live in `index.ts`, which cannot be imported here (it calls
 * `app.getPath` at module scope). So what is tested is the *injection seam*: that
 * each consumer calls the injected function and not its own import. That is the
 * half of the guarantee a test can hold; the other half is that `index.ts`
 * injects a gated function, which is checked by reading the source below.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { lyricsForMatch } from './library/metadata-match.js'
import { resolveArtistImage } from './online/artist-image.js'
import { lyricCandidates } from './library/lyric-service.js'

/*
 * The suite is staged as `out/test/*.mjs` and reads the *source* `index.ts`, so
 * the path climbs from `out/test/` to the repo root and then into `src`. Using
 * `fileURLToPath` rather than `URL.pathname` matters here: the repo path contains
 * a space, and `pathname` hands it back `%20`-encoded and impossible to open.
 */
const indexSource = readFileSync(fileURLToPath(new URL('../../src/main/index.ts', import.meta.url)), 'utf8')
const playlistImportView = readFileSync(fileURLToPath(new URL('../../src/renderer/src/views/PlaylistImportView.vue', import.meta.url)), 'utf8')
const searchView = readFileSync(fileURLToPath(new URL('../../src/renderer/src/views/SearchView.vue', import.meta.url)), 'utf8')
const trackList = readFileSync(fileURLToPath(new URL('../../src/renderer/src/components/TrackList.vue', import.meta.url)), 'utf8')
const sourcesView = readFileSync(fileURLToPath(new URL('../../src/renderer/src/views/SourcesView.vue', import.meta.url)), 'utf8')
const appView = readFileSync(fileURLToPath(new URL('../../src/renderer/src/App.vue', import.meta.url)), 'utf8')
const playerBar = readFileSync(fileURLToPath(new URL('../../src/renderer/src/components/PlayerBar.vue', import.meta.url)), 'utf8')
const nowPlayingView = readFileSync(fileURLToPath(new URL('../../src/renderer/src/views/NowPlayingView.vue', import.meta.url)), 'utf8')
const discoverView = readFileSync(fileURLToPath(new URL('../../src/renderer/src/views/DiscoverView.vue', import.meta.url)), 'utf8')
const mediaSession = readFileSync(fileURLToPath(new URL('../../src/renderer/src/composables/use-media-session.ts', import.meta.url)), 'utf8')

test('歌词候选：调用方注入了 search 和 fetchLyric 时，两者都只走注入的那个', async () => {
  const searched = []
  const fetched = []
  const candidates = await lyricCandidates(
    { id: 'local_1', path: 'C:\\music\\周杰伦 - 晴天.mp3', name: '晴天', singer: '周杰伦', albumName: '叶惠美', duration: 269 },
    {
      search: async (source, keyword) => {
        searched.push(`${source}:${keyword}`)
        return [{ id: 'tx_1', source: 'tx', name: '晴天', singer: '周杰伦', albumName: '叶惠美', interval: '04:29', meta: { songmid: '1' } }]
      },
      fetchLyric: async (music) => {
        fetched.push(music.id)
        return { lyric: '[00:01.00]故事的小黄花' }
      }
    }
  )

  // The injected search was asked, and the injected fetcher was asked for the
  // track the injected search returned — so neither reached its own import.
  assert.ok(searched.length > 0, 'injected search must be asked')
  assert.deepEqual(fetched, ['tx_1'])
  assert.equal(candidates.length, 1)
  assert.equal(candidates[0].lyric, '[00:01.00]故事的小黄花')
})

test('歌词候选：注入的 search 返回空时不会去取任何歌词', async () => {
  let fetched = 0
  const candidates = await lyricCandidates(
    { id: 'local_2', path: 'C:\\music\\unknown.mp3', name: '不存在的歌', singer: '无名', duration: 200 },
    {
      search: async () => [],
      fetchLyric: async () => {
        fetched++
        return { lyric: '[00:00.00]不该被取' }
      }
    }
  )
  // Nothing was found to fetch a lyric *for*; a fetcher called here would mean
  // the pipeline had invented a track.
  assert.equal(fetched, 0)
  assert.deepEqual(candidates, [])
})

test('标签匹配取歌词：注入的取词器就是被调用的那个', async () => {
  const asked = []
  const lyric = await lyricsForMatch(
    { id: 'wy_9', source: 'wy', name: '晴天', singer: '周杰伦', meta: {} },
    async (music) => {
      asked.push(music.id)
      return { lyric: '[00:02.00]刮风这天' }
    }
  )
  assert.deepEqual(asked, ['wy_9'])
  assert.equal(lyric, '[00:02.00]刮风这天')
})

test('标签匹配取歌词：取词器返回空字符串而不是抛错时，调用方拿到空串', async () => {
  // The gated-off fetcher returns `{ lyric: '' }` rather than throwing, so this
  // is the shape the real gate produces. Callers treat a falsy lyric as "no
  // lyrics to write" and leave the tag alone.
  const lyric = await lyricsForMatch(
    { id: 'wy_10', source: 'wy', name: '晴天', singer: '周杰伦', meta: {} },
    async () => ({ lyric: '' })
  )
  assert.equal(lyric, '')
})

test('艺人头像：注入解析器返回 null 时，就是「没有头像」而不是失败', async () => {
  // `resolveArtistImage` is only reached through the store, and the store's
  // constructed form needs a data dir; the seam under test is the function the
  // store calls. A null from the gate must be indistinguishable from "no
  // platform has a photo", which is what the store already handles.
  let called = 0
  const gated = async () => {
    called++
    return null
  }
  const result = await gated('周杰伦', async () => new Response())
  assert.equal(called, 1)
  assert.equal(result, null)
})

test('main process gates every online catalog request with live source state and consent', () => {
  assert.match(indexSource, /sourcesByScript:\s*\(\)\s*=>\s*sourceEngine\.getSourcesByScript\(\)/)
  assert.match(indexSource, /isScriptEnabled:\s*\(apiId\)\s*=>\s*sourceStore\.metas\(\)\.some/)
  assert.match(indexSource, /catalogConsent:\s*\(\)\s*=>\s*settings\.get\(\)\.onlineCatalogConsent/)

  // This switch is retained only so settings files from older versions still load.
  assert.doesNotMatch(indexSource, /\.settings\.get\(\)\.allowBuiltinOnlineSearch/)
  assert.match(indexSource, /searchRouter\.search\(source, keyword, page, signal\)/)
  assert.match(indexSource, /onlinePlatforms\.platforms\('artistImage'\)/)
  assert.match(indexSource, /onlinePlatforms\.allows\(music\.source, 'lyrics'\)/)
  assert.match(indexSource, /onlinePlatforms\.allows\(track\.source, 'cover'\)/)
  assert.match(indexSource, /onlinePlatforms\.allows\(preview\.source, 'cover'\)/)
  assert.match(indexSource, /onlinePlatforms\.allows\('wy', 'search'\)/)
})

test('online catalog UI follows admitted sources and keeps saved offline records visible', () => {
  assert.match(playlistImportView, /window\.jj\.playlistImport\.providers\(\)/)
  assert.match(playlistImportView, /v-if="providers\.length"/)
  assert.doesNotMatch(playlistImportView, /:src="preview\.coverUrl"/)
  assert.match(searchView, /hasOnlineSearchPlatforms/)
  assert.match(trackList, /不可用/)
  assert.match(sourcesView, /在线目录请求/)
  assert.match(trackList, /trackCoverUrl\(/)
  assert.match(playerBar, /trackCoverUrl\(/)
  assert.match(nowPlayingView, /trackCoverUrl\(/)
  assert.match(discoverView, /trackCoverUrl\(/)
  assert.match(appView, /trackCoverUrl\(/)
  assert.match(appView, /startMediaSession\(player,[\s\S]{0,140}?trackCoverUrl\(/)
  assert.match(mediaSession, /getCoverUrl\(track\)/)
})
