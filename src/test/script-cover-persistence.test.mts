import assert from 'node:assert/strict'
import { test } from 'node:test'
import { stripScriptCoverData } from './shared/persisted-track.js'

test('script cover data URIs stay in memory but are omitted from persisted track snapshots', () => {
  const image = `data:image/png;base64,${Buffer.alloc(768 * 1024).toString('base64')}`
  const liveTrack = {
    id: 'kw_song',
    picUrl: image,
    assets: { cover: [{ origin: 'remote', provider: '音源脚本', at: 1 }] }
  }

  const persisted = stripScriptCoverData(liveTrack)

  assert.equal(liveTrack.picUrl, image, 'the live player keeps the cover it already loaded')
  assert.equal(persisted.picUrl, undefined)
  assert.ok(JSON.stringify(persisted).length < 1024, 'a large inline image must not enter saved queues or recent-played records')
})

test('ordinary remote covers and script covers that are URLs remain available after persistence', () => {
  const platformTrack = {
    id: 'kw_song',
    picUrl: 'data:image/png;base64,YQ==',
    assets: { cover: [{ origin: 'remote', provider: '平台搜索结果', at: 1 }] }
  }
  const scriptUrlTrack = {
    id: 'kw_song',
    picUrl: 'https://images.example.test/cover.jpg',
    assets: { cover: [{ origin: 'remote', provider: '音源脚本', at: 1 }] }
  }

  assert.equal(stripScriptCoverData(platformTrack).picUrl, platformTrack.picUrl)
  assert.equal(stripScriptCoverData(scriptUrlTrack).picUrl, scriptUrlTrack.picUrl)
})
