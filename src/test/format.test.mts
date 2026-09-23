import assert from 'node:assert/strict'
import { test } from 'node:test'
import { formatTime, bestQuality, qualityBadge } from './renderer/utils/format.js'

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

/**
 * 在线曲目的音质徽标。钉住三件事：
 * ①取的是**可用最高档**，而且按 QUALITY_ORDER 而不是数组顺序 —— 平台返回
 *   `[{flac},{128k}]` 和 `[{128k},{flac}]` 必须给同一个徽标，否则同一首歌在
 *   搜索结果里是 SQ、在歌单里是 标准，看着像数据坏了；
 * ②文案与本地徽标**逐字符相同**（`SQ` / `Hi-Res`），因为两种曲目会出现在同一列里；
 * ③没有可用档时是空串（界面据此什么都不画），不是「标准」也不是空徽标。
 */
test('最高档按档位顺序取，与平台返回的数组顺序无关', () => {
  assert.equal(bestQuality([{ type: '128k' }, { type: 'flac' }]), 'flac')
  assert.equal(bestQuality([{ type: 'flac' }, { type: '128k' }]), 'flac')
  assert.equal(bestQuality([{ type: 'flac24bit' }, { type: 'flac' }, { type: '320k' }]), 'flac24bit')
})

test('徽标文案与本地曲目同一套词', () => {
  assert.equal(qualityBadge([{ type: '128k' }]), '标准')
  assert.equal(qualityBadge([{ type: '320k' }]), 'HQ')
  assert.equal(qualityBadge([{ type: '128k' }, { type: 'flac' }]), 'SQ')
  assert.equal(qualityBadge([{ type: 'flac' }, { type: 'flac24bit' }]), 'Hi-Res')
  // 表里没有的档（atmos/master 在 QUALITY_ORDER 里但没有短名）回落到长名，
  // 而不是什么都不显示 —— 有档总比没档说得清楚。
  assert.equal(qualityBadge([{ type: 'atmos' }]), '全景声')
})

test('没有可用档位时返回空串，不编一个出来', () => {
  assert.equal(qualityBadge([]), '')
  assert.equal(qualityBadge(undefined), '')
  // 平台给了一堆我们不认识的档名时同样算"没有"：宁可少画一个徽标，
  // 也不要画一个没人能读懂的 `master`。
  assert.equal(qualityBadge([{ type: 'lMusic' }, { type: 'sqMusic' }]), '')
})
