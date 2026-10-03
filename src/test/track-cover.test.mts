import assert from 'node:assert/strict'
import { test } from 'node:test'
import { onlineTrackUnavailable, trackCoverUrl } from './renderer/utils/track-cover.js'

const online = {
  id: 'kw_1',
  source: 'kw',
  name: '测试曲目',
  singer: '歌手',
  picUrl: 'https://img.kuwo.cn/cover.jpg'
}

test('在线封面需要同意目录请求并启用同平台音源', () => {
  assert.equal(trackCoverUrl(online, false, ['kw']), undefined)
  assert.equal(trackCoverUrl(online, true, ['tx']), undefined)
  assert.equal(trackCoverUrl(online, true, ['kw']), online.picUrl)
})

test('本地封面不受在线目录同意状态影响', () => {
  const local = { id: 'local_1', path: 'C:\\Music\\song.mp3', name: '本地歌曲', coverPath: 'C:\\Music\\cover.jpg' }
  assert.equal(trackCoverUrl(local, false, []), trackCoverUrl(local, true, []))
  assert.ok(trackCoverUrl(local, false, []))
})

test('音源关闭后保留在线记录并报告当前不可用', () => {
  assert.equal(onlineTrackUnavailable(online, []), true)
  assert.equal(onlineTrackUnavailable(online, ['kw']), false)
  assert.equal(onlineTrackUnavailable({ id: 'local_2', path: 'C:\\Music\\local.mp3', name: '本地歌曲' }, []), false)
})
