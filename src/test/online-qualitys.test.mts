import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fetchNeteaseDetails, searchOnline } from './online/search.js'

/**
 * 网易云音质档的真实来源。
 *
 * 这一组存在的理由：徽标只是把 `meta.qualitys` 画出来，画得对不对完全取决于这份数据
 * 是不是真的。而 wy 的搜索行**以前是无条件声明 `128k/320k/flac`**（当时的注释说
 * "反正只用来试档位"）—— 徽标一上线，那句话就变成"每首网易云搜索结果都是无损"。
 * 所以钉住：档位只从详情接口的真实字段来，没给的档就是没有。
 */

/** 造一个 `/api/song/detail` 的回答。字段形状照实测样本（sqMusic=45.43 MB 那个）。 */
function detailResponse(songs) {
  return JSON.stringify({ songs })
}
const tier = (size) => ({ size, bitRate: 0, encodeUrl: '' })
const MB = 1024 * 1024

function stubFetch(handler) {
  const calls = []
  const original = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    calls.push(String(url))
    const body = handler(String(url))
    if (body instanceof Error) throw body
    return new Response(body, { status: 200, headers: { 'content-type': 'application/json' } })
  }
  return { calls, restore: () => { globalThis.fetch = original } }
}

test('detail 接口里有哪些档就是哪些档，192k 与 size=0 都不算', async () => {
  const stub = stubFetch(() => detailResponse([
    // 全四档 + 一个没有对应档位的 mMusic(192k)
    { id: 1, album: { picUrl: 'https://p3.music.163.com/a.jpg' }, lMusic: tier(4 * MB), mMusic: tier(6 * MB), hMusic: tier(10 * MB), sqMusic: tier(45 * MB) },
    // 只有 128k：徽标应当是「标准」，不是被抬到无损
    { id: 2, album: { picUrl: 'https://p3.music.163.com/b.jpg' }, lMusic: tier(4 * MB), hMusic: tier(0), sqMusic: null },
    // 一个档都没给：宁可什么都不显示
    { id: 3, album: { picUrl: 'https://p3.music.163.com/c.jpg' } },
    // Hi-Res
    { id: 4, album: {}, hrMusic: tier(41 * MB), sqMusic: tier(27 * MB) }
  ]))
  try {
    const found = await fetchNeteaseDetails([1, 2, 3, 4])
    assert.deepEqual(found.get(1).qualitys.map(q => q.type), ['128k', '320k', 'flac'], 'mMusic 没有对应档，丢弃而不是并进邻档')
    assert.equal(found.get(1).qualitys[2].size, '45.00 MB', 'size 是真字节数，口径与 buildQualitys 一致')
    assert.ok(found.get(1).picUrl.includes('param=300y300'), '封面仍然照旧带缩放参数')
    assert.deepEqual(found.get(2).qualitys.map(q => q.type), ['128k'], 'size=0 与 null 都不算可用档')
    assert.deepEqual(found.get(3).qualitys, [], '有封面但一档都没给：空数组（界面什么都不画），不是编一个')
    assert.deepEqual(found.get(4).qualitys.map(q => q.type), ['flac', 'flac24bit'])
  } finally { stub.restore() }
})

test('660 首一次开：每批 100 个 id，正好 7 个请求', async () => {
  const ids = Array.from({ length: 660 }, (_, i) => i + 1)
  const stub = stubFetch((url) => {
    const sent = JSON.parse(new URL('https://x' + url.slice(url.indexOf('?'))).searchParams.get('ids'))
    return detailResponse(sent.map(id => ({ id, album: {}, lMusic: tier(4 * MB) })))
  })
  try {
    const found = await fetchNeteaseDetails(ids)
    assert.equal(stub.calls.length, 7, '660/100 向上取整 = 7；请求数就是这一条的断言对象')
    assert.equal(found.size, 660)
    assert.ok(stub.calls.every(url => url.includes('music.163.com/api/song/detail')))
    assert.ok(stub.calls.every(url => url.includes('ids=')), '走批量 ids 参数，不是一首一发')
  } finally { stub.restore() }
})

test('详情接口挂了：静默空结果，不抛给界面', async () => {
  const stub = stubFetch(() => Error('HTTP 500 Internal Server Error'))
  try {
    const found = await fetchNeteaseDetails([1, 2, 3])
    assert.equal(found.size, 0)
    assert.equal(stub.calls.length, 1, '一个批次失败一次就够，不重试轰炸')
  } finally { stub.restore() }
})

/**
 * 搜索页那一行。以前它给每一首都写死三档，这条断言就是那句话的反面：
 * 搜索结果里的档位必须来自同一次详情请求，且**没有额外请求**（搜索页 20 首
 * 本来就为了封面调一次详情，音质搭这趟车）。
 */
test('wy 搜索结果带的是真实档位，而且一页只花一次详情请求', async () => {
  const songs = Array.from({ length: 20 }, (_, i) => ({ id: 100 + i, name: `t${i}`, duration: 200000, artists: [{ name: 's' }], album: { id: 1, name: 'a' } }))
  const stub = stubFetch((url) => {
    if (url.includes('/api/search/get/web')) {
      return JSON.stringify({ result: { songs, songCount: 20 } })
    }
    const sent = JSON.parse(new URL('https://x' + url.slice(url.indexOf('?'))).searchParams.get('ids'))
    // 100 号只有 128k，101 号有无损，其余什么都不给。
    return detailResponse(sent.map(id => id === 100 ? { id, album: { picUrl: 'https://p/a.jpg' }, lMusic: tier(4 * MB) }
      : id === 101 ? { id, album: { picUrl: 'https://p/b.jpg' }, lMusic: tier(4 * MB), sqMusic: tier(30 * MB) }
        : { id, album: { picUrl: 'https://p/c.jpg' } }))
  })
  try {
    const page = await searchOnline('wy', '测试', 1)
    assert.equal(page.list.length, 20)
    const byId = new Map(page.list.map(t => [t.id, t]))
    assert.deepEqual(byId.get('wy_100').meta.qualitys.map(q => q.type), ['128k'])
    assert.deepEqual(byId.get('wy_101').meta.qualitys.map(q => q.type), ['128k', 'flac'])
    assert.deepEqual(byId.get('wy_102').meta.qualitys, [], '接口没给档位的歌必须是空数组，不能是写死的三档')
    assert.equal(stub.calls.length, 2, '一次搜索 + 一次批量详情；徽标不该让搜索页多花请求')
    // 解析用的键必须还在：回填只往 meta 里加 qualitys。
    assert.equal(byId.get('wy_100').meta.songmid, '100')
  } finally { stub.restore() }
})
