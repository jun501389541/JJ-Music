import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mergeSearchPages } from './renderer/utils/search-merge.js'

/**
 * 在线搜索结果按页追加时的合并。
 *
 * 钉住两件事，第二件是重点：
 *  1. 主进程把五家平台按行交错合并，**没有跨页去重**，所以同一首歌在第 2、3 页
 *     重复出现是常态。追加必须按 `track.id` 去重。
 *  2. "整页都是重复"必须报 `added === 0`。调用方靠这个数字停止自动加载 ——
 *     列表长度没变，滚动到底的哨兵就还露在视口里，observer 会一直认为"到底了"，
 *     于是同一页被无限请求。这个条件线上数据构造不出来（要正好碰上一整页重复），
 *     所以它只能在这里钉住，不能指望探针跑出来。
 */
const song = (id, name = 'x') => ({ id, source: 'wy', name, singer: 's', interval: '03:00' })

test('跨页重复的歌不会被追加第二遍', () => {
  const first = mergeSearchPages([], [song('wy_1'), song('wy_2')])
  assert.equal(first.added, 2)
  const second = mergeSearchPages(first.list, [song('wy_2'), song('wy_3')])
  assert.deepEqual(second.list.map(t => t.id), ['wy_1', 'wy_2', 'wy_3'])
  assert.equal(second.added, 1)
})

test('整页都是重复 → added 为 0，列表长度不变（这是停止自动加载的信号）', () => {
  const existing = [song('wy_1'), song('wy_2')]
  const again = mergeSearchPages(existing, [song('wy_2'), song('wy_1')])
  assert.equal(again.added, 0)
  assert.equal(again.list.length, 2)
  assert.deepEqual(again.list.map(t => t.id), ['wy_1', 'wy_2'])
})

test('同一页内部自己重复也只收一条', () => {
  const page = mergeSearchPages([], [song('wy_9'), song('wy_9'), song('wy_8')])
  assert.deepEqual(page.list.map(t => t.id), ['wy_9', 'wy_8'])
  assert.equal(page.added, 2)
})

test('空页不制造假增长，也不破坏已有顺序', () => {
  const existing = [song('a'), song('b')]
  const empty = mergeSearchPages(existing, [])
  assert.equal(empty.added, 0)
  assert.deepEqual(empty.list.map(t => t.id), ['a', 'b'])
  // 已有列表不被就地改写：调用方在 Vue 响应式里用它
  assert.equal(existing.length, 2)
})

test('首屏（已有为空）走同一条路径，不留一个 null 洞', () => {
  const first = mergeSearchPages([], [song('wy_1')])
  assert.equal(first.list.length, 1)
  assert.ok(first.list[0], '首条不能是 undefined')
})
