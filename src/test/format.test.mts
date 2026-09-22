import assert from 'node:assert/strict'
import { test } from 'node:test'
import { formatTime } from './renderer/utils/format.js'

/**
 * 时长显示。钉住的是"同一列里两种来源必须一个形状"：本地曲目走 formatTime，
 * 在线曲目直接显示平台给的 `interval`（形如 03:47）。分钟不补零就会在同一列里
 * 出现 3:48 与 03:47 并排，等宽数字也救不回来。
 */
test('时长统一是 00:00 形状，分钟也要补零', () => {
  assert.equal(formatTime(228), '03:48')
  assert.equal(formatTime(9), '00:09')
  assert.equal(formatTime(60), '01:00')
  assert.equal(formatTime(3599), '59:59')
})

test('超过一小时换成 时:分:秒，秒仍然补零', () => {
  assert.equal(formatTime(3600), '1:00:00')
  assert.equal(formatTime(3723), '1:02:03')
  assert.equal(formatTime(86399), '23:59:59')
})

test('没有时长时是 00:00，不是 0:00、NaN 或空白', () => {
  assert.equal(formatTime(0), '00:00')
  assert.equal(formatTime(undefined), '00:00')
  assert.equal(formatTime(-5), '00:00')
  assert.equal(formatTime(Number.NaN), '00:00')
  assert.equal(formatTime(Number.POSITIVE_INFINITY), '00:00')
})
