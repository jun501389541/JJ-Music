import assert from 'node:assert/strict'
import { test } from 'node:test'
import { HOT_WORD_LIMIT, HOT_WORD_SOURCES, HotWordSource } from './online/hot-words.js'

/**
 * 热门搜索词。
 *
 * 这里的词全是编的占位串：测的是"能不能从各家自己的结构里认出来"，不是线上到底在搜什么。
 * 响应骨架照抄 2026-09-22 本机实测到的形状（QQ 是 data.hotkey[].k，网易云是
 * result.allMatch[].keyword），因为字段名一旦改回去，这页就会静默变成空白行。
 */

function qqPayload(words) {
  return JSON.stringify({ code: 0, data: { hotkey: words.map((word, index) => ({ k: word, n: 1000 - index })) } })
}

function neteasePayload(words) {
  return JSON.stringify({ code: 200, result: { allMatch: words.map((word) => ({ keyword: word, type: 1 })) } })
}

/** 记录每家的请求次数，好把"缓存生效"和"每次都去问"区分开。 */
function recorder(responses) {
  const calls = []
  const fetchText = async (url) => {
    calls.push(url)
    const key = Object.keys(responses).find((name) => url.includes(name))
    if (!key) throw new Error(`没有配对的端点：${url}`)
    const value = responses[key]
    if (value instanceof Error) throw value
    return value
  }
  return { calls, fetchText }
}

test('QQ 与网易云各自的形状都能读出词来', async () => {
  const spy = recorder({ 'gethotkey': qqPayload(['甲', '乙', '丙']) })
  const source = new HotWordSource(spy.fetchText)
  const tx = await source.words('tx')
  assert.deepEqual(tx.map((word) => word.text), ['甲', '乙', '丙'])
  assert.ok(tx.every((word) => word.source === 'tx'), '每条都要说得出是哪一家给的')

  const wy = await new HotWordSource(recorder({ 'suggest/keyword': neteasePayload(['丁']) }).fetchText).words('wy')
  assert.deepEqual(wy.map((word) => word.text), ['丁'])
})

test('JSONP 包一层也认得，非词的行一律丢掉', async () => {
  const jsonp = `callback(${qqPayload(['甲'])});`
  const one = await new HotWordSource(async () => jsonp).words('tx')
  assert.deepEqual(one.map((word) => word.text), ['甲'])

  // 脏数据：null、对象、空串、以及长得不像搜索词的超长串。
  const dirty = JSON.stringify({ code: 0, data: { hotkey: [null, { k: '' }, { k: '   ' }, { k: '甲' }, { k: 'x'.repeat(80) }, '乙'] } })
  const cleaned = await new HotWordSource(async () => dirty).words('tx')
  assert.deepEqual(cleaned.map((word) => word.text), ['甲', '乙'], '只留能直接放进搜索框的短串')

  const broken = await new HotWordSource(async () => '<html>网关错误</html>').words('tx')
  assert.deepEqual(broken, [], '拿不到 JSON 就当没有，而不是把 HTML 当词')
})

test('「全部」是各家轮流上，不是第一家占满', async () => {
  const txWords = Array.from({ length: 10 }, (_, index) => `T${index}`)
  const wyWords = Array.from({ length: 10 }, (_, index) => `W${index}`)
  const source = new HotWordSource(async (url) => (url.includes('gethotkey') ? qqPayload(txWords) : neteasePayload(wyWords)))
  const merged = await source.words('all')
  assert.equal(merged.length, HOT_WORD_LIMIT, `最多就这么多行，多了就成了列表而不是提示：${merged.length}`)
  const fromTx = merged.filter((word) => word.source === 'tx').length
  assert.ok(fromTx >= 3 && fromTx <= merged.length - 3, `两家都该露脸，实际 QQ ${fromTx} / 网易云 ${merged.length - fromTx}`)
  assert.equal(new Set(merged.map((word) => word.text)).size, merged.length, '不许出现重复行')
})

test('同一个词两家都给，只留一条', async () => {
  const source = new HotWordSource(async (url) => (url.includes('gethotkey') ? qqPayload(['共同']) : neteasePayload(['共同', '独有'])))
  const merged = await source.words('all')
  assert.deepEqual(merged.map((word) => word.text), ['共同', '独有'])
})

test('没有端点的平台答空，不报错也不去请求', async () => {
  let asked = 0
  const source = new HotWordSource(async () => { asked += 1; return '{}' })
  assert.deepEqual(await source.words('mg'), [])
  assert.deepEqual(await source.words('kg'), [])
  assert.deepEqual(await source.words('kw'), [])
  assert.equal(asked, 0, '没有端点就不该发请求')
  assert.deepEqual(await source.words('乱七八糟'), [])
  assert.ok(HOT_WORD_SOURCES.join() === 'tx,wy', 'UI 靠这个列表决定哪些页签会显示热搜')
})

test('一次结果两家页签共用，失败的也不反复重试', async () => {
  const spy = recorder({ 'gethotkey': qqPayload(['甲']) })
  const source = new HotWordSource(spy.fetchText)
  await source.words('tx')
  await source.words('tx')
  assert.equal(spy.calls.length, 1, '十分钟内问过就不该再问')

  const failing = recorder({ 'gethotkey': new Error('connect timeout') })
  const offline = new HotWordSource(failing.fetchText)
  assert.deepEqual(await offline.words('tx'), [], '拿不到就当这一家没有热搜')
  assert.deepEqual(await offline.words('tx'), [])
  assert.equal(failing.calls.length, 1, '失败也要有个冷却，别每次切页签都去撞一次')
})
