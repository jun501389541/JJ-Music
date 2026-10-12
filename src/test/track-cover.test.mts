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

test('在线目录封面不要求播放音源', () => {
  assert.equal(trackCoverUrl(online), online.picUrl)
  assert.equal(trackCoverUrl({ ...online, source: 'unsupported' }), undefined)
})

test('持久化的脚本封面 URL 不会绕过主进程图片代理', () => {
  const persistedScriptCover = {
    ...online,
    picUrl: 'http://127.0.0.1:7890/private',
    assets: { cover: [{ origin: 'remote', provider: '音源脚本', at: 1 }] }
  }
  assert.equal(trackCoverUrl(persistedScriptCover), undefined)
  assert.equal(
    trackCoverUrl({
      ...persistedScriptCover,
      picUrl: 'data:image/png;base64,YQ=='
    }),
    'data:image/png;base64,YQ=='
  )
})

test('本地封面仍通过本地媒体协议读取', () => {
  const local = { id: 'local_1', path: 'C:\\Music\\song.mp3', name: '本地歌曲', coverPath: 'C:\\Music\\cover.jpg' }
  assert.equal(trackCoverUrl(local), trackCoverUrl(local))
  assert.ok(trackCoverUrl(local))
})

test('音源关闭后保留在线记录并报告当前不可用', () => {
  assert.equal(onlineTrackUnavailable(online, []), true)
  assert.equal(onlineTrackUnavailable(online, ['kw']), false)
  assert.equal(onlineTrackUnavailable({ id: 'local_2', path: 'C:\\Music\\local.mp3', name: '本地歌曲' }, []), false)
})
