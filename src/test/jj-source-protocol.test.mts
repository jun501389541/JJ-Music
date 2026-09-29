import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  JJ_CAPABILITIES,
  JJ_LEGACY_COMPATIBLE_CAPABILITIES,
  JJ_SOURCE_API_VERSION,
  LX_ACTIONS
} from '../shared/types.js'
import {
  JJ_MAX_BOARDS,
  JJ_MAX_ERROR_MESSAGE_CHARS,
  JJ_MAX_LYRIC_CHARS,
  JJ_MAX_PAYLOAD_DEPTH,
  JJ_MAX_PROVIDER_DATA_KEYS,
  JJ_MAX_RESPONSE_BYTES,
  JJ_MAX_TEXT_CHARS,
  JJ_MAX_TRACKS_PER_PAGE,
  JJ_MAX_URL_CHARS,
  isCompatibleProtocolVersion,
  serialisedSize,
  validateCapabilityResponse,
  validateHotWords,
  validateLeaderboards,
  validateLyric,
  validatePlaylist,
  validateProviderInfo,
  validateRequest,
  validateTrack,
  validateTrackPage
} from './sources/jj-source-protocol.js'

/**
 * E1：`jj-source` 协议 + `providerId` 迁移的契约测试。
 *
 * 这一组存在的理由：E2 起，所有在线能力都交给第三方音源脚本，脚本返回的东西
 * 是**不可信输入**。如果这里的边界定错，坏处不会以「报错」的形式出现，而是以
 * 「界面显示正常、数据是错的」出现 —— 例如旧曲目被拒绝导致老用户歌库整段播放不了，
 * 或畸形字段一路写进持久化存储，之后再也没法区分是脚本的锅还是本机的锅。
 *
 * 所以钉三件事：
 *   1. 旧 LX 数据（无 `providerId`）必须原样可读、字段不丢不改名；
 *   2. 新曲目的 `providerId` 必须扛过序列化往返；
 *   3. 畸形 / 超大字段必须被**拒绝**，而且拒绝理由要指到具体字段。
 *
 * 另有一条容易被忽略的：能力枚举不能用 LX 的那三个名字。命名撞车的后果不是编译错误，
 * 而是某处 `supports(source, 'pic')` 继续走内置平台请求 —— 静默的旧行为。
 */

/* ------------------------------------------------------------------ *
 * 夹具：一个旧 LX 形状的曲目（本轮迁移前就存在的行）
 * ------------------------------------------------------------------ */

/**
 * 旧记录：只有 `source`，没有 `providerId`。
 *
 * 字段值照 `src/main/online/search.ts` 里 wy 搜索行的实例形状，`meta` 带齐
 * 解析用键（`songmid` 必须原样留下，`legacy-music-info.ts` 的 `toLegacyOnline`
 * 靠它拼脚本可见的 `songmid`）。
 */
function legacyRow() {
  return {
    id: 'wy_1901371647',
    name: '晴天',
    singer: '周杰伦',
    source: 'wy',
    interval: '04:29',
    albumName: '叶惠美',
    picUrl: 'https://p3.music.163.com/a.jpg',
    meta: {
      songmid: '1901371647',
      albumId: 12345,
      songId: 1901371647,
      qualitys: [{ type: '320k', size: '9.80 MB' }]
    }
  }
}

/* ------------------------------------------------------------------ *
 * 1. 旧 LX 数据原样可读（AC6）
 * ------------------------------------------------------------------ */

test('旧 LX 曲目不带 providerId 也必须被接受，字段一个字都不丢', () => {
  const original = legacyRow()
  const issues = []
  const track = validateTrack(original, 'list[0]', issues)

  assert.equal(issues.length, 0, '旧记录不是畸形数据：没有任何 issue')
  assert.ok(track, '必须返回曲目，而不是 undefined')

  // 逐字段比对，而不是只查 length：字段被改名（`img` ← `picUrl`）或类型被
  // 收紧（`songmid` 被强制成 string）都是这一条要挡的回归。
  assert.deepEqual(track, original, '解析结果与原记录逐字段相等')

  assert.equal(track.providerId, undefined, '旧记录没有 providerId，读出来也必须是 undefined')
  assert.equal('providerId' in track, false, '不能凭空补一个 providerId 键')
  assert.equal(track.meta.songmid, '1901371647', '解析用键 songmid 原样保留')
  assert.equal(track.meta.albumId, 12345, '数字类型的 albumId 不被改成字符串')
  assert.equal(track.id, 'wy_1901371647', 'id 的 ${source}_${songmid} 语义不变')
})

test('旧歌单里的旧曲目读一遍再序列化，字节等价', () => {
  const page = { list: [legacyRow()], page: 1, total: 1 }
  const result = validateTrackPage(page)
  assert.equal(result.ok, true)

  // 往返：校验后再序列化，与原始记录的形状等价 —— 只比对既有键，因为校验器
  // 不会替旧记录新增键。
  const round = JSON.parse(JSON.stringify(result.data))
  assert.deepEqual(round.list[0], legacyRow(), '往返之后旧字段没有被重命名或丢弃')
})

/* ------------------------------------------------------------------ *
 * 2. providerId 扛过序列化往返（E1 核心数据迁移点）
 * ------------------------------------------------------------------ */

test('新曲目重启后仍带 providerId，且重启前后是同一个值', () => {
  const fresh = { ...legacyRow(), providerId: 'user_api_2', providerData: { url: 'https://x/y' } }
  const result = validateTrackPage({ list: [fresh], page: 1 })
  assert.equal(result.ok, true)
  assert.equal(result.data.list[0].providerId, 'user_api_2')

  // 「重启」= 写盘再读回。JSON 往返是持久化的实际语义，只要这一步丢了
  // providerId，重启后就会退化成按 source 猜音源的分支 —— 同平台装两个音源
  // 时正是会播错脚本的那种失败。
  const reloaded = JSON.parse(JSON.stringify(result.data))
  assert.equal(reloaded.list[0].providerId, 'user_api_2', '重启后 providerId 保持')
  assert.deepEqual(reloaded.list[0].providerData, { url: 'https://x/y' }, 'providerData 一并保留')

  // 旧记录与新记录必须在同一份列表里共存，这是迁移期唯一的真实状态。
  const mixed = validateTrackPage({ list: [legacyRow(), fresh], page: 1 })
  assert.equal(mixed.ok, true)
  assert.equal(mixed.data.list.length, 2)
  assert.equal(mixed.data.list[0].providerId, undefined, '旧行仍然没有 providerId')
  assert.equal(mixed.data.list[1].providerId, 'user_api_2', '新行保留自己的音源归属')
})

/* ------------------------------------------------------------------ *
 * 3. 畸形 / 超大字段被拒绝
 * ------------------------------------------------------------------ */

test('超过单页曲目数上限的返回被整体拒绝', () => {
  const many = { list: Array.from({ length: JJ_MAX_TRACKS_PER_PAGE + 1 }, () => legacyRow()), page: 1 }
  const result = validateTrackPage(many)
  assert.equal(result.ok, false)
  assert.equal(result.error.code, 'invalidRequest')
  assert.match(result.error.message, /list/, '拒绝理由要指到 list 字段，而不是只说“不合法”')

  // 边界的另一侧：正好等于上限必须通过，否则上限就是个差一错误。
  const exact = { list: Array.from({ length: JJ_MAX_TRACKS_PER_PAGE }, () => legacyRow()), page: 1 }
  assert.equal(validateTrackPage(exact).ok, true, '正好到上限不算超限')
})

test('超过响应字节上限的返回被拒绝，且不必逐字段走完', () => {
  const huge = {
    list: [legacyRow()],
    page: 1,
    // 单字段撑爆整个响应：这是脚本最容易失控的形态（把整张专辑塞进 meta）。
    padding: 'x'.repeat(JJ_MAX_RESPONSE_BYTES + 1)
  }
  assert.ok(serialisedSize(huge) > JJ_MAX_RESPONSE_BYTES)
  const result = validateTrackPage(huge)
  assert.equal(result.ok, false)
  assert.equal(result.error.code, 'invalidRequest')
})

test('超长文本 / 超长 URL / 超深嵌套分别被拒绝', () => {
  const issues = []
  assert.equal(
    validateTrack({ ...legacyRow(), name: 'x'.repeat(JJ_MAX_TEXT_CHARS + 1) }, 't', issues),
    undefined,
    '超长 name 不能通过'
  )
  assert.match(issues[0].reason, /characters/)

  const urlIssues = []
  assert.equal(
    validateTrack({ ...legacyRow(), picUrl: 'https://a/' + 'y'.repeat(JJ_MAX_URL_CHARS) }, 't', urlIssues),
    undefined,
    '超长 URL 不能通过（长度上限在本模块，安全性由 url-guard 负责）'
  )

  // 深层嵌套走 providerData：递归遍历必须有深度上限，否则栈溢出。
  let deep = { v: 1 }
  for (let i = 0; i < JJ_MAX_PAYLOAD_DEPTH + 2; i++) deep = { nested: deep }
  const deepIssues = []
  assert.equal(
    validateTrack({ ...legacyRow(), providerData: deep }, 't', deepIssues),
    undefined,
    '超过深度上限的 providerData 不能通过'
  )
  assert.match(deepIssues[0].reason, /nesting/)
})

test('providerData 键数超限被拒绝', () => {
  const data = Object.fromEntries(
    Array.from({ length: JJ_MAX_PROVIDER_DATA_KEYS + 1 }, (_, i) => [`k${i}`, i])
  )
  const issues = []
  assert.equal(validateTrack({ ...legacyRow(), providerData: data }, 't', issues), undefined)
  assert.match(issues[0].reason, /keys/)
})

test('id 与 source 不一致的曲目被拒绝，因为它会破坏持久化键', () => {
  const issues = []
  const bad = { ...legacyRow(), source: 'tx' }
  assert.equal(validateTrack(bad, 't', issues), undefined, 'id=wy_... 却声明 source=tx，不能通过')
  assert.match(issues[0].reason, /must start with "tx_"/)
})

test('缺字段 / 类型不对的曲目被拒绝，而不是被补默认值', () => {
  const noName = validateTrack({ ...legacyRow(), name: undefined }, 't', [])
  assert.equal(noName, undefined)

  const numericName = validateTrack({ ...legacyRow(), name: 123 }, 't', [])
  assert.equal(numericName, undefined, '数字 title 不能被强转成字符串')

  const nullMeta = validateTrack({ ...legacyRow(), meta: null }, 't', [])
  assert.ok(nullMeta, 'meta 缺失/null 是合法状态：最小脚本不提供平台 id')
  assert.deepEqual(nullMeta.meta, {}, 'meta 归一化成空对象')
})

test('一页里个别坏行被丢弃，其余 19 首照常返回', () => {
  const bad = { ...legacyRow(), name: 123 }
  const good = legacyRow()
  const result = validateTrackPage({ list: [bad, good], page: 1 })
  // 这是有意的取舍：一首歌的 title 类型不对，不该让整页搜索结果变成错误页。
  assert.equal(result.ok, true, '单行错误不升级为整页失败')
  assert.equal(result.data.list.length, 1, '坏行被丢弃，好行留下')
  assert.equal(result.data.list[0].name, '晴天')
})

test('非对象 / 非数组的顶层返回被拒绝', () => {
  assert.equal(validateTrackPage(null).ok, false)
  assert.equal(validateTrackPage('boom').ok, false)
  assert.equal(validateTrackPage({ list: 'not-an-array', page: 1 }).ok, false)
  assert.equal(validateTrackPage({ list: [], page: 0 }).ok, false, 'page 从 1 开始')
  assert.equal(validateTrackPage({ list: [], page: 1.5 }).ok, false, 'page 必须是整数')
  assert.equal(validateTrackPage({ list: [], page: 1 }).ok, true, '空结果是合法的（平台确实没有内容）')
})

test('其余能力各自的畸形返回被拒绝', () => {
  assert.equal(validateLyric({ lyric: 'x'.repeat(JJ_MAX_LYRIC_CHARS + 1) }).ok, false, '超长歌词被拒绝')
  assert.equal(validateLyric({ lyric: '' }).ok, true, '空歌词是合法的：这首歌就是没有词')
  assert.equal(validateLyric({}).ok, false, '没有 lyric 字段才是畸形')

  assert.equal(validateHotWords({ list: ['a', 1] }).ok, false, '热词必须是字符串数组')
  assert.equal(validateHotWords({ list: ['a', 'b'] }).ok, true)

  assert.equal(
    validateLeaderboards({ list: Array.from({ length: JJ_MAX_BOARDS + 1 }, (_, i) => ({ id: `b${i}`, name: 'n' })) }).ok,
    false,
    '榜单数量超限被拒绝'
  )
  assert.equal(validateLeaderboards({ list: [{ id: 'b', name: 'n' }] }).ok, true)

  assert.equal(validatePlaylist({ id: 'p', name: 'n' }).ok, true)
  assert.equal(validatePlaylist({ id: 'p' }).ok, false, '歌单必须有名字')
})

test('错误消息被截断，不会把脚本的整段日志塞进界面', () => {
  // 页面级的畸形（page 非法）走 error.message；行级的畸形走 droppedIssues。
  // 两条路径的文本都必须受长度约束，因为前者直接进界面。
  const badPage = validateTrackPage({ list: [legacyRow()], page: 'first' })
  assert.equal(badPage.ok, false)
  assert.ok(badPage.error.message.length <= JJ_MAX_ERROR_MESSAGE_CHARS, '消息长度受控')

  // 行级的丢弃理由只记路径与原因，不引用脚本内容，因此天然短。
  const dropped = validateTrackPage({
    list: [{ ...legacyRow(), name: 'x'.repeat(JJ_MAX_TEXT_CHARS + 1) }],
    page: 1
  })
  assert.equal(dropped.ok, true, '单个超长字段丢弃该行，而不是整页失败')
  assert.equal(dropped.data.list.length, 0)
  assert.equal(dropped.data.droppedIssues.length, 1, '丢了一行就要留下证据')
  assert.match(dropped.data.droppedIssues[0].path, /list\[0\]\.name/, '理由要指到具体字段')
})

/* ------------------------------------------------------------------ *
 * 4. 能力枚举：新旧分离
 * ------------------------------------------------------------------ */

test('能力枚举与 LX 动作集不相交，杜绝命名撞车', () => {
  const lx = new Set(LX_ACTIONS)
  for (const capability of JJ_CAPABILITIES) {
    assert.equal(
      lx.has(capability),
      false,
      `能力名 "${capability}" 与 LX 动作同名：某处 supports(source, '${capability}') 会静默走回内置平台请求`
    )
  }
  // LX 三个动作仍是原样，本轮不新增也不改名 —— 旧脚本靠它初始化。
  assert.deepEqual([...LX_ACTIONS], ['musicUrl', 'lyric', 'pic'])
})

test('能力枚举已定稿，不再反复增删', () => {
  // 枚举一旦发布就写进脚本，删名字等于让已发布的音源少一个能力。这条断言
  // 的作用是：改动枚举时必须显式改这里，改的人会看到自己在做破坏性变更。
  assert.deepEqual(
    [...JJ_CAPABILITIES],
    [
      'searchTracks',
      'getMusicUrl',
      'getLyric',
      'getPic',
      'getPlaylist',
      'getPlaylistTracks',
      'getLeaderboard',
      'getLeaderboardTracks',
      'getHotWords',
      'getArtistImage',
      'matchMetadata'
    ]
  )
})

test('旧 LX 动作与新能力的对应关系被显式记录', () => {
  assert.deepEqual(JJ_LEGACY_COMPATIBLE_CAPABILITIES, {
    getMusicUrl: 'musicUrl',
    getLyric: 'lyric',
    getPic: 'pic'
  })
  // 对应表里的新名字必须真的在枚举里。
  for (const capability of Object.keys(JJ_LEGACY_COMPATIBLE_CAPABILITIES)) {
    assert.ok(JJ_CAPABILITIES.includes(capability), `${capability} 必须在 JJ_CAPABILITIES 里`)
  }
})

test('协议版本独立于 lx.version，只有主版本需要一致', () => {
  assert.equal(JJ_SOURCE_API_VERSION, '1.0.0', 'jj-source 自己的版本号，与 2.0.0 无关')
  assert.equal(isCompatibleProtocolVersion('1.0.0'), true)
  assert.equal(isCompatibleProtocolVersion('1.1.0'), true, '同主版本内向后兼容：未知能力被忽略而不是拒绝')
  assert.equal(isCompatibleProtocolVersion('2.0.0'), false, '2.x 不能假设兼容，必须拒绝')
  assert.equal(isCompatibleProtocolVersion('garbage'), false)
})

test('脚本声明未知能力时被忽略而不是导致初始化失败', () => {
  const result = validateProviderInfo({
    version: '1.1.0',
    capabilities: ['searchTracks', 'somethingFromTheFuture'],
    sources: ['kw']
  })
  assert.equal(result.ok, true, '未来版本脚本仍应可用')
  assert.deepEqual(result.data.capabilities, ['searchTracks'], '未知能力被丢掉，已知能力保留')
  assert.deepEqual(result.data.sources, ['kw'])
})

test('拒绝一个 2.x 脚本时，消息里同时给出两个版本号', () => {
  const result = validateProviderInfo({ version: '2.0.0', capabilities: [], sources: [] })
  assert.equal(result.ok, false)
  assert.equal(result.error.code, 'notSupported')
  assert.match(result.error.message, /2\.0\.0/, '要说清脚本声明的版本')
  assert.match(result.error.message, /1\.0\.0/, '也要说清本机支持的版本')
})

test('请求在发出前被校验：没有 providerId 就无法路由', () => {
  const missing = validateRequest({ requestKey: 'r1', capability: 'searchTracks', payload: {} })
  assert.equal(missing.ok, false, '缺少 providerId 的请求不能发出去')
  assert.match(missing.error.message, /providerId/)

  const unknown = validateRequest({ requestKey: 'r1', providerId: 'p', capability: 'nope', payload: {} })
  assert.equal(unknown.ok, false, '未定义的能力名被拒绝')

  const ok = validateRequest({ requestKey: 'r1', providerId: 'user_api_1', capability: 'getLyric', payload: { id: 'wy_1' } })
  assert.equal(ok.ok, true)
  assert.equal(ok.data.providerId, 'user_api_1')
})

test('能力响应分发：每个能力都落到对应的校验器，未知能力拒绝而非放行', () => {
  // 分发器的意义是 E2 加新能力时不能忘记校验：default 分支必须是拒绝。
  assert.equal(validateCapabilityResponse('getHotWords', { list: ['a'] }).ok, true)
  assert.equal(validateCapabilityResponse('getHotWords', { list: [1] }).ok, false)
  assert.equal(validateCapabilityResponse('getPic', { url: 'https://a/b.jpg' }).ok, true)
  assert.equal(validateCapabilityResponse('getPic', {}).ok, false)
  assert.equal(validateCapabilityResponse('nope', {}).ok, false, '未知能力必须拒绝，不能透传')
})
