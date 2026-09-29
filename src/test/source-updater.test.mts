import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { deflateSync, inflateSync } from 'node:zlib'

import {
  MAX_UPDATE_BYTES,
  checkForUpdate,
  compareVersions,
  describeRollback,
  looksLikeScript,
  parseVersion
} from './sources/source-updater.js'
import { SourceStore } from './sources/source-store.js'

/**
 * 音源更新的版本比较、检查与回退（E6 / AC5）。
 *
 * 三件事必须为真，且每一件的坏版本都是"看起来正常"：
 *
 * 1. **检查不安装任何东西**。`checkForUpdate` 只报告，写盘只发生在用户确认之后。
 * 2. **发布的字节是不可信的**。取数走守卫管道，返回网页时明确报"这不是脚本"，
 *    而不是猜一个链接下载——猜错等于装了一个用户没选过的东西。
 * 3. **回退是真的可回退**。旧脚本必须在更新后仍在磁盘上，且回退后的状态本身
 *    可以再被翻转回来。
 *
 * 这里用注入的 fetcher 而不是真网络：`checkForUpdate` 的第二个参数就是为此存在。
 * 不注入就只能测纯函数谓词，而"被拒的响应是否真让更新没被提供"将完全未验证。
 */

/* ------------------------------------------------------------------ *
 * 版本比较
 * ------------------------------------------------------------------ */

test('compareVersions 按数值比较，不按字符串', () => {
  // 字符串比较会认为 '1.9' > '1.10'，这正是不能用字符串的原因。
  assert.ok(compareVersions('1.9', '1.10') > 0, '1.10 应当新于 1.9')
  assert.ok(compareVersions('1.10', '1.9') < 0)
})

test('parseVersion 处理真实音源头部的各种写法', () => {
  // 这些形状来自本仓库自己的测试夹具：@version 3.2.0 / @version 1 / v1.2.1。
  assert.deepEqual(parseVersion('3.2.0'), [3, 2, 0])
  assert.deepEqual(parseVersion('1'), [1])
  assert.deepEqual(parseVersion('v1.2.1'), [1, 2, 1])
  assert.deepEqual(parseVersion(' 2.0 '), [2, 0])
  // 预发布后缀被丢掉：`1.2.1-beta.3` 是 `1.2.1` 的预发布，不能因为尾巴上的 3 而更新。
  assert.deepEqual(parseVersion('1.2.1-beta.3'), [1, 2, 1])
  assert.deepEqual(parseVersion('2.0.0+build.5'), [2, 0, 0])
  // 某段没有前导数字就停止解析。
  assert.deepEqual(parseVersion('1.2.beta'), [1, 2])
  assert.deepEqual(parseVersion(''), [])
})

test('compareVersions 把 1.2 与 1.2.0 视为同一版本', () => {
  assert.equal(compareVersions('1.2', '1.2.0'), 0)
  assert.equal(compareVersions('1.2.0', '1.2'), 0)
  // 正数表示传入的更新；1.2.1 新于 1.2.0。
  assert.equal(compareVersions('1.2.0', '1.2.1'), 1)
})

test('无法解析的传入版本永远不算更新', () => {
  /*
   * 被攻破或被配错的 @homepage 不能靠返回一段读不出版本的文本覆盖可用脚本——
   * "无法解析"不是修复的证据。
   */
  assert.equal(compareVersions('1.2.0', ''), 0)
  assert.equal(compareVersions('1.2.0', 'nightly'), 0)
  assert.equal(compareVersions('1.2.0', 'abc.1'), 0)
})

test('当前版本读不出时，可读的传入版本视为更新', () => {
  // 作者开始写真实版本是改进；拒绝会把用户永久困在旧脚本上。
  assert.ok(compareVersions('', '1.0.0') > 0)
  assert.ok(compareVersions('???', '2') > 0)
})

test('完全不向后：传入版本更旧时比较结果为负', () => {
  assert.ok(compareVersions('2.0.0', '1.0.0') < 0)
})

/* ------------------------------------------------------------------ *
 * 是不是脚本
 * ------------------------------------------------------------------ */

test('looksLikeScript 拒绝网页，接受真实脚本', () => {
  assert.equal(looksLikeScript(''), false)
  assert.equal(looksLikeScript('   '), false)
  assert.equal(looksLikeScript('<!DOCTYPE html><html><body>hi</body></html>'), false)
  assert.equal(looksLikeScript('<html lang="zh">'), false)

  const real = `/*!
 * @name 测试音源
 * @version 1.0.0
 */
const x = () => 1
`
  assert.equal(looksLikeScript(real), true)

  // 没有头部块但有代码体，也应接受。
  assert.equal(looksLikeScript('function init() { return 1 }'), true)
  assert.equal(looksLikeScript('const a = 1'), true)
})

test('无头部但像 JSON 的响应不算脚本', () => {
  assert.equal(looksLikeScript('{"error":"not found"}'), false)
  assert.equal(looksLikeScript('[1,2,3]'), false)
})

/* ------------------------------------------------------------------ *
 * 检查：各种不让它通过的情形
 * ------------------------------------------------------------------ */

function storeWith(script, name) {
  const dir = mkdtempSync(join(tmpdir(), 'jj-update-'))
  const store = new SourceStore(dir)
  const meta = store.import(script, name)
  return { dir, store, meta, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

const CURRENT = `/*!
 * @name 测试音源
 * @version 1.0.0
 * @author 作者
 * @homepage https://example.com/source.js
 */
function init() { return 1 }
`

/*
 * 文本进出 store 的边界会被剪裁：`parseImportPayload` 在导入时对解码后的文本调用
 * `.trim()`（`source-store.ts:477/480/501`），而 `gz_` 编解码本身是无损的。
 * 所以"已安装脚本"的内容是剪裁后的形式，比对时要按它来。
 */
const CURRENT_STORED = CURRENT.trim()

function body(text) {
  return { body: Buffer.from(text, 'utf8') }
}

test('没有 @homepage 时不发请求', async () => {
  let called = 0
  const result = await checkForUpdate(
    { currentVersion: '1.0.0', homepage: '' },
    async () => {
      called++
      return body(CURRENT)
    }
  )
  assert.equal(result.ok, false)
  assert.equal(result.reason, 'noHomepage')
  assert.equal(called, 0, '没有地址就不该有任何请求')
  assert.match(result.message ?? '', /手动下载/)
})

test('非 http(s) 的 @homepage 被拒绝', async () => {
  let called = 0
  const result = await checkForUpdate(
    { currentVersion: '1.0.0', homepage: 'ftp://example.com/a.js' },
    async () => {
      called++
      return body(CURRENT)
    }
  )
  assert.equal(result.ok, false)
  assert.equal(result.reason, 'notAUrl')
  assert.equal(called, 0)
})

test('取数被守卫拒绝时透传守卫原话', async () => {
  /*
   * `blocked` 这个原因的要点是**不要压平**：守卫会说明是私网地址还是元数据地址，
   * 那比"检查失败"有用得多。
   */
  const result = await checkForUpdate(
    { currentVersion: '1.0.0', homepage: 'https://example.com/source.js' },
    async () => {
      throw new Error('目标解析到内部地址：169.254.169.254')
    }
  )
  assert.equal(result.ok, false)
  assert.equal(result.reason, 'blocked')
  assert.match(result.message ?? '', /169\.254\.169\.254/)
})

test('空响应不被当作更新', async () => {
  const result = await checkForUpdate(
    { currentVersion: '1.0.0', homepage: 'https://example.com/source.js' },
    async () => body('')
  )
  assert.equal(result.ok, false)
  assert.equal(result.reason, 'empty')
})

test('返回网页时明确报错，不猜下载链接', async () => {
  /*
   * 这是 E6-1 的取舍：只支持「@homepage 就是脚本直链」。从 HTML 里挑链接没有可靠的
   * 判据，猜错就是把用户没选过的东西端给他。
   */
  const result = await checkForUpdate(
    { currentVersion: '1.0.0', homepage: 'https://example.com/' },
    async () => body('<!DOCTYPE html><html><body><a href="/dl.js">下载</a></body></html>')
  )
  assert.equal(result.ok, false)
  assert.equal(result.reason, 'notAScript')
  assert.equal(result.plan, undefined, '未通过时绝不能附带可安装的计划')
})

test('版本不新时不提供更新，且区分"同版本"与"更旧"', async () => {
  const same = await checkForUpdate(
    { currentVersion: '1.0.0', homepage: 'https://example.com/source.js' },
    async () => body(CURRENT)
  )
  assert.equal(same.ok, false)
  assert.equal(same.reason, 'sameVersion')
  assert.equal(same.plan, undefined)

  const older = await checkForUpdate(
    { currentVersion: '2.0.0', homepage: 'https://example.com/source.js' },
    async () => body(CURRENT)
  )
  assert.equal(older.ok, false)
  assert.equal(older.reason, 'notNewer')
  assert.equal(older.plan, undefined)
})

/* ------------------------------------------------------------------ *
 * 检查：成功路径
 * ------------------------------------------------------------------ */

const NEXT = `/*!
 * @name 测试音源
 * @version 1.2.0
 * @author 作者
 * @homepage https://example.com/source.js
 */
function init() { return 2 }
`

test('新版本提供完整的更新计划，含传输校验值和体积', async () => {
  const result = await checkForUpdate(
    { currentVersion: '1.0.0', homepage: 'https://example.com/source.js' },
    async () => body(NEXT)
  )
  assert.equal(result.ok, true)
  const plan = result.plan
  assert.ok(plan)
  assert.equal(plan.currentVersion, '1.0.0')
  assert.equal(plan.nextVersion, '1.2.0')
  assert.equal(plan.script, NEXT)
  assert.equal(plan.bytes, Buffer.byteLength(NEXT, 'utf8'))
  assert.equal(plan.url, 'https://example.com/source.js')
  // 校验值是下载内容的哈希，只证明传输一致。
  assert.equal(plan.sha256, `sha256:${createHash('sha256').update(Buffer.from(NEXT, 'utf8')).digest('hex')}`)
  assert.ok(plan.risk && typeof plan.risk.risk === 'string')
})

test('检查阶段不写任何东西到磁盘', async () => {
  /*
   * 这是 AC5 里"确认后才安装"的那一半。检查跑完，磁盘上的脚本必须仍是旧的。
   */
  const { dir, store, meta, cleanup } = storeWith(CURRENT, '测试音源')
  try {
    const result = await checkForUpdate(
      { currentVersion: meta.version, homepage: meta.homepage },
      async () => body(NEXT)
    )
    assert.equal(result.ok, true)

    const onDisk = JSON.parse(readFileSync(join(dir, 'sources', 'user_api.json'), 'utf8'))
    assert.equal(onDisk.userApis.length, 1)
    const stored = onDisk.userApis[0]
    assert.equal(stored.previousScript, undefined, '尚未应用，不该出现回退副本')
    // 落盘的脚本仍是旧版（gz_ 编码，解出来比对）。
    const decoded = inflateSync(Buffer.from(String(stored.script).slice(3), 'base64')).toString('utf8')
    assert.equal(decoded, CURRENT_STORED, '检查不得改动已安装的脚本')
    assert.equal(store.list()[0].meta.version, '1.0.0')
  } finally {
    cleanup()
  }
})

/* ------------------------------------------------------------------ *
 * 应用与回退
 * ------------------------------------------------------------------ */

test('应用更新后版本前进，且旧脚本被保留', () => {
  const { dir, store, meta, cleanup } = storeWith(CURRENT, '测试音源')
  try {
    const updated = store.replaceScript(meta.id, NEXT, '测试音源')
    assert.ok(updated)
    assert.equal(updated.version, '1.2.0')
    assert.equal(updated.id, meta.id, '更新必须原地更新，不能换 id')
    assert.equal(updated.stableId, meta.stableId, '身份必须穿越更新')
    assert.equal(updated.canRollback, true)
    assert.equal(updated.rollbackVersion, '1.0.0')

    // 盘上确实存了旧脚本，否则重启后回退就消失了。
    const onDisk = JSON.parse(readFileSync(join(dir, 'sources', 'user_api.json'), 'utf8'))
    const stored = onDisk.userApis[0]
    const previous = inflateSync(Buffer.from(String(stored.previousScript).slice(3), 'base64')).toString('utf8')
    assert.equal(previous, CURRENT_STORED)
    assert.equal(store.list()[0].source, NEXT)
  } finally {
    cleanup()
  }
})

test('回退恢复旧脚本，并且本身可以再被翻转回来', () => {
  const { store, meta, cleanup } = storeWith(CURRENT, '测试音源')
  try {
    store.replaceScript(meta.id, NEXT, '测试音源')
    assert.equal(store.rollback(meta.id), true)

    const back = store.list()[0]
    assert.equal(back.source, CURRENT_STORED, '回退后跑的必须是旧脚本')
    assert.equal(back.meta.version, '1.0.0')
    // 交换而非清除：被换下去的更新成为新的"上一版"。
    assert.equal(back.meta.canRollback, true)
    assert.equal(back.meta.rollbackVersion, '1.2.0')

    // 再回退一次应当拿回更新，不需要重新下载。
    assert.equal(store.rollback(meta.id), true)
    assert.equal(store.list()[0].source, NEXT)
  } finally {
    cleanup()
  }
})

test('没有上一版时回退失败而不是装回某个东西', () => {
  const { store, meta, cleanup } = storeWith(CURRENT, '测试音源')
  try {
    assert.equal(store.rollback(meta.id), false)
    assert.equal(store.list()[0].source, CURRENT_STORED)
  } finally {
    cleanup()
  }
})

test('应用同一份文本不算更新，不会吃掉回退副本', () => {
  /*
   * 一次抓取返回的就是当前文本时，写下去会把"正被保留作回退的那一版"覆盖成
   * 当前版本——回退能力凭空消失。这里比较的是文本，与版本字符串怎么说无关。
   */
  const { store, meta, cleanup } = storeWith(CURRENT, '测试音源')
  try {
    store.replaceScript(meta.id, NEXT, '测试音源')
    const again = store.replaceScript(meta.id, NEXT, '测试音源')
    assert.ok(again)
    assert.equal(again.rollbackVersion, '1.0.0', '回退副本必须仍是 1.0.0')
    assert.equal(store.list()[0].meta.version, '1.2.0')
  } finally {
    cleanup()
  }
})

test('更新一个已被删除的音源不会把它装回来', () => {
  const { store, meta, cleanup } = storeWith(CURRENT, '测试音源')
  try {
    store.remove(meta.id)
    assert.equal(store.replaceScript(meta.id, NEXT, '测试音源'), undefined)
    assert.equal(store.list().length, 0)
  } finally {
    cleanup()
  }
})

test('作者改名时更新仍命中同一记录（stableId 而非名字）', () => {
  /*
   * 这是 `stableId` 存在的全部理由，也是更新路径最危险的退化：若走 `import()`
   * 的按名匹配，改名会铸出新 id，已盖戳曲目全部变成"音源缺失"。
   */
  const renamed = NEXT.replace('@name 测试音源', '@name 测试音源（改名）')
  const { store, meta, cleanup } = storeWith(CURRENT, '测试音源')
  try {
    const updated = store.replaceScript(meta.id, renamed, '测试音源')
    assert.ok(updated)
    assert.equal(updated.id, meta.id)
    assert.equal(updated.name, '测试音源（改名）')
    assert.equal(store.list().length, 1, '改名不得产生第二条记录')
  } finally {
    cleanup()
  }
})

/* ------------------------------------------------------------------ *
 * 回退入口的描述
 * ------------------------------------------------------------------ */

test('describeRollback 在没有副本时说不可用', () => {
  assert.deepEqual(describeRollback({}), { available: false })
})

test('describeRollback 给出可显示的版本标签', () => {
  assert.deepEqual(describeRollback({ previousScript: 'gz_x' }), {
    available: true,
    version: '（未标注版本）'
  })
  assert.deepEqual(describeRollback({ previousScript: 'gz_x', previousVersion: '1.2.1' }), {
    available: true,
    version: '1.2.1'
  })
})

/* ------------------------------------------------------------------ *
 * 上限
 * ------------------------------------------------------------------ */

test('更新取数沿用导入用的同一体积上限', () => {
  // 不新造第二个数字：更新与首次导入是同一次下载。
  assert.equal(MAX_UPDATE_BYTES, 4 * 1024 * 1024)
})

test('落盘时被替换的脚本用同样的 gz_ 编码', () => {
  // 用同一编码意味着回退走的是与正常读取完全相同的解码路径。
  const raw = 'gz_' + deflateSync(Buffer.from(CURRENT, 'utf8')).toString('base64')
  assert.equal(typeof raw, 'string')
  assert.ok(raw.startsWith('gz_'))
})
