import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const source = readFileSync(
  fileURLToPath(new URL('../../src/renderer/src/views/SearchView.vue', import.meta.url)),
  'utf8'
)

test('double-clicking either search result starts only the selected track', () => {
  const playAt = source.match(/async function playAt\(index: number\): Promise<void> \{([\s\S]*?)\n\}/)?.[1]

  assert.ok(playAt, 'SearchView must keep a single playAt entrypoint for local and online results')
  assert.match(playAt, /player\.playQueue\(\[track\],\s*0,/)
  assert.match(playAt, /singleTrackAudition:\s*true/)
  assert.doesNotMatch(playAt, /playQueue\(\s*results\.value/)
  assert.doesNotMatch(playAt, /playOnlineFromDefaultList/)
})

test('play all names and plays the currently loaded search results', () => {
  const playAll = source.match(/async function playAll\(\): Promise<void> \{([\s\S]*?)\n\}/)?.[1]

  assert.ok(playAll, 'SearchView must expose a playAll action')
  assert.match(playAll, /player\.playQueue\(results\.value,\s*0,/)
  assert.match(source, /播放全部（已加载\s*\{\{\s*results\.length\s*\}\}\s*首）/)
})

test('search UI no longer exposes catalog consent controls', () => {
  assert.doesNotMatch(source, /onlineCatalogConsent|在线目录设置|设置中开启在线目录请求/)
  assert.match(source, /在线搜索服务暂不可用/)
})
