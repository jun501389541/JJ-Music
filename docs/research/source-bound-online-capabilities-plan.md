# 在线能力与音源绑定：实施 Plan

> 历史计划提示（2026-10-07）：本文对应旧完整音源方案，不能直接作为当前任务清单。后续规划以 [产品与播放开发规则](../PRODUCT_RULES.md) 为准，重新核实依赖与迁移范围。

日期：2026-09-28　状态：已评审定稿，可进入 E0/E1　上游：[Requirement Document](source-bound-online-capabilities.md)

本文件把需求文档第 8 节的 E1–E7 落成可执行的工程任务，并将第 9 节的四项决策固化为硬约束。**本文件定稿时未修改任何产品代码。**

## 1. 评审结论

- 需求文档第 9 节四项 Open Questions 全部采用原建议方案，见 §2。
- 新增 **E0**（权限与 URL 安全设计评审）为独立研究任务，与 E1 并行；E2 的硬前置门槛。
- 执行结构：

```
E0 权限与 URL 安全设计评审 ──┐
                          ├─→ E2 运行时/能力路由 ─→ E3 ─→ E4 ─→ E5
E1 协议 + providerId + 迁移 ─┘                          ↑
                                                       │
E6 版本检查/确认更新/回退（依赖 E1+E2）──────────────────┘
E7 迁移收口 + 发布 Review（依赖 E3–E6）
```

E0 与 E1 无重叠：E0 只定网络权限与校验边界，E1 只定类型与数据迁移，故可并行。

## 2. 固化的硬约束（原 §9 决策）

1. **来源信任**：完整音源首版只允许“用户主动导入 + 显式启用”，不建官方目录，不引入可信发布者机制。
2. **LX 兜底**：旧 LX 音源仅在曲目具备可验证的 LX 字段、且用户显式开启兜底时用于同平台播放；否则同音源失败即提示，或走宿主跨平台同曲匹配。
3. **榜单范围**：首版只做“按音源浏览榜单和曲目”，不做订阅与定时同步。
4. **网络权限**：单独立项 E0，与 E1 并行；E2 实现前必须逐条引用 E0 结论，不得从代码反推边界。

另沿用需求文档 §6：`lx.version` 保持 `2.0.0` 不被冒充；新增协议独立命名 `jj-source`；迁移期可有受控开关，最终默认关闭且无静默兜底。

## 3. 现状核实（Plan 依据的真实锚点）

| 事实 | 位置 |
| --- | --- |
| 子进程边界与 LX v2 协议版本 | `src/main/sources/source-engine.ts:60`（`CUSTOM_SOURCE_API_VERSION = '2.0.0'`）、`src/main/sources/source-host.ts` |
| 请求 20s / 初始化 15s / 单进程 512MB / 启动并发 4 | `src/main/sources/source-engine.ts:63-79` |
| 现有能力判定仅 `musicUrl` / `lyric` / `pic` | `src/shared/types.ts:53`（`LX_ACTIONS`）、`src/main/sources/source-engine.ts:887`（`supports(source, action)`） |
| 曲目只存平台 `source`，无音源实例 ID | `src/shared/types.ts:163-202`（`OnlineMusicInfo`，`id = \`${source}_${songmid}\``，另有 `meta`） |
| 旧存储为 LX `user_api.json` 原格式 + `enabled` 扩展 | `src/main/sources/source-store.ts:11-48` |
| 播放解析入口 | `src/main/index.ts:1829`（`IPC.musicUrl → sourceEngine.getMusicUrl`）、`src/main/sources/source-engine.ts:1039` |
| 搜索 / 热词 / 富化入口 | `src/main/index.ts:1724`、`:1738`、`:1759`、`:1795`、`:1749` |
| 歌单导入入口 | `src/main/index.ts:1961`、`:1968` |
| 宿主现有 URL 校验 | `src/main/online/url-guard.ts`（`assertPublicHttpUrl`） |
| 应用版本 | `package.json` = `0.3.0` |

**核心缺口**：`OnlineMusicInfo` 没有“产生该曲目的音源实例 ID”。同一平台装两个音源时，搜索来自 A、播放落到 B 会出现 ID 与签名参数不兼容。这是 E1 的核心数据迁移点。

## 4. 任务分解

每项完成独立 Review。

### E0. 权限与 URL 安全设计评审（研究，新增）

- **Goal**：在 `jj-source` 协议实现前，定死完整音源的网络能力边界与宿主校验点。
- **交付物**：`JJ-Music/docs/research/jj-source-permission-and-url-security.md`，每条结论附现状代码证据（具体 guard 函数与行号）。
- **必须回答**：
  1. 网络能力来源——沿用子进程现有能力（`restricted-launch.ts`），还是增加域名授权清单？若为清单，声明位置、存储格式与用户审阅方式。
  2. URL / 重定向边界——宿主 `url-guard.ts` 对音源返回的播放地址与图片拦到什么程度；跨域重定向、内网地址、`file://`、非 http(s) scheme 的分别处置。
  3. 响应体量上限——单个响应字节上限、歌单最大页数与曲目数、歌词与图片大小上限的**具体数值**（schema 校验需要确定数字，不接受“合理上限”）。
  4. 凭据边界——写明 `jj-source` 首版无 auth 能力，脚本不得以宿主身份发请求。
  5. 失败语义归属——超时 / 崩溃 / 不合法响应中，哪些归音源责任并对用户可见，哪些静默降级。
- **交付格式**：另附“输入 → 校验点 → 拒绝后的用户可见行为”对照表。
- **依赖**：无（与 E1 并行）。**下游**：E2 硬门槛；结论同时约束 E4 与 E6。

### E1. 协议、曲目来源与兼容数据模型

- **Goal / Scope**：定义版本化 `jj-source` 能力、请求/响应 schema、`providerId` 曲目来源与旧记录读取策略；**不接真实平台请求**。
- **建议位置**：`src/shared/types.ts`、源元数据类型、持久化曲目及歌单读取处。
- **Constraints**：`lx.version` 仍为 `2.0.0`；`user_api.json` 格式保持不变；`OnlineMusicInfo.id` 的 `${source}_${songmid}` 语义不得更改；`providerId` 为可选字段，旧数据缺失时必须可读。
- **交付接口**：能力表、标准曲目/歌单/榜单 DTO、迁移策略、供后续任务复用的契约测试夹具。
- **AC**：旧 LX 数据原样可读；新曲目重启后保留音源 ID；畸形/超大字段被拒绝。
- **Verify**：契约与迁移测试；`npm run typecheck`（node + web）。
- **待定**：能力枚举最终命名（候选 `searchTracks` / `getLyric` / `getPic` / `getPlaylist` / `getLeaderboard` / `getHotWords`）须在 E1 内一次定死并写入 schema。

### E2. 完整音源运行时、能力注册表与请求路由

- **Goal / Scope**：在现有子进程边界上增加独立协议加载、方法声明、请求取消/超时、响应校验与同音源路由；LX v2 原调用行为不变。
- **建议位置**：新增独立 `src/main/sources/jj-provider-engine.ts`；复用 `restricted-launch.ts`、`shutdown-guard.ts` 边界。
- **Constraints**：**实现前必须先引用 E0 结论**；内存与超时沿用现有量级（512MB / 20s / 初始化 15s）；脚本返回的 URL 必须过宿主 `url-guard.ts`。
- **交付接口**：`listCapabilities()`、按 `providerId` 调用能力、错误与健康状态、假音源开发样例。
- **AC**：AC1 / AC2 / AC4 的路由与故障条件。
- **Verify**：两个同平台假音源并行测试；`src/test/source-engine.test.mts` 全量回归不退化。

#### E2 开工评审定稿的三项决策（2026-09-28，用户逐条确认）

> 原 Plan 只写了"新增独立引擎、不改写 `source-engine.ts`"，未定这三项。它们会决定子进程数量、持久化契约与 E6 可行性，故在动笔前定死。

**决策 E2-1：抽公共子进程宿主，两引擎共用（用户第 1 条回复"接受吧"）。**
`source-engine.ts` 已拥有子进程池、受限令牌启动、文件式协议、心跳存活、崩溃处理、512MB 限额、启动并发 4。E2 若从零复刻，会产生**两套子进程生命周期管理**，而 E0 的 D5 失败语义（11 类失败的归因与可见性）必须在这两处保持一致 —— 分头维护必然漂移。故把上述能力抽为共享宿主，两个引擎共用。
理由补充：Plan 风险 1 本就主张"各任务内先做局部抽取"；此处是该主张的最小实例。代价是触及 `source-engine.ts`，与其"不改写"字面有出入 —— 但**是抽取而非重写**，其对外行为不变，其回归由 `src/test/source-engine.test.mts` 守住。

**决策 E2-2：一个脚本实例 = 一个子进程，新旧能力在该进程内共存（方案 A）。**
E1 的 `JJ_LEGACY_COMPATIBLE_CAPABILITIES` 允许脚本同时声明 LX 动作与 `jj` 能力。此时**不**为同一脚本文件启动两个进程。
理由：`source-engine.ts:5-19` 记录的事故（自防护混淆脚本 abort 进程导致应用永久无法启动）说明**进程边界的目的是隔离恶意/崩溃脚本，不是隔离协议**。同一脚本的两种协议入口跑在同一隔离盒内，隔离性毫无损失；而方案 B 会让新旧都支持的脚本吃双份内存与双份启动，`source-engine.ts:72-79` 明确警告过"一次 fork 21 个进程就会让健康脚本撞上初始化超时"。双倍内存买不到任何额外安全。

**决策 E2-3：`providerId` 复用 `StoredApi.id`，并把该 id 的稳定性补强（候选 3）。**
`providerId` **不新造字段**，直接取 `source-store.ts` 的 `StoredApi.id`（形如 `user_api_<ts>_<rand>`），存进 LX 忽略的扩展键，避免出现两个都像稳定 ID 的分裂来源。
现状证据与必要修正：
- `source-store.ts:127-128` 的 `upsert` 按 **name** 匹配已有记录，命中则沿用其 `id`；否则新生成。即 id 已具备"同名覆盖时保留"语义，但**依赖 name 相同** —— 用户改个名字重新导入，id 就变，落库曲目的 `providerId` 全部失效。
- `source-store.ts:34-43` 的 `StoredApi` 已有 `enabled`/`importedAt`/`lastError`/`quarantined` 四个 JJ 扩展键，文件头注释（`:14-15`）明确"LX ignores unknown keys"。**新增扩展键的路径已被走通**，候选 3 有现成先例。
- 故 E2 需在 E2 范围内做最小必要改动：新增一个稳定标识扩展键，使**改名导入也不再更换 id**。
为什么必须现在定：E6 的 Plan 原文已要求"现有的『同名覆盖』与最多 20 条规则**不能充当稳定 ID 与更新策略**"，却未说稳定 ID 长什么样。此结论同时支撑 AC2（同平台双音源不串用）、E6 的"更新后 id 不变、老歌不失效"与"按音源版本隔离缓存"三件事。

#### E2 顺带纳入的范围（原 Plan 未写，但归属 E2）

- **E0 缺口 G4**：`source-engine.ts:678-685` 的 IPC 响应载荷**无尺寸校验**（`pending.resolve(message.data)`），512MB 子进程限额保护不了主进程。E2 引入新协议正是加校验的时机，故并入 E2。
- **E2 验收必须显式记录 AC4 的残缺**：E0 已证实 `url-guard.ts` 非 DNS 感知（rebinding 可通过，`url-guard.ts:19-22`），且修复规则 U9 被推给 E4。E2 只能满足"每个 URL 与每一跳重定向都过守卫"这一层，**AC4 的 SSRF 部分在 E2 结束时事实上未完全满足**，不得被记为已达成。
- **跨音源兜底的口径**：保留 `requestWithFallback` 的"同平台兄弟音源依次尝试、第一个成功即返回"。**同平台兄弟兜底不算 D5 禁止的"静默回退"** —— D5 禁止的是回退到**内置平台请求**。此口径须写入代码注释。
- **假音源样例归属**：作为**测试夹具**放 `src/test/`，不作为产品内可导入的样例脚本 —— 后者会成为一个可被用户导入的真实脚本，需走 E0 的导入风险评级流程，超出 E2。
- **L7 榜单上限的交接**：E0 承认 L7（榜单页上限）借用了歌单的 5000，需 E3 用真实数据验证；而能力在 E1 定稿、使用方在 E5。此数字的**验证责任在 E3**，须写入 E3 任务说明，避免 E5 误以为已验。

#### E2 实施状态与暂停决定（2026-09-28）

**状态：实现主体已完成，验收按用户指示暂停，不视为通过。**

用户决定原文：「先暂停E2的验收，后面再修复，先往下执行」。故 E2 **不得记为已达成 AC1/AC2/AC4**；下游 E3 开工不以此为前置。

已落盘的改动（全部 `read` 后 `edit` 定点替换，未用 PowerShell 改写源码；`npx tsc -p tsconfig.node.json --noEmit` EXIT=0；文件编码校验 mojibake 0 / U+FFFD 0）：

| 文件 | 性质 | 说明 |
| --- | --- | --- |
| `src/shared/types.ts` | 改（E1 已合） | `JJ_SOURCE_API_VERSION = '1.0.0'`、`JJ_CAPABILITIES`（11 项）、`providerId?`/`providerData?`、JJ DTO 全集 |
| `src/main/sources/jj-source-protocol.ts` | 新增（E1） | 757 行；校验器与上限常量；**不含 URL/网络策略**（那是 E0/E4 职责） |
| `src/main/sources/source-runtime-host.ts` | 新增 | 从 `source-engine.ts` 抽出的共享子进程宿主；新增 `protocolInfo` 搬运与通用 `request<T>` |
| `src/main/sources/jj-provider-engine.ts` | 新增 | JJ 能力路由引擎；**任何失败都不回退内置平台请求**（AC3） |
| `src/main/sources/source-host.ts` | 改 | 单宿主双协议：按 `init.jj` 存在与否选择协议，`capabilityHandler` 优先于 `requestHandler` |
| `src/main/sources/source-store.ts` | 改 | 稳定标识扩展键（E2-3） |
| `tools/build-test.mjs` | 改 | 补 `source-runtime-host.ts`、`jj-provider-engine.ts` 两个入口，以及 E1 的 `jj-source-protocol.ts` |

**已修复的真实缺陷（fileSend 丢弃能力声明）**：`source-host.ts` 文件协议的 `ready` 分支原写 `...(init!.jj ? { jj: init!.jj } : {})`，把**初始化块**（`{version, apiId}`，无 `capabilities`）当作能力自描述回传；IPC 路径传的是 `jj.ready(info)`。win32 上 `supportsRestrictedLaunch()` 为 true，生产走文件协议，故 JJ 音源会注册失败。已改为 `...(message.jj !== undefined ? { jj: message.jj } : {})`。

**验收受阻的真实原因（环境，非代码）**：E2 套件无法在本沙箱跑通，因为**沙箱禁止 Node 派生 Node**。探针证据：`spawnSync(process.execPath, ...)` 返回 `status: null / error: EPERM`，而 `node -e "console.log('direct child ok')"` 正常 EXIT=0。子进程从未启动，`ready.json` 从未生成，15s「音源初始化超时」只是在不存在的进程上等到期。**修 fixture、修引擎、修宿主都不可能改变这一点。** 需在真实桌面环境跑 `npm run test` 才能取得 E2 证据。

**E2 结束时的已知缺口（不得被下游误记为已解决）**：

1. ~~**G4 未修**：`source-runtime-host.ts` 的 `'response'` 分支仍为 `pending.resolve(message.data)`，IPC 响应载荷**无尺寸校验**，512MB 子进程限额保护不了主进程。~~ → **已于 2026-09-28 清理，见下方「E2 缺口清理」。**
2. ~~**G6 未修**：`normaliseSources` 仍无条件采信脚本声明的 `actions`（`source-engine.ts:1213`），未按 E0 D1-a 校验能力名。~~ → **已于 2026-09-28 清理，见下方「E2 缺口清理」。**
3. **AC4 残缺**：E0 已证 `url-guard.ts` 非 DNS 感知（rebinding 可穿过，`url-guard.ts:19-22`），修复规则 U9 推给 E4。E2 只做到"每个 URL 与每一跳重定向都过守卫"这一层，**SSRF 部分事实上未满足**。**仍然开放。**
4. ~~**传输模式不可注入**：宿主走文件协议还是 IPC 由运行平台决定（`supportsRestrictedLaunch()`），无法在测试中强制指定，故 fileSend 那类 bug 无法被测试守住。~~ → **已于 2026-09-28 清理，见下方「E2 缺口清理」。**
5. ~~**`source-engine.ts` 尚未委托共享宿主**：E2-1 决策的抽取已完成、JJ 引擎已接入，但 LX 引擎仍在跑自己的子进程副本，两套生命周期管理并存的窗口**仍然开放**。~~ → **已于 2026-09-28 闭合，见下方「E2-3 本体：LX 引擎委托共享宿主」。**（此前 `normaliseSources` 的重复副本已先经「E2 缺口清理」第 4 条消除，那是同一类漂移的既成事实——而这一次暴露出的既有漂移更严重：宿主的 `fork` 分支 argv 长期是错的，见「E2-3 前置修复」。）

#### E2 缺口清理（2026-09-28，用户指示"先清 E2 缺口"）

五项缺口中的**四项**已闭合，**一项仍然开放**（AC4 的 SSRF 残缺属 E4，且已由 E4b 的「地址钉扎」部分闭合，见「E4b 实施状态」）。

**1. G4 已修 —— IPC 响应载荷加尺寸校验（两处传输，非一处）。**
新增 `MAX_RESPONSE_BYTES = 8 * 1024 * 1024` 与 `responseSize(value)`（`source-runtime-host.ts`），在 `'response'` 分支与**文件轮询分支**各加一次校验，超限以 `音源「X」返回的数据过大（约 N MB，上限 8 MB）` 拒绝。
- 取值理由：与 `online/cover-fetch.ts:69` 已有值一致，避免长成"第二个数字"；为 `url-guard.ts:116` safeFetch 默认 4 MiB 的 2 倍；真实载荷远低于此（200 曲目一页几百 KB）。
- **拒绝而非截断**：截断的页/歌词是静默错误数据（半页搜索结果、断行歌词），错数据比可见失败更糟。
- **关键点：文件传输必须一并修**。win32 上 `supportsRestrictedLaunch()` 为 true，生产走的正是文件路径；只修 IPC 会守住一条生产不走的路径。这是本次清理中第二次遇到"修了不跑的那条路"。

**2. G6 已修 —— `actions` 按名字校验，未知名剥离。**
`DISPATCHABLE_ACTIONS: readonly SourceAction[] = ['musicUrl', 'lyric', 'pic']`，`normaliseSources` 对声明列表做名字过滤；全为未知名时回落到 `['musicUrl']`（否则该平台会以"零能力"出现，报错变成"没有音源支持 musicUrl"而非真实原因）。依据 E0 决策 D1-a：`actions` 是**路由声明而非权限授予**，`'auth'` 至今全仓库零消费者。剥离而非拒绝启动，因为该值是建议性的，拒绝会打死"只是乐观"的健康音源。

**3. 传输模式已可注入。**
`SourceRuntimeHost` 构造函数新增第四个参数 `transport: 'auto' | 'file' | 'ipc' = 'auto'`，`JjProviderEngine` 同位置转发；`'auto'` 保持平台判断，生产行为零变化。测试用 `Reflect.get(host, 'transport')` 断言选择结果（`start()` 在本沙箱必然失败——禁止 Node 派生 Node——故不断言活子进程）。

**4. 清理中发现并修复的一处真实漂移（比原缺口更值得记录）。**
`normaliseSources` 与 `PLATFORM_NAMES` 在 `source-engine.ts` 与 `source-runtime-host.ts` **各有一份**：E2 抽取子进程机械时把它复制到了宿主（宿主注释明说 "Lives here rather than in `source-engine.ts`"），却**没有删除 `source-engine.ts` 里的旧副本**。后果：
- 宿主是自己调用的那一份（`source-runtime-host.ts:472`、`:588`），**旧副本完全死代码**；
- G6 的修复**先被应用到死副本上**，运行时零效果。发现方式是探针断言失败（`["musicUrl","auth","search","leaderboard","invented"]` 原样返回），而非读代码。
- 已删除 `source-engine.ts` 的副本及随它作废的 `DISPATCHABLE_ACTIONS`/`PLATFORM_NAMES`/`LX_QUALITIES` 导入，改为 `import { normaliseSources } from './source-runtime-host'` + `export { normaliseSources }`（再导出不引入本地绑定，故必须 import+export 两行，`source-engine.ts:498`/`:662` 两处调用才可见）。
- **教训**：这正是 E2-1「抽公共宿主、两引擎共用」要防的漂移，且它在抽取当天就发生了。**"两处都改"是错的答案，正确做法是消灭第二份定义。** 该风险同样适用于第 5 项（LX 引擎尚未委托共享宿主）。

**验证证据**：`npx tsc --noEmit -p tsconfig.node.json --composite false` → EXIT=0；`npx vue-tsc --noEmit -p tsconfig.web.json --composite false` → EXIT=0；回归套件 `jj-source-protocol` 21/21、`search-router` 14/14、`hot-words` 13/13、`lyrics-search` 56 passed / 0 failed、`search-cancel` 通过，全部 EXIT=0；新增的第 6 节（G4/G6/传输注入）断言 5/5 通过。
**未跑全量 `npm run test`**（沙箱禁止 Node 派生 Node，`spawnSync(process.execPath,...)` 仍返回 `EPERM`）。`jj-provider-engine.test.mts` 的第 1、2 节因此仍失败，原因与 m00770 暂停验收时相同——环境限制，非代码缺陷。

**一处既有欠账（不在 E2 范围，未改动，仅记录）**：`tools/build-test.mjs:124-129` 只产出 `out/test/source-host.cjs`（CJS），注释称「fork() executes it with `require`」；而生产依 `package.json` 的 `"type": "module"` 与 `electron-builder.yml` 的 `asarUnpack: out/main/source-host.js` 使用 **ESM 的 `out/main/source-host.js`**。该注释对本仓库不成立。

#### E3 开工评审定稿的两项决策（2026-09-28，用户逐条确认）

**决策 E3-1：E3 范围只含搜索与热词，不含歌词与歌单（用户选项 1）。**
AC3 的原文列举「内置平台搜索/热词/歌词/歌单请求不再发出」，横跨三个任务：搜索与热词属 E3，歌词属 E4，歌单属 E5。故 **AC3 在 E3 内不闭合**，E3 验收必须显式记录"歌词与歌单两处内置请求仍会发出"，不得记为 AC3 已达成。把四个模块拉进 E3 会与 Plan 的 E4/E5 划分冲突，并使任务不可评审。

**决策 E3-2：内置平台适配器保留，但置于**新增的、默认关闭**的显式开关之后（用户选项 2）。**
现状核实（本次实读，**这是 E3 最重要的发现**）：`src/main/online/search.ts:19-24` 的文件头声称内置适配器"off until the user turns it on in Settings"，**但该开关从不存在**：
- `src/main/store/settings-store.ts:15-45` 的 `DEFAULT_SETTINGS` 无任何平台/内置搜索开关；
- `src/shared/preferences.ts:2-48` 的 `UI_DEFAULTS` 同样没有；
- 全仓库 `src/**/*.ts` grep `builtin|builtIn|platformSearch|enablePlatform|allowPlatform|useBuiltin` → **零命中**。

即 `search.ts:710` 的 `PROVIDERS` 与 `hot-words.ts:124` 的 `ADAPTERS` 当前**无条件生效**：一个音源都没导入时，`IPC.musicSearch` 与 `IPC.musicHotWords` 仍会请求五家平台。这正是 AC3 禁止的状态。故 E3 不是"把默认值翻过来"，而是**补上文件头宣称了多年却从未存在的闸门**。

口径依据需求文档 §6「内置平台请求最终默认关闭且**无静默兜底**」：开关默认 `false`、用户手动开启后方可用 —— **「静默」是这句话的承重点**，默认关闭且由用户开启的兜底不构成静默兜底。保留适配器而非删除，是因为删除约 29000 字节既有代码不可逆，且无音源时搜索页将永久空白。

### E3. 搜索、热词与本地匹配迁移

- **Goal / Scope**：搜索标签、全平台聚合、热词缓存、本地元数据与歌词匹配改走 E2；最终移除默认内置平台请求。
- **建议位置**：`src/main/index.ts`（1724 / 1738 / 1759 / 1795 四处 IPC）、`src/main/online/search.ts`、`src/main/online/hot-words.ts`、`src/main/library/metadata-match.ts`、`src/main/library/lyric-service.ts`、`src/renderer/src/views/SearchView.vue`。
- **Constraints**：无完整音源时显示清晰空状态，不虚构结果、不静默回退内置请求。
- **AC**：AC1 / AC3；AC7 的本地匹配部分。
- **Verify**：假音源与网络请求拦截测试；空状态 UI 检查。
- **风险**：`search.ts` 停止服务后，`musicSearchAll` 的聚合必须由宿主完成，是本任务最大的行为变更点。

#### E3 实施状态（2026-09-28）

**状态：实现主体完成，测试与 typecheck 通过；AC3 按 E3-1 决策不闭合。**

##### 用户追加裁决：E2 接线并入 E3（选项 A）

E3 的评审发现 `JjProviderEngine` **未接线**——`src/main/index.ts:403` 的 `const instance: Services = {...}` 是唯一构造点，其中不含 `jjProviderEngine`，`Services` 接口（`:310-331`）也没有它。若不接线，真机上 `providersList()` 恒为空、`searchablePlatforms()` 恒为空，配合默认关闭的闸门会让**搜索页对所有人永久空白**——比现状更糟。

用户在 A/B/C 三案中选定 **A：先补接线，再路由**。故 E3 同时承担 E2 未完成的应用内接线。

##### 改动清单（全部 `read` 后 `edit` 定点替换；`npx tsc -p tsconfig.node.json --noEmit` 与 `npx vue-tsc -p tsconfig.web.json --noEmit` 均 EXIT=0）

| 文件 | 性质 | 说明 |
| --- | --- | --- |
| `src/main/online/search-router.ts` | 新增 | 路由核心，404 行；音源优先、内置仅在开关打开时可达、两者皆无则空状态 |
| `src/main/index.ts` | 改 | `Services` 增 `jjProviderEngine` 与 `searchRouter`；构造点接线；四处生命周期同步；四个 IPC 改走路由 |
| `src/main/sources/jj-provider-engine.ts` | 改 | 新增 `reload(apiId)`（stop→start；停着的脚本也会被启动，与 `SourceEngine.reload` 对齐） |
| `src/main/library/metadata-match.ts` | 改 | `matchMetadata` 的 search 改为**可注入**，默认保持旧行为 |
| `src/shared/types.ts` | 改 | `AppSettings.allowBuiltinOnlineSearch: boolean` |
| `src/main/store/settings-store.ts` | 改 | `DEFAULT_SETTINGS.allowBuiltinOnlineSearch = false` |
| `src/renderer/src/stores/defaults.ts` | 改 | 镜像同一字段（否则首帧显示为开） |
| `src/renderer/src/utils/settings-pages.ts` | 改 | 搜索页新增「使用内置平台搜索」开关 |
| `src/test/search-router.test.mts` | 新增 | 14 条用例，全绿 |
| `tools/build-test.mjs` | 改 | 补 `search-router.ts`、`hot-words.ts` 入口 |

##### 四个内置适配器调用点（全部已收敛到路由）

排查中发现路径不止 Plan 预想的两个：

1. `IPC.musicSearch`（`index.ts:1759`）→ `searchRouter.search`
2. `IPC.musicSearchAll`（`index.ts:1807`）→ `searchRouter.search('all', ...)`，**聚合改由路由完成**（这正是原 Plan 标的"本任务最大的行为变更点"）
3. `IPC.musicHotWords` → `searchRouter.hotWords`
4. **`IPC.matchMetadata`（`index.ts:2337`）→ 本地元数据匹配**：原先在 `metadata-match.ts:206` 直接调 `searchOnline`，是第四个未被预想的无闸门调用点，现已注入路由
5. `IPC.sourcesVerifyPlatform`（`index.ts:1721`）的平台探测：`search` 依赖改为**先走路由、仅在闸门打开时回落内置 `searchOnline`**，并在闸门关闭且路由无结果时返回空（探测自身的 `'unknown'` 语义会说明原因），使该用户主动诊断不再成为唯一漏网路径

##### 验证证据（本沙箱可跑的部分）

- `search-router` 套件 **14/14 通过，EXIT=0**。两条关键断言：闸门关闭且无合格音源时，**引擎与内置适配器均零请求**；音源失败返回 `providerFailed` 而不改走内置。
- 回归：`hot-words` 13/13（EXIT=0）、`lyrics-search` 56 passed / 0 failed（EXIT=0）、`search-cancel` 通过（EXIT=0）。
- `npx tsc -p tsconfig.node.json --noEmit` EXIT=0；`npx vue-tsc -p tsconfig.web.json --noEmit` EXIT=0。
- **未跑全量 `npm run test`**（沙箱禁止 Node 派生 Node，见 E2 段），故"是否有其它既有测试被打破"无直接证据；已跑的四套是受影响面最大的。

##### E3 结束时仍开放的事项（不得被下游误记为已解决）

1. **AC3 未闭合**（E3-1 决策）：歌词（E4）与歌单（E5）两处内置请求仍会发出。
2. **`allowBuiltinOnlineSearch` 的用户可见效果未在真机验证**：闸门逻辑有单测守住，但"界面上开关确实生效、空状态文案确实显示"需真机确认。
3. **AC3 的破坏性影响未在真机全量确认**：Plan §5 风险 2 点名的 `search-merge` / `online-qualitys` 等测试尚未逐套复核（沙箱限制同上）。
4. **`JjProviderEngine` 的进程行为仍无测试**：引擎虽已接线，但真机 fork 子进程的那条路仍只有 E2 的结论（本沙箱 EPERM）。
5. E2 段的五项缺口（G4、G6、AC4 残缺、传输模式不可注入、`source-engine.ts` 未委托共享宿主）**全部仍然开放**。

### E4. 播放、歌词、封面、下载与艺术家图像迁移

- **Goal / Scope**：保持搜索结果的音源归属直至播放与下载；在线歌词/封面/艺术家头像调用音源，宿主继续执行安全抓取与来源记录。
- **建议位置**：`src/main/index.ts`、`src/main/downloads/download-manager.ts`、`src/main/library/artist-images.ts`、`src/main/online/cover-fetch.ts`、`src/main/online/artist-image.ts`、`src/renderer/src/stores/player.ts`。
- **Constraints**：复用现有播放队列与下载器；**必须显式处理无 `providerId` 的旧 LX 曲目**（见 §5 风险 3）。
- **AC**：AC2 / AC4 / AC7 对应部分。
- **Verify**：同平台双音源、坏 URL / 图片、重启恢复、旧 LX 曲目回归。

#### E4 开工评审定稿的两项决策（2026-09-28，用户逐条确认）

**决策 E4-1：播放路径采用严格路由 + 显式报错（用户选项 1）。**
规则：曲目带 `providerId` → 走 JJ 引擎；`providerId` 为 `undefined` → 回落 LX 引擎（即今日行为，历史曲库零回归）；**`providerId` 指向已卸载/禁用的音源时报清晰错误并提示重新匹配，绝不静默改换音源**。错误文案沿用 E1 已定稿的 `找不到音源实例「X」。它可能已被卸载或禁用；可重新选择一个音源播放，或为该曲目重新匹配在线音源。`（`jj-provider-engine.ts:361`）。
理由：静默换音源会让用户以为原音源可用，而这正是 AC2「同平台多音源不串用 ID」要防的失败模式——两个脚本服务同一平台时，静默兜底等于把 A 的曲目交给 B 播放，签名与 ID 可能不兼容。Plan §5 风险 3 已把"老曲目播放回归"标为最高风险，故回落规则必须显式且只此一条。

**决策 E4-2：E4 只做迁移，AC4 的 SSRF 修复（规则 U9）拆为 E4b（用户选项 1）。**
理由：迁移是"接线与路由"，U9 是"网络层安全机制选型"（undici `lookup` 钩子 vs 解析后校验 + TOCTOU 窗口），两者性质不同、评审标准不同，塞进一个任务会让 AC4 的闭合状态含混。**故 E4 结束时 AC4 仍然残缺**，验收必须显式记录，不得记为已达成。

#### E4 现状核实（本次实读，决定了本任务的实际改动面）

**关键发现：`providerId` 已能跨越 IPC，缺口只在主进程不肯读它。**
`src/preload/index.ts:249-254` 的签名是 `url(source, musicInfo, quality)` / `lyric(source, musicInfo)` / `pic(source, musicInfo)` —— **整个 `musicInfo` 对象按值过 IPC**，而 `providerId` 是 `OnlineMusicInfo` 的字段（E1 定稿），故**归属信息在渲染层→主进程的路上没有丢失**。因此 E4 **不需要改 preload、不需要改 IPC 签名、不需要改渲染层**，改动集中在主进程的路由决策。

**五处播放侧调用点，目前全部绕过 `providerId`（全部只调 LX 引擎）：**

| 位置 | 现状 | 性质 |
| --- | --- | --- |
| `src/main/index.ts:395` | `onlineLyric` → `sourceEngine.getLyric(music.source, music, signal)` | 播放/下载/菜单三处共用的歌词入口 |
| `src/main/index.ts:405` | 下载 `resolve` → `sourceEngine.getMusicUrl(track.source, track, quality, true)` | |
| `src/main/index.ts:407` | 下载 `cover` → `sourceEngine.getPic(track.source, track)` | |
| `src/main/index.ts:1746` | 平台探测 `resolve` → `sourceEngine.getMusicUrl(id, track, '128k')` | 用户主动诊断 |
| `src/main/index.ts:1880-1896` | `IPC.musicUrl` / `musicLyric` / `musicPic` | 播放主路径 |

**`providerFor(track)` 已存在但无调用者**：`jj-provider-engine.ts:417-421` 实现完整，注释明确写 "the caller must decide … it is the caller that applies it"，但全仓库 grep 无调用点。E4 的主要工作就是补上这个调用者。

**Plan §5 风险 3 的准确表述**：`providerId` 为可选字段，**历史曲目永远为 `undefined`**，故回落分支不是边缘情况而是老用户的常态路径——必须与主路径同等对待，不能当作错误处理。

#### E4 实施状态（2026-09-28）

**新建 `src/main/sources/playback-router.ts`**（约 300 行）——播放归属路由的唯一决策点。
`PlaybackFailureReason = 'providerMissing'|'providerDead'|'unsupported'|'notFound'|'failed'`；`class PlaybackError extends Error`（带 `reason` 与 `providerId`）；`class PlaybackRouter` 方法：`ownerOf(track)`、`musicUrl(track, preferred, strict)`、`lyric(track, signal)`、`pic(track, signal)`、`supports(track, capability, source)`。

**所有方法取整个 `track`，不取 `(source, track)` 对**：归属在 track 上，把它拆开正是当初让 `providerId` 被丢掉的原因。签名本身无法忘记戳，比"记得传戳"可靠。

**规则（AC2 在播放侧的落地）**：
- 有 `providerId` → JJ 引擎。音源已消失 → `PlaybackError('providerMissing')`，**原文保留引擎消息**，绝不静默改换音源。
- 无 `providerId` → LX 引擎。**这是旧路径而非错误路径**：`providerId` 在首个版本之后才加入，先前保存的每一条曲目都没有它，那是既有用户曲库的常态。
- `musicUrl` 的 JJ 路径**不走质量阶梯**：能力响应是单一答案。LX 引擎里的阶梯存在是因为 LX 脚本宣传 `qualitys` 且常撒谎，逐档试值得那次往返。
- `getMusicUrl` 被协议校验器按 **track page** 校验（provider 可返回列表以支持跨源匹配），故取 `list[0].url`，回退顶层 `url`；**空列表报 `notFound`**——"provider 什么都没有"不得变成交给播放器的空 URL。
- 缺失歌词返回 `''`、缺失封面返回 `''`（与两个引擎及渲染层一致）；**音源缺失仍然抛**。
- `supports` 对旧曲目从 LX `actions` 回答，只有 `getMusicUrl`/`getLyric`/`getPic` 有 LX 等价物（`LEGACY_ACTION_FOR`）；搜索/热词/歌单/榜单**从来不是 LX 动作**，故对旧曲目一律 `false` 而非假装可以。

**改动文件（6 处）**：

| 文件 | 改动 |
| --- | --- |
| `src/main/sources/playback-router.ts` | 新建 |
| `src/main/index.ts` | 导入 + `Services.playbackRouter` + 构造 + 注入 `instance`；`onlineLyric` 的 `script` 分支、下载 `resolve`/`cover`、`IPC.musicUrl`/`musicLyric`/`musicPic`、`sourcesVerifyPlatform` 的 `resolve` 共 7 处改走路由 |
| `src/test/playback-router.test.mts` | 新建，15 条用例 |

**未改 preload、未改 IPC 签名、未改渲染层**：`src/preload/index.ts:249-254` 的三个方法把整个 `musicInfo` 对象按值过 IPC，`providerId` 是 `OnlineMusicInfo` 的字段，故归属信息在路上从未丢失——缺口只在主进程不肯读它。

**验证证据**：
- `playback-router`：**tests 15 / pass 15 / fail 0 / EXIT=0**。
- 回归：`search-router` 通过、`hot-words` 通过、`jj-source-protocol` 21/21，全部 EXIT=0。
- `npx tsc --noEmit -p tsconfig.node.json --composite false` → EXIT=0；`npx vue-tsc --noEmit -p tsconfig.web.json --composite false` → EXIT=0。
- 编码：四个改动文件 mojibake=0 / U+FFFD=0。
- **未跑全量 `npm run test`**：沙箱仍禁止 Node 派生 Node。

**E4 结束时仍开放的事项**：
1. **AC4 仍然残缺**（决策 E4-2）：`url-guard.ts:19-22` 承认 DNS rebinding 可穿过，规则 U9 拆为 E4b，未做。**E4 验收不得记为 AC4 达成。**
2. **艺术家头像未接入 `getArtistImage`**（用户裁决）：该路径以**艺术家名字**为键（`ArtistImageStore.entries` 按 name 索引并缓存到磁盘），不像曲目那样带 `providerId`；跨平台同名歌手本就可能是同一人，没有"归属"可路由。E4 保留现状（内置平台查询 + `safeFetchBytes` 逐跳守卫），把 `getArtistImage` 接线留给后续任务。
3. **AC7 未做端到端验证**：本次只测了路由决策层，没有真机跑「同平台双音源 → 搜索 → 播放 → 重启 → 再播放」的完整链路（沙箱无法 fork 子进程）。**其持久化那一半已由 `provenance-persistence.test.mts` 覆盖，见下。**
4. **下载器未额外改造**：Plan 列了 `download-manager.ts` 为建议位置，实读后确认它只接收 `resolve`/`cover` 回调，注入点已在 `index.ts` 完成，无需改其内部；这一点与 Plan 的"建议位置"有出入，记录在此。

#### E4 补充：AC7 的持久化面（2026-09-28）

新增 `src/test/provenance-persistence.test.mts`（9 条，`node:test` 风格，3 个 suite），补上 AC7 中**不受沙箱限制**的那一半：归属戳能否活过一次重启。

存在理由：`providerId` 的盖章发生在内存里（`jj-provider-engine.ts` 的 `stamp`），**那不能证明任何关于磁盘的事**。一个按字段重建行的 store，或一次把未知键"规范化"掉的迁移，都会静默丢掉它，而任何内存内测试都不会发现。故本套件走真实 store、真实文件，并**直接从磁盘把 JSON 读回来**断言，而不是相信进程内缓存。

覆盖：
- 带戳曲目存入歌单 → 新建 `PlaylistStore` 实例重读（即一次重启）→ 戳仍在。
- 戳**真的落盘**（从 `playlists.json` 解析后断言），且 `meta`（LX 面向脚本的形状）与戳并存不互斥。
- `providerData` 与戳同行存活。
- **无戳曲目读回后不得凭空多出 `providerId`**（补戳会让旧曲目假装属于某个音源，正是迁移最可能犯的错）。
- 手写一份旧版本格式的 `playlists.json`（全无 provider 字段）→ 能正常加载，且 `isLocalTrack` 仍判为在线曲目（即仍可经 LX 路径按 `source` 路由）。
- `toLegacyOnline` 产出的对象**不带戳**——LX 不认识它，且 LX 路径被选中恰恰是因为戳不存在。
- `id` 相同、`providerId` 不同的两条曲目按既有规则视为重复（`id` 是 `${source}_${songmid}`，两脚本服务同一平台时本就同 `id`，这正是 `providerId` 存在的理由；去重规则不得被"修"成按 provider 去重）。
- `reorder` / `removeTracks` 后戳不丢。
- 重启读回的曲目中，带戳者可用于归属路由、无戳者 `providerId === undefined`（即回落到 LX 路径）。

**验证证据**（补充至 E4 段）：
- `provenance-persistence`：**tests 9 / suites 3 / pass 9 / fail 0 / EXIT=0**。
- **变异测试已做**（证明断言非空）：在 `out/test/store/settings-store.js` 的 `persist()` 上把 `providerId` 从每行剥掉后重跑 → 测试失败（`actual: undefined, expected: 'src_mirror'`，`ERR_ASSERTION`，EXIT=1）；恢复产物后 9/9 通过。
- 回归：`search-router` 14/14、`playback-router` 15/15、`jj-source-protocol` 21/21，全 EXIT=0。
- `npx tsc --noEmit -p tsconfig.node.json --composite false` → EXIT=0。
- 无需改 `tools/build-test.mjs`：其入口列表已有 `store/settings-store.ts`（:80）与 `sources/legacy-music-info.ts`（:53）。
- **AC7 仍不得整体记为达成**：真机端到端（同平台双音源 → 搜索 → 播放 → 重启 → 再播放）仍缺，E2E 在当前会话不可用（见下）。

#### E4 验证环境的硬限制（2026-09-28，已确认）

`node tools/run-e2e.mjs` **在当前会话无法运行**，卡在第一步构建：

```
>>> building (with E2E hook)
error during build:
Error: spawn EPERM
    at ChildProcess.spawn (node:internal/child_process:421:11)
    at ensureServiceIsRunning (.../esbuild/lib/main.js:1978:29)
    at bundleConfigFile (.../electron-vite/.../lib-ClgyQuZx.js:1109:26)
```

链条是 `Node (run-e2e.mjs) → Node (electron-vite) → esbuild 服务进程`，**沙箱禁止 Node 派生 Node**，故第 1 步即被拒。虽已装好 Electron 二进制（见下），但那解决的是第 4 步（probe 启动真实应用），不是第 1 步——**装 Electron 是 E2E 的必要条件，不是充分条件**。

该 EPERM 与 `jj-provider-engine.test.mts` 第 1、2 节失败同源（`spawnSync(process.execPath, ['-e','0'])` → `status null error EPERM`），即凡 Node→Node 派生一律被拒，包括构建工具链内部的。

**当前会话的验证能力**：

| 验证类型 | 状态 |
| --- | --- |
| 纯逻辑单测（`node:test`） | ✅ 可用 |
| Electron 二进制 | ✅ 已装好可运行（`v42.11.8`） |
| E2E（`run-e2e.mjs`） | ❌ 卡在构建，沙箱禁止 Node→Node |
| 需 fork 音源子进程的测试 | ❌ 同一原因 |

#### Electron 环境安装（2026-09-28）

`package.json` 声明 `electron: ^42.11.8`，但 `node_modules/electron/` 只有壳、**无 `dist/`、无 `path.txt`**（`install.js` 从未跑过）。新增 **`tools/install-electron.mjs`** 修复，可复用。三条根因：

1. **表象是"网络不通"，实为代理**：`Invoke-WebRequest` 报「基础连接已经关闭」、`curl` 报 `schannel: SEC_E_NO_CREDENTIALS`。环境有 `HTTP_PROXY=127.0.0.1:7897`（Clash 类 fake-IP），DNS 把各域名解析到 `28.0.0.x`；而 **PowerShell 5.1 的 `Invoke-WebRequest` 不读 `HTTPS_PROXY`**，直连 fake-IP 必然失败。**Node 的 `fetch` 读代理，能通。**
2. **缓存目录不可写**：`EPERM: mkdir 'C:\Users\jun\AppData\Local\electron'`。`cacheRoot` 是 `downloadArtifact` 的**选项**而非环境变量（`@electron/get/dist/index.js:111`），且 `env-paths` 在 win32 上不读 `XDG_CACHE_HOME`（`env-paths/index.js:21-33` 只读 `LOCALAPPDATA`/`APPDATA`）。脚本显式指向工作区 `.cache/electron`，与仓库 `.npmrc` 把 npm cache 放进 `.cache/npm` 同一思路。
3. **解压 API 形状**：`@electron-internal/extract-zip` 的**默认导出不是函数**，必须用**具名导出**，与 `node_modules/electron/install.js:5` 一致。

镜像仍走环境变量 `ELECTRON_MIRROR`（`.npmrc` 注释明确要求不要把镜像写进文件）。结果：`dist/electron.exe` 235191296 字节；`cmd /c "node_modules\electron\dist\electron.exe --version > out\ev.txt 2>&1"` → `v42.11.8`、退出码 0。
**注意**：直接 `& $e --version` 输出为空且无退出码（GUI 子系统程序不往管道写）；`Start-Process -RedirectStandardOutput` 会因 PS 5.1 的 `NO_PROXY`/`no_proxy` 字典冲突报错。**可靠方式是 `cmd /c` 带重定向。**

#### E4b 实施状态：AC4 的地址缺口已闭合（2026-09-28）

##### 缺口的形状（比"url-guard 非 DNS 感知"更准确）

`assertPublicHttpUrl` 判的是 URL 的**文本**。对地址字面量，文本即目标；对**域名**则不是：

- `isIP(host)` 返回 0 → `blockedIPv4`/`blockedIPv6` 两个分支都不执行 → 剩下的 `localhost`/`.local`/`.internal` 等**名字黑名单**拦不住任意指向内网的域名；
- 随后 `fetch` 自己解析该域名，连到哪儿守卫全程不知情。

**检查看到的是名字，连接用的是地址。** 逐跳重验、尾点剥离都已到位，穿过的只有这一种。

##### 三条实测事实（探针，已删除）

1. **钩子内抛错确实阻断连接**，不会静默回退系统解析器（`cause: Error - blocked by probe`）——这是方案成立的唯一依据；
2. 钩子以 **`all: true`** 被调用，回调必须给**数组** `[{address, family}]`；
3. **IP 字面量不进钩子**（直接进 connect），故既有 `blockedIPv4/6` 仍是对字面量的唯一防线，两者是互补而非替代。

##### 改动

| 文件 | 改动 |
| --- | --- |
| `src/main/online/pinned-dispatcher.ts` | **新建**（11041 字符）。`createPinnedDispatcher(resolver = lookup)` 注入 `connect.lookup`，解析后逐地址判 `isPublicAddress`；`pinnedDispatcher()` 单例；导出 `isPublicAddress` 以便测试 |
| `src/main/online/url-guard.ts` | 导入 `pinnedDispatcher`，**唯一发起连接处**的 `fetch` 加 `dispatcher: pinnedDispatcher()`（带类型断言，因该选项不在 WHATWG 规范内）；文件头注释重写为"地址检查发生在三处" |
| `package.json` | `dependencies` 加 `"undici": "^6.28.1"`——此前它只是被 hoist 上来的传递依赖，构建不声明依赖巧合不可接受 |
| `tools/build-test.mjs` | `external` 数组加 `'undici'`。**原因与其余条目不同**：undici 是纯 JS、本可打包，但打包会**弄坏它**——它内部是 CJS，esbuild 把 `require('node:assert')` 改写成 ESM 里必 throw 的 shim（`Dynamic require of "node:assert" is not supported`）。保持 external 让 Node 正常按 CJS 解析 |
| `src/test/url-guard-pinning.test.mts` | **新建**（7631 字符，10 条 / 3 suite） |

##### 关键设计点

- **`every` 而非 `some`**：一公一私的**混合答案**正是绕过"只看第一个结果"的形状（第一个连不上就重试第二个），故拒绝整个答案，不接受任何单个地址。
- **fail closed**：解析失败、空答案、非地址输入一律拒绝——"判不出来"不得读成"没问题"。
- **每跳都应用**：重定向目标是新连接，故 dispatcher 加在循环内的 fetch 上，不是循环外。
- 解析器**可注入**：那两种要命的答案无法从真实解析器按需产生，不可注入则只能测纯函数谓词，而**真正的防御（被拒的解析是否真让连接没发生）将完全未验证**。

##### 验证证据

- `url-guard-pinning`：**tests 10 / suites 3 / pass 10 / fail 0 / EXIT=0**。其中 `blocks when only ONE of several addresses is private` 是核心用例；`confirms the hook is reached at all` 是**反向证明**（放行公网地址让请求真去连、离线等 3s 超时），没有它，其余"阻断成功"都可能只是因为请求本来就失败。
- 回归：`url-guard` 18/18、`search-router` 14/14、`playback-router` 15/15、`jj-source-protocol` 21/21、`provenance-persistence` 9/9、`search-cancel` 通过（手写脚本，打印 `search cancellation passes`），**全部 EXIT=0**。
- `npx tsc --noEmit -p tsconfig.node.json --composite false` → EXIT=0；`npx vue-tsc --noEmit -p tsconfig.web.json --composite false` → EXIT=0。
- 编码：三个改动文件 fffd=0 / mojibake=0。

##### E4b 结束时**仍然开放**的事项（不得误记为已解决）

1. **"脚本自己调 `fetch`"不受此保护**。`browser-shims.ts` 的 `NETWORK_GLOBALS_POLICY = 'available'` 是 E0 决策 D1 的有意选择（移除网络全局经实测证伪，会打死全部真实音源），故脚本硬编码 URL 直连不经守卫。这保护的是**宿主自己发起的抓取**，不是脚本的出站流量。
2. **`connect.lookup` 在 Electron main 进程内是否生效，会话内无法证实**。探针表明 Electron 能加载 main 入口，但**一旦 `await app.whenReady()` 就必然段错误**（退出码 `-1073741819` = `0xC0000005`），故该路径无运行时证据；依据仅是 Node v24.9.0（与 Electron 42 同源的 undici 6.28.1）上的实测。
3. **`connect.lookup` 不在 undici 6.28 的类型声明里**，属未声明 surface。代码用一个集中的类型断言标注此事，注释写明：若将来 undici 声明了它，编译器会在那一行报错，正确反应是删掉断言并核对签名仍与实测行为一致。

### E5. 歌单导入与榜单

- **Goal / Scope**：歌单 URL 识别、分页与曲目由音源返回；保留本地预览与保存；新增能力驱动榜单页面。
- **建议位置**：`src/main/online/playlist-import.ts`、`src/main/index.ts:1961/1968`、歌单视图、新增榜单视图与 IPC。
- **Constraints**：按 §2.3 只做浏览与播放，不做订阅与定时同步；无能力时不展示入口。
- **AC**：AC1 / AC2 / AC7 对应部分。
- **Verify**：分页、重复项、空结果、超限数据、封面失败；`npm run test:e2e`。

#### E5 开工评审定稿的两项决策（用户逐条确认）

**E5-1 歌单链接由宿主识别，脚本只拿 ID。**
`parsePlaylistId`（`src/main/online/playlist-import.ts:16`）仍在主进程执行，负责判定链接属于哪个平台并拒绝「链接与所选平台不一致」；只有解析出的数字 ID 进入 `getPlaylist`/`getPlaylistTracks` 的 payload。
理由：`getPlaylist` 的契约是「歌单链接/ID → 歌单头」，若照字面把原始 URL 交给脚本，脚本就获得了用户粘贴的链接（浏览上下文），同时宿主失去那道平台一致性校验——而用户正是从下拉框选平台、从剪贴板粘贴链接的，两者不匹配是常态而非异常。

**E5-2 无音源能提供榜单时，入口**保留**并显示说明文案**（不是隐藏）。
理由：与 E3 搜索页的空状态口径一致；榜单是纯新增功能，隐藏入口会让刚装完音源的用户无法判断功能是否存在。文案须区分「一个音源都没启用」与「启用的音源不提供榜单」——两者要用户做的事不同。

#### E5 实施状态（2026-09-28）

状态：**实现完成，测试通过**。AC1/AC2/AC7 对应部分已覆盖；E5 不新增 AC4 面（无脚本侧 URL 校验新增，封面仍走 `fetchImportCover` + `COVER_HOSTS`）。

| 文件 | 改动 |
| --- | --- |
| `src/main/online/library-router.ts` | **新建**。歌单头/歌单曲目/榜单列表/榜内曲目的路由层，与 `search-router.ts` 同构：音源优先 → 内置（仅在 `allowBuiltinOnlineSearch` 打开时）→ 空结果加原因。**无 1→2 回退**（AC3）。 |
| `src/main/index.ts` | `Services` 加 `libraryRouter`；`playlistImportPreview` 改走路由（宿主 `parsePlaylistId` → 只传 ID）；新增 `IPC.leaderboardList` / `IPC.leaderboardTracks` 两个 handler。 |
| `src/shared/ipc.ts` | 新增 `leaderboardList` / `leaderboardTracks` 两个通道常量。 |
| `src/shared/types.ts` | 新增 `LibraryRouteServedBy` / `LibraryUnavailableReason` / `RoutedLeaderboard` / `RoutedLeaderboards` / `RoutedTrackPage`。**放 shared 而非 router 旁**：渲染层与 preload 都要用，而 `@main/*` 别名只存在于 `tsconfig.node.json`，preload 经它导入不解析（`vue-tsc` 报 TS2307，已实测）。 |
| `src/preload/index.ts` | 新增 `leaderboards.list/tracks` 接口。 |
| `src/renderer/src/views/LeaderboardView.vue` | **新建**。榜单列表 + 单榜曲目，按 `providerId:boardId` 作 key 以容纳不同音源的同名榜。 |
| `src/renderer/src/router/index.ts` | 新增 `/charts` 路由。 |
| `src/renderer/src/components/SideBar.vue` | 「榜单」入口。 |
| `src/renderer/src/components/AppIcon.vue` | 新增 `chart` 图标路径（原先无图表类图标）。 |
| `tools/build-test.mjs` | 入口表加 `online/library-router.ts`。 |
| `src/test/library-router.test.mts` | **新建**，15 条。 |

**验证证据**（单套 esbuild 直调方式，沙箱禁止 Node 派生 Node）：
- `library-router` **tests 15 / pass 15 / fail 0 / EXIT=0**。
- **变异测试已做**（证明断言非空）：把产物里 `if (page.ok) {` 强制改为 `if (true) {`（模拟「音源失败被当成成功」）→ `音源失败时绝不退化到内置适配器，只报告失败` **失败**，`pass 14 / fail 1 / MUT_EXIT=1`；还原后 15/15。第一次尝试的变异字符串没匹配上（`\n` 与产物缩进不符），当时「15/15 通过」**不构成证据**，已重做并先断言 `mutation landed = True`。
- 回归全绿：`search-router` 14/14、`playback-router` 15/15、`jj-source-protocol` 21/21、`url-guard-pinning` 10/10、`url-guard` 18/18、`downloads-import` 25/25，全 EXIT=0。
- `npx tsc --noEmit -p tsconfig.node.json --composite false` → **EXIT=0**；`npx vue-tsc --noEmit -p tsconfig.web.json --composite false` → **EXIT=0**。

**本轮踩到的两个坑（记以免重犯）**：
1. `edit` 工具在替换文本末尾带换行而原文没有时，会**吃掉相邻换行**，把两行拼成一行（`index.ts:2087` 的 `playlists.list())  handle(...)`）或把注释块两行并作一行（`AppIcon.vue:44`）。两次都已修回；改多行结构后须重读该处确认行边界。
2. 临时回归脚手架用 esbuild 打包时，**CJS 传递依赖被内联会报 `Dynamic require of "tty"/"fs" is not supported`**（与 E4b 的 undici 同源）。加 `--packages=external` 解决；这是脚手架问题，不是被测代码问题。

**E5 仍然开放的事项**：
1. **`npm run test:e2e` 未跑**（Plan 的 Verify 列了它）。原因是沙箱禁止 Node 派生 Node，`tools/run-e2e.mjs` 第一步构建即 `spawn EPERM`——与 E4 记录的是同一条硬限制，不是 E5 引入的。
2. **真实音源的榜单/歌单行为未验证**：15 条测试全部用假引擎（真引擎要 fork 子进程）。`getPlaylistTracks` 的 `hasMore` 分页循环只覆盖到「首屏」，多页累加未测——现有导入流程只取第一页，这一点与 E5 之前的行为一致，但榜单翻页也复用同一路径，待真机确认。
3. **`PlaylistImportView.vue` 的平台下拉仍是硬编码五家**（wy/tx/kg/kw/mg），**有意未改**：`parsePlaylistId` 的域名表就是这五家，改成「音源声明的平台」会让选了音源未声明平台的用户同时失去两条路。若将来要支持音源私有平台，需连同 `parsePlaylistId` 一起设计。

### E6. 音源版本检查、确认更新与回退

- **Goal / Scope**：只检查用户指定来源；展示版本与能力变化；确认后下载校验、原子替换、重新初始化；失败回退。
- **建议位置**：`src/main/sources/source-store.ts`、导入 URL IPC、`SourcesView.vue`、`src/main/sources/source-validator.ts`。
- **Constraints**：检查阶段不执行脚本；`source-store.ts` 现有“同名覆盖”与最多 20 条规则不能充当稳定 ID 与更新策略；远程清单 SHA-256 仅校验下载一致性、**不证明发布者身份**；更新成功后按音源版本隔离平台缓存。
- **交付接口**：更新状态、来源与版本记录、回退入口与诊断信息。
- **AC**：AC5。
- **Verify**：本地 HTTP 测试源覆盖拒绝、校验失败、超时、初始化失败、成功、重启后版本保持。

#### E6 开工评审定稿的两项决策（用户逐条确认）

**E6-1 更新来源：只支持「`@homepage` 就是脚本直链」的情形。**
`@homepage` 指向一个能直接取到脚本的 URL 时就下载比对；取回的内容若不是脚本（网页等），明确报「无法从该地址获取脚本，请从作者发布页手动下载后重新导入」，**不猜、不解析 HTML**。
理由：从 HTML 里挑下载链接没有可靠判据——选择器、按钮文案、跳转层数每个站点都不同，而猜错的代价是把用户没选过的东西端给他并请他安装。代价是不填直链、只填官网的音源查不了更新，这类音源仍可手动导入。这条取舍与「检查阶段不执行脚本」同向：检查越保守，能造成的损害越小。

**E6-2 回退范围：保留上一版脚本文本，一键回退（只留一版）。**
更新前把被替换的脚本文本存进 `user_api.json` 的扩展键，回退即写回旧文本并重新初始化。
理由：AC5 要求失败可回退，而"更新把可用音源弄坏"是真实且不可接受的后果（用户会失去整个在线播放能力）。只留一代是刻意的——回退的目的是从一次坏更新中恢复，更深的历史会把文件体积乘以份数（真实音源 ~740KB 一份），而想要更旧版本的用户本来就可以手动导入。
否决的两个方案：**不做回退**（违反 AC5，且写坏用户音源无法挽回）；**全文件快照回退**（引入磁盘副本与保留策略问题，超出 AC5 所需，且快照要处理的部分正是 store 已经在处理的）。
**副作用已知并接受**：该文件会因多存一份脚本而变大。

#### E6 实施状态（2026-09-28）

状态：**实现完成，测试通过**。AC5 对应部分已覆盖。

| 文件 | 改动 |
| --- | --- |
| `src/main/sources/source-updater.ts` | **新建**。版本比较（`parseVersion`/`compareVersions`）、脚本判定（`looksLikeScript`）、检查（`checkForUpdate`）、回退描述（`describeRollback`）、`MAX_UPDATE_BYTES`。取数走 `safeFetchBytes`，fetcher 可注入以便离线测试。 |
| `src/main/sources/source-store.ts` | `StoredApi` 新增 `previousScript`/`previousVersion`；新增 `replaceScript`（按 `stableId` 身份优先，原地更新并保留旧脚本）、`rollback`（**交换而非清除**，故回退本身可逆）、`raw`；`toMeta` 条件导出 `canRollback`/`rollbackVersion`。 |
| `src/shared/types.ts` | `UserApiMeta` 新增 `canRollback?`/`rollbackVersion?`；新增 `UpdateCheckFailure`/`UpdatePlan`/`UpdateCheckResult`（放 shared 因渲染层与 preload 都要用，`@main/*` 别名在 web program 里不解析）。 |
| `src/shared/ipc.ts` | 新增 `sourcesUpdateCheck`/`sourcesUpdateApply`/`sourcesUpdateRollback` 三个通道。 |
| `src/main/index.ts` | 新增三个 handler。`apply` **接收脚本文本而非重新下载**，使"用户看到的字节"与"写入的字节"是同一份；`apply` 与 `rollback` 之后都 reload 两个引擎，故更新和回退都要重新过启动前校验。 |
| `src/preload/index.ts` | 新增 `sources.updates.check/apply/rollback`。 |
| `src/renderer/src/views/SourcesView.vue` | 每张卡片新增「检查更新」按钮（**仅在脚本填了 `@homepage` 时显示**——否则是个只会回答"没有地址"的死控件）与「回退」按钮（**仅在更新过之后显示**，标签带将恢复的版本号）；更新面板常驻屏幕而非 toast，展示版本差、来源地址、体积、**校验值**与风险评级。 |
| `src/test/source-updater.test.mts` | **新建**，26 条。 |

**关键设计点**：
- **校验值同时说明它不是什么**。面板上原文写明「校验值只说明下载内容与上面显示的一致，不证明发布者身份」，`sha256` 字段的注释也写着 "Verifies transfer, not authorship"。这是 Plan 硬约束的落点：`@homepage` 未经认证，也没有发布者身份可校验。
- **解析不出版本时不放行**。传入版本不可解析 → 不算更新（"无法解析"不是修复的证据，且不能让它覆盖可用脚本）；当前版本不可解析而传入可解析 → 算更新（作者开始写真实版本是改进，拒绝会把用户永久困住）。
- **不向后**。`planUpdate` 拒绝版本后退，故被攻破的 `@homepage` 不能靠标低版本把用户推回旧脚本。
- **重复应用同一份文本不算更新**。它在写入前比较文本，因为返回当前文本的抓取若照写，会用"正被保留作回退的那一版"覆盖 `previousScript`，凭空丢掉回退能力——与版本字符串怎么说无关。
- **更新不产生新记录**。`replaceScript` 找不到该 id 时返回 `undefined` 而不静默创建：用户已删除的音源不该因一次更新被装回来。

**验证证据**（单套 esbuild 直调方式，沙箱禁止 Node 派生 Node）：
- `source-updater` **tests 26 / pass 26 / fail 0 / EXIT=0**。
- **变异测试已做且可信**：把产物里 `if (b.length === 0) return 0;` 改为 `return 1;`（模拟"无法解析的传入版本也算更新"）→ `无法解析的传入版本永远不算更新` **失败**，`pass 25 / fail 1 / MUT_EXIT=1`，且**只有这一条失败**——说明该守卫是载重的，且没有别的用例顺带覆盖它。还原重建后 26/26（`has_mutation=False`）。
  - **教训**：第一次变异用了相对路径且目录不对，`$orig` 为 null，**变异根本没落地**。因为先打印了 `mutation_landed` 才没把那次「26/26 通过」当作证据。
- 回归全绿 EXIT=0：`search-router` 14/14、`playback-router` 15/15、`library-router` 15/15、`jj-source-protocol` 21/21、`url-guard` 18/18、`url-guard-pinning` 10/10、`provenance-persistence` 9/9。
- `npx tsc --noEmit -p tsconfig.node.json --composite false` → **EXIT=0**；`npx vue-tsc --noEmit -p tsconfig.web.json --composite false` → **EXIT=0**。

**本轮修掉的一个真实缺陷（在代码里，不在测试里）**：
`parseVersion('1.2.1-beta.3')` 原返回 `[1,2,1,3]`——因为按 `.` 切分后 `1-beta` 取前导整数得 `1`，而 `-beta` 之后的 `3` 又成了一个新段。后果是**预发布版会比它自己的正式版"更新"**。修法：切分前先在第一个 `-` 或 `+` 处截断。这是实现的问题，不是测试期望的问题，故改的是代码。

**本轮踩到的两个坑**：
1. **我两次靠推理而非读代码判断"尾部换行去哪了"**，两次都错。先假设 `decodeScript` 会 trim，又用一次孤立的 `gz_` 往返"证明"它不会 trim——而孤立的往返确实无损，那个实验是对的却与问题无关。答案一直在 `source-store.ts:477/480/501`：`parseImportPayload` 在**导入边界**对解码后的文本调用 `.trim()`。**读源码一步就能定的事，三轮推理没定下来。**
2. `npm run test:e2e` 仍未跑（沙箱禁止 Node 派生 Node，`run-e2e.mjs` 第一步构建即 `spawn EPERM`）。故 Plan 的 Verify 里"本地 HTTP 测试源"以**注入 fetcher** 的方式覆盖：`checkForUpdate` 的第二个参数就是为此存在，拒绝/超时/非脚本/校验失败/成功都可离线驱动。**未覆盖的是真机端到端**，与 E4/E5 记录的是同一条硬限制。

**E6 仍然开放的事项**：
1. **`npm run test:e2e` 未跑**（同上）。
2. ~~**更新后按音源版本隔离平台缓存**（Plan Constraints 里的一条）**未实现**。~~ **已于 2026-09-28 补做**，见下文「E6 遗留项补做：按音源版本隔离平台缓存」。原文保留如下以示当初确实未达成：现状是缓存不区分音源版本，故更新后可能仍读到旧版本产生的缓存条目。当前没有造成可见错误（缓存键含平台与曲目，音源换脚本不改变这两者），但这是 Constraints 里明写的一条，**不记为已达成**。
3. **回退只保留一代**（有意），更早的版本需手动导入。
4. **`@homepage` 只填官网的音源查不了更新**（E6-1 的有意取舍）。

#### E6 遗留项补做：按音源版本隔离平台缓存（2026-09-28）

这条是 Constraints 里明写、当初明确记为「未达成」的一条。用户先选了「只按音源身份隔离」，随后在我指出**该方案实现不了"版本"二字**后改选「按音源身份 + 脚本内容指纹」。

**为什么只加 `providerId` 不够。** `providerId` 就是 `stableId`，而 `source-store.ts:40-53` 明确写着它是专门为了**跨版本不变**而设计的（`id` is *nearly* stable but not quite… `stableId` survives a rename）。拿它当版本键，脚本换一版后同一个键仍然命中，问题原样保留。所以键必须是两半：`stableId` 管「是哪个音源」（与 `providerId` 盖章对齐），**脚本内容摘要**管「是哪个版本」。

**为什么用摘要而不是作者声明的版本号。** 版本号是作者的声明，大量真实脚本从不改它，同一个 `1.0.0` 下发的修复会被漏掉——那正是这条 Constraints 要防的情形。摘要是对**用户导入时的文本**取，故逐字节相同的重导入**正确地不算**版本变化。

**实施位置（四处）**：

| 文件 | 改动 |
|---|---|
| `src/main/sources/source-store.ts` | 新增 `versionOf(id)`，返回 `${stableId ?? id}@${sha256(decodeScript(script)).slice(0,16)}`；`:18` 加 `import { createHash } from 'node:crypto'` |
| `src/main/library/lyric-service.ts` | 歌词缓存键改为 `cacheKeyFor(trackId, provider?)` = `provider ? `\`${provider}\u0000${trackId}\`` : trackId`；新增 `clearLyricCacheFor(provider)`；`clearLyricCache(trackId?)` 有参时**同时**删裸 id 与带前缀两种键；`primeLyricCache` 加第三参 `provider?` |
| `src/main/online/hot-words.ts` | `HotWordEntry` 加 `provider?`；新增 `setVersion(version)`（不同则**立即删除**不符条目并落盘，不是只在读时忽略）；`load()` 丢弃 `provider` 不符与缺失的老条目；`showNow()` 对异版本条目剔除并要求重新去问 |
| `src/main/online/search-router.ts` | `SearchRouterOptions` 加 `providerVersion?`；`hotWords()` 内置分支首行 `this.hotWordSource.setVersion(this.providerVersion())` |

**「无 provider 时键与隔离前完全相同」是有意的**：没有版本可归属时（默认安装、离线套件）行为必须一模一样，否则会把默认安装的缓存每天白白作废一次。

**为什么不只在读时过滤。** 只在读时忽略、内存里留着旧条目，会让**切回旧脚本**的用户继续看到新脚本的榜单——条目必须当场删掉。

**本轮我自己造成的两个返工（都是真缺陷，被既有测试或读回原文抓到）**：
1. **把退避门改成 `if (usable && failed && …)`**：首次失败时没有 `usable`（`previous` 为空），退避因此永不生效，每次切页签都去撞那台已经挂掉的主机。既有测试「一次结果页签共用，失败的也不反复重试」以 `2 !== 1` 抓到。正确形状是**退避只由失败戳决定，`usable` 只决定「不给就得显示什么」**：`if (failed && this.now() - failed < FAILURE_BACKOFF_MS) return usable?.words ?? []`。
2. **新测试的断言落在了错误的时刻**：把 `assert.ok(asks >= 1, …)` 放在 `await source.load()` 之后，而 `load()` 从不问网络。用独立探针证实生产代码是对的（`after load asks= 0`、`after words asks= 1`），断言移到 `words()` 之后。**教训：断言要落在「行为发生」的那一步，而不是它之前的准备步骤。**

**验证证据（全部实跑）**：

| 项 | 结果 |
|---|---|
| `hot-words` 套件 | **18/18 pass / 0 fail**（新增 5 条版本隔离测试） |
| 受影响套件回归 | `lyric-source` 3/3、`search-router` 14/14、`source-updater` 26/26、`url-guard` 18/18、`url-guard-pinning` 10/10、`provenance-persistence` 9/9、`builtin-gate` 6/6、`lyrics-search` 56/56 |
| 全量回归 | **PASSED=40 FAILED=7 TOTAL=47**，失败清单与改动前**逐条一致**，全部 `spawn EPERM` 环境限制（`jj-provider-engine`、`sandbox-probe`、`source-engine`、`u0-migrate`、`update-assets`、`update-release-tool`、`upgrade-data`） |
| `npx tsc --noEmit -p tsconfig.node.json --composite false` | **EXIT=0** |
| `npx vue-tsc --noEmit -p tsconfig.web.json --composite false` | **EXIT=0** |

**变异验证的真实结果——这里没有"通过"，必须如实读。** 三道版本防线是**串联冗余**的：`load()` 的读盘过滤、`showNow()` 对异版本的剔除、`refresh()` 的 `usable` 判据。针对**单独一条**的变异**全部逃逸**：把 `load()` 过滤改成 `if (false)`、把 `showNow()` 剔除改成 `if (false)`、把 `usable` 改成 `const usable = previous`，三次都是 **18/18 全绿**。更下游的两处甚至无从生效——探针显示 `load()` 过滤生效时 `entries` 已是空的，`showNow()`/`refresh()` 根本没有条目可处理。

因此这 5 条测试证明的是**行为契约**（换版本之后用户看到的必须是新脚本的词，且确实重新问过），**不是**"实现里的某一行被覆盖"。要让单行可变异，只能直接读私有的 `entries`——那验的是实现而不是契约，不值当。**任何后续读者不应把这段读成「三条防线各自被验证过」。** 该结论已同步写进 `src/test/hot-words.test.mts` 的分组注释。

**已知的静默代价（用户已接受）**：隔离本身不通知用户，与 E7 艺人头像那处处理方式一致——写进文档与注释，不改界面。



### E7. 迁移收口与发布 Review

- **Goal / Scope**：切断 `src/main/online/*` 剩余平台直连调用，更新设置、帮助文案与旧音源能力说明；用至少一个真实且获准使用的完整音源做手工冒烟验证。
- **建议位置**：`README.md`、Sources / Search / Settings 等 UI、`src/main/online/*` 余留模块。
- **AC**：AC1–AC7 全量。
- **Verify**：`npm run verify`（typecheck + build + test）、`npm run test:e2e`、平台请求拦截检查、人工操作记录。

#### E7 实施状态（2026-09-28）

状态：**代码改动完成并通过验证；文档已更新；`npm run test:e2e` 与人工冒烟未完成**（见「仍未达成」一节）。

**侦察结论：任务开始时仍能发出内置平台请求的路径共 6 处。**

已加门、无须工作的（任务前就已具备）：`IPC.musicSearch`、`IPC.musicSearchAll`、`IPC.musicHotWords`、`IPC.matchMetadata`（注入 routed search）、`IPC.playlistImportPreview`（经 `libraryRouter`，`servedBy === 'none'` 时抛错）、平台探测（显式读开关）、`SearchRouter.searchViaBuiltin`。其中 `playlist-import.ts` 与 `search-router.ts` 各自都有一句"复用**同一道**门，不是第二道"的注释，理由是两道门会漂移——E7 沿用了这条约定。

曾疑未加门、核验后确认不需改的两处：`online/artist-image.ts` 的门在**上一层**（`ArtistImageStore` 构造处，不在函数自身）、`online/playlist-import.ts:70` 已被 `library-router` 覆盖。

**本轮实际改动的注入点与调用点：**

| 文件 | 改动 |
| --- | --- |
| `src/main/index.ts` | `onlineLyric` 服务的内置步骤加门：`platform: () => allowBuiltin ? fetchOnlineLyric(music, signal) : Promise.resolve({ lyric: '' })`。**关掉时返回空歌词，而不是从顺序里删掉**——`lyricSourceOrder` 的先后是用户排的，删掉会让「回退」这一列悄悄改意义。 |
| `src/main/index.ts` | `IPC.playlistBackfillQualitys` 加门：`if (!requireServices().settings.get().allowBuiltinOnlineSearch) return []`。 |
| `src/main/index.ts` | 新增 `lyricDeps` 注入器并挂到 `Services` 包上（`LyricDeps` 类型声明在 `Services` 旁，供 `createServices` 与 IPC handler 共用一份形状，避免两个结构相似的类型各自漂移）。三个歌词 handler 改为读 `requireServices().lyricDeps`。 |
| `src/main/index.ts` | `ArtistImageStore` 构造处注入受门的 `resolveArtistImage`。 |
| `src/main/index.ts` | `lyricsForMatch(options.lyricFrom, requireServices().lyricDeps.fetchLyric)`。 |
| `src/main/library/lyric-service.ts` | `lyricCandidates`/`searchLyricOnline`/`resolveLocalLyric` 增加 `deps` 注入口；`defaultSearch` 保留旧的直连行为（供离线测试不传参时使用）；导出 `SearchOnlineForMatch`。 |
| `src/main/library/metadata-match.ts` | `lyricsForMatch(music, fetchLyric = fetchOnlineLyric)` 增加注入口。 |
| `src/main/library/artist-images.ts` | 构造依赖增加可选 `resolveArtistImage`，未传时回落到直接 import。 |
| `src/main/library/lyric-service.ts` | **删除**导出的 `resolveOnlineLyric`（全仓库零调用者，却直接绑死 `fetchOnlineLyric`）。 |

**为什么删掉那个死函数，而不是留着。** 它无人调用、留着收益为零；但它同时是"唯一一个绕开注入口、直接绑死内置取词器的导出函数"，而它的名字读起来就是"给在线曲目取歌词"的正当入口。以后有人要加功能，第一反应是调它——缺口就悄无声息地重新打开了，而且**不会有任何测试失败**。这正是 E7 要消灭的形状，删掉比标注便宜。

**开关关闭时的两个静默行为变更（默认状态下就是如此）：**
1. 歌手头像不再联网获取，直接按「没有」处理，歌手页退回专辑封面。返回 `null` 而**不是抛错**是刻意的：`resolve()` 把抛错记成"这次查找失败了"并报给用户，而一次被关掉的查找并没有失败，它只是没发生——把它报成故障是假话。
2. 歌单音质徽标不再填充。用户明确选过 A 案「加门，关闭时返回空」。

两处都**没有**界面提示告诉用户"是设置导致的"。判断：加提示的收益是"用户知道为什么没头像"，但真正的风险不是用户不知道，而是**将来维护的人不知道**——他会看到"头像功能好像坏了"，去查代码，然后可能把门拆掉。文档与代码注释能覆盖这个风险，而加界面元素是新的产品决策，应当单独提出。设置页文案已相应说明了这个代价（见下）。

**测试：新增 `src/test/builtin-gate.test.mts`，6 条，全绿。**

这个套件的断言方式需要说明，因为它决定了它能证明什么：

- 该套件**无法 import `index.ts`**（它在模块顶层调用 `app.getPath`），所以它验证的是**注入接缝**：每个消费方调用的是注入进来的函数，而不是自己的 import。用记录型替身断言"注入了就去调它"，而不是断言"函数返回了空"——后者在"请求发出去了但响应被丢掉"的情况下同样会通过，而那正是本任务要抓的缺陷。
- 门本身（"注入的那个东西确实实时读设置"）由该套件最后一条测试**读取 `index.ts` 源码**断言：三处门各自检查了返回形状（头像必须 `null`、取词器必须返回 `{ lyric: '' }`、徽标必须 `return []`），并断言开关读取出现次数 ≥3。
- **这条 grep 测试挡不住"保留字符串、丢掉行为"的重构**，属于已知弱点，不得当作 AC3 的完整证明。

**变异验证已做且可信**：把产物里 `lyricsForMatch` 的 `await fetchLyric(music)` 改成 `await fetchOnlineLyric(music)`（模拟"忽略注入、直连内置"）→ 恰有一条断言失败（`标签匹配取歌词：注入的取词器就是被调用的那个`，`actual: []` vs `expected: ['wy_9']`），`MUT_EXIT=1`，且只有这一条失败——说明该断言载重且无重复覆盖。还原重建后 `has_mutation=False`、6/6。

**回归证据**（单套 esbuild 直调，沙箱禁止 Node 派生 Node）：
- `tsc --noEmit -p tsconfig.node.json` → EXIT=0（多次，含删除死代码后）。
- 全绿 EXIT=0：`builtin-gate` 6/6、`lyric-source` 3/3、`lyrics-search` 56/56、`artist-image` 14/14、`online-qualitys` 4/4、`hot-words` 13/13、`library` 25/25、`url-guard` 18/18、`url-guard-pinning` 10/10、`search-router` 14/14、`playback-router` 15/15、`library-router` 15/15、`jj-source-protocol` 21/21、`provenance-persistence` 9/9、`source-updater` 26/26。

**文档更新**：
- `README.md` — 在「开始使用」后新增一段说明"在线能力默认只交给音源脚本"、无静默兜底、以及默认为何头像是空、徽标不填；艺术家头像那一条补上"同样受该开关约束"。
- `src/renderer/src/utils/settings-pages.ts` — `allowBuiltinOnlineSearch` 的说明从"搜索和热门搜索词"扩到五条路（搜索、热词、在线歌词、头像、歌单徽标），并写明"这个开关一关就没有例外"及其可见代价。

**本轮踩到的坑（可复用）**：
1. **先用错了构建方式**：把每个测试文件当 entry point 单独 bundle，导致 `./online/artist-image.js` 这类相对导入解析失败（`Could not resolve`）。真实做法是 `run-tests.mjs` 那样——用 `build-test.mjs` 的 `src/main/**` 入口列表 + `--outbase=src/main` 打出**镜像目录树**到 `out/test/`，再把套件平铺复制进去。**测试文件的相对导入是冲着镜像树写的，不是冲着 `src/test/` 写的。**
2. **`URL.pathname` 不解码 `%20`**：本仓库路径含空格，`new URL(...).pathname` 返回 `D:/Workspace/Codex/JJ%20Music/...`，直接 `readFileSync` 必然 ENOENT。必须用 `fileURLToPath`。同时套件被平铺到 `out/test/`，故读取源码的路径要爬两级（`../../src/main/index.ts`）。
3. **`.mts` 会被当成 `.mjs` 交给原生 Node 执行**，所以测试文件里**不能出现任何 TypeScript 语法**（`: string[]`、`as`、`Parameters<>` 都会 `SyntaxError`）。这是套件文件的固有约束，不是本次引入的。

**仍未达成的（不得记为通过）**：
1. **`npm run test:e2e` 未跑**——沙箱禁止 Node 派生 Node（`spawn EPERM`），`run-e2e.mjs` 第一步构建即失败，且本会话审批提示已禁用无法提权。与 E4/E5/E6 同一条硬限制。
2. **手工冒烟验证未做**（Plan 原文要求"用至少一个真实且获准使用的完整音源"）。需要真实音源脚本 + 真实平台，超出本环境能力。
3. **门本身未经端到端断言**，只经注入接缝断言 + 源码 grep（见上文弱点说明）。

#### E7 验证证据：`npm run verify` 的真实结果（2026-09-28）

**`npm run verify` 在本沙箱无法整体跑通，卡在 `build` 这一步**：

```
error during build:
Error: spawn EPERM
    at ChildProcess.spawn (node:internal/child_process:421:11)
    at ensureServiceIsRunning (...\node_modules\esbuild\lib\main.js:1978:29)
    at bundleConfigFile (...\node_modules\electron-vite\dist\chunks\lib-ClgyQuZx.js:1109:26)
    at loadConfigFromFile (...\electron-vite\dist\chunks\lib-ClgyQuZx.js:1036:31)
```

`electron-vite build` 用 esbuild 的 **JS API** 加载 `electron.vite.config.ts`，而 esbuild 的 JS API 需要 `child_process.spawn` 拉起自己的服务进程——本沙箱禁止 Node 派生 Node。这**不是**代码问题：`typecheck:node` 与 `typecheck:web` 两步都 EXIT=0 通过，`build` 是在解析配置文件时就死了，根本没编译到源码。

**替代路径跑通的剩余两步**（用 esbuild **二进制**直调，绕开 JS API 的 spawn；这正是 `tools/build-test.mjs` 内部做的事，只是把 `await build()` 换成命令行）：

- `npm run test`（`tools/run-tests.mjs`）同样在 `building engine bundle…` 处 `spawn EPERM` 失败——它调用的就是 `tools/build-test.mjs` 里的 `await build()`。改用命令行复刻入口清单后：**40 通过 / 7 失败 / 47 套件**。
- `npm run check:gate` → **7 passed, 0 failed**，EXIT=0。

**7 条失败的逐条归因（全部是同一环境限制，与本任务无关）：**

| 套件 | 失败原因 |
| --- | --- |
| `u0-migrate` | `spawnSync powershell.exe EPERM` |
| `update-assets` | `spawnSync node.exe EPERM` |
| `update-release-tool` | `spawnSync node.exe EPERM` |
| `upgrade-data` | `spawnSync node.exe EPERM` |
| `sandbox-probe` | `spawn EPERM`（`fork`） |
| `jj-provider-engine` | `音源初始化超时（15s）`——它 `fork` 音源子进程，被 EPERM 掐死后等超时 |
| `source-engine` | `110 passed, 1 failed`，唯一失败项 `restricted-mode sources are advertised` 同样需要派生 source-host 子进程 |

**`source-engine` 那条做了基线对照**：`git stash` 摘掉 `source-engine.ts`/`source-host.ts` 的改动后重建，**同样 `110 passed, 1 failed`、同一条 `restricted-mode sources are advertised`**——证明它先于 E7 存在。随后已 `git stash pop` 还原。

**E7 触及的模块对应的套件全部 EXIT=0**：`builtin-gate`、`lyric-source`、`lyrics-search`、`artist-image`、`online-qualitys`、`hot-words`、`library`、`url-guard`、`url-guard-pinning`、`search-router`、`playback-router`、`library-router`、`jj-source-protocol`、`provenance-persistence`、`source-updater`。

**`tools/build-test.mjs` 的三处入口缺口（已修，都是本任务新增模块漏登记）：**

| 模块 | 谁 import 它 | 缺口后果 |
| --- | --- | --- |
| `src/main/sources/playback-router.ts` | `playback-router.test.mts` | 真实环境 `npm run test` → `ERR_MODULE_NOT_FOUND` |
| `src/main/sources/source-updater.ts` | `source-updater.test.mts` | 同上 |
| `src/main/online/pinned-dispatcher.ts` | `url-guard-pinning.test.mts` | 同上 |

三个模块都是本次迁移新建的，入口表没有同步登记。**这是本任务写下的真实缺陷**：`build-test.mjs` 的入口表是手工清单，加模块时容易漏，而漏了以后在真实环境表现为"测试失败"而不是"构建漏项"——排查方向会被带偏。修法即各加一行（`tools/build-test.mjs:87-88,92`）；补齐后 `playback-router` 15/15、`source-updater` 26/26、`url-guard-pinning` 10/10，均 EXIT=0。

**我自己搭替代构建路径时踩到的两个坑（都属"替代路径与真实构建漂移"，记下来给下次）**：

1. **只重建了一个 bundle 却先删了整个 `out/test`**。`build-test.mjs` 有**四个** `build()`（`src/main`、`src/shared`、`src/renderer`、`source-host.cjs`），删目录后只补第一个 → 失败数从 7 暴涨到 **22**（`search-merge`、`local-search`、`format`、`player-regression` 等全挂）。**必须四个全部复刻。**
2. **正则只匹配四参 `join`**，漏掉三参顶层形态 `join(repoRoot, 'src', 'main', 'data-location.ts')` → `data-location`、`ipc-validation` 又报 `ERR_MODULE_NOT_FOUND`。

两者的共同教训：**手工复刻入口清单的出错方式是静默漏项，而漏项会伪造出"测试失败"，比漏测更危险**。正确做法是从真实脚本里机械提取（正则同时匹配两种 `join` 形态），不要凭眼睛抄。

#### E7 结项：验收结果与覆盖缺口（2026-09-28）

**已验证（本沙箱实跑，EXIT=0）**：

| 项 | 证据 |
| --- | --- |
| `npm run typecheck`（node + web 两段） | `npx tsc --noEmit -p tsconfig.node.json --composite false` 与 `npx vue-tsc --noEmit -p tsconfig.web.json --composite false` 均 EXIT=0 |
| 单元测试 | **40 通过 / 7 失败 / 47 套件**；7 条失败全部归因于沙箱 `spawn EPERM`（其中 `source-engine` 已做 `git stash` 基线对照，证明先于 E7 存在） |
| `npm run check:gate` | **7 passed, 0 failed**，含变异验证（`if (!this.allowBuiltin())` → `if (false)` 恰 3 条失败并打印真实平台 URL，`MUT_EXIT=1`） |
| E7 触及模块的套件 | 15 个套件全部 EXIT=0：`builtin-gate`、`lyric-source`、`lyrics-search`、`artist-image`、`online-qualitys`、`hot-words`、`library`、`url-guard`、`url-guard-pinning`、`search-router`、`playback-router`、`library-router`、`jj-source-protocol`、`provenance-persistence`、`source-updater` |
| 代码改动 | 六处内置平台直达调用加门 + 删 `resolveOnlineLyric` 死代码 + `build-test.mjs` 三处入口 |
| 文档改动 | `README.md:47-49`（在线能力默认只交给音源脚本、这条规则没有例外、并写明静默代价）；`src/renderer/src/utils/settings-pages.ts:79` 的开关说明含五条路与"开关一关就没有例外" |

**未验证（三条覆盖缺口，本沙箱物理不可达，不得记为通过）**：

1. **`npm run test:e2e`** —— `tools/run-e2e.mjs` 第一步 `spawnSync(process.execPath, [electronVite, 'build'])` 即 `spawn EPERM`。本会话**审批提示已禁用**，无法提权。
2. **`npm run verify` 的 `build` 段** —— `electron-vite build` 经 esbuild JS API 需要 `spawn`，同一个 EPERM。已用直调 esbuild 二进制复刻入口清单跑通其余三步作为替代，但那**不等于** `electron-vite build` 通过：后者还要处理 `electron.vite.config.ts`、renderer 的 Vite 管线与 preload 打包，这些本沙箱一次都没验证过。
3. **真实音源的人工冒烟验证**（E7 契约里明确要求的一条）—— 需要一台真实桌面环境，且需要用户自己导入一个真实且获准使用的完整音源脚本。**这条是 AC1–AC7 里唯一没有任何机器证据的一项**，本沙箱连一个真实音源都装不进来。

**结论：E7 可以结项，但结项标注为「代码与文档改动完成、机器可验证部分全绿、三条覆盖缺口待真实环境关闭」。** 这三条与 E2 验收（m00770 暂停）是同一批操作，一次真实桌面环境的运行可以同时关掉。在那之前，AC3 的保证强度是：**宿主自身六条直连路径已被 7 条记录型断言与 1 次变异验证覆盖，脚本自身发出的请求不在范围内（E0 D1-a 有意取舍）。**

**E6 遗留（已于 2026-09-28 补做，见「E6 遗留项补做：按音源版本隔离平台缓存」）**：`更新后按音源版本隔离平台缓存` 当时未实现——Plan §Constraints 明写的一条，E6 结束时记录为开放项，E7 未处理，后在 E7 之后单独补做。**注意该补做的验证强度有明确边界**：5 条测试证明的是行为契约，**不是逐行覆盖**——三道版本防线串联冗余，变异验证三次全部未被抓到，详见该节。

#### 平台请求拦截检查：`tools/check-builtin-gate.mjs`（2026-09-28，用户 m02990 批准）

Plan 原文只写了"平台请求拦截检查"五个字，未定义通过标准。原提案是"人工看一眼"，被否决，改为**离线可重复脚本**。理由：人工检查不可重复、不进 CI、下次改动毫无保护；脚本能进 `npm run verify`，把这条保证变成每次改动都会被重跑的东西。

**为什么拦截点选在 `globalThis.fetch`，而不是各个入口函数。** `online/search.ts` 的 `httpGet`、`online/lyrics.ts` 的 `httpGet`、`url-guard.ts` 的 `safeFetchResponse` 都**直接调用全局 `fetch`，没有任何注入缝**。全局 `fetch` 是唯一能同时罩住"有缝的"和"无缝的"两类调用点、且无法被绕过的位置。站在这里，将来新加的直连调用也会自动落进记录，不需要有人记得去登记。

**为什么断言"尝试"而不是"返回值"。** `fetchOnlineLyric` 吞掉一切错误返回 `{ lyric: '' }`，而 `ArtistImageStore.resolve()` 把错误重新抛出——这两种形状与"被门拦下、返回空"在**返回值上无法区分**。记录写在替换后的 `fetch` 体内：函数被调用即算一次尝试，与调用方怎么处理结果无关。

**为什么"打开时必须非零"这半条不能省。** 只断言"关闭时为零"，一个根本没接线的替身也会通过——那就成了又一个"看起来验过其实没验"的东西，正是本任务要消灭的形状。所以每一条都跑两遍：关一次断言 0，开一次断言 >0。

**覆盖的七条**（`node tools/check-builtin-gate.mjs` → `7 passed, 0 failed`, EXIT=0）：

| 入口 | 关闭 / 打开 |
| --- | --- |
| 搜索（`SearchRouter.search`） | 0 / 1 |
| 热门搜索词（`SearchRouter.hotWords`） | 0 / 1 |
| 歌手头像（`ArtistImageStore` 构造处的受门解析器） | 0 / 4 |
| 歌词取词器（`onlineLyric` 的 platform 步骤 + `lyricDeps.fetchLyric`） | 0 / 1 |
| 歌词候选搜索（`lyricDeps.search` → `lyricCandidates`） | 0 / 3 |
| 标签匹配取歌词（`lyricsForMatch` 注入的取词器） | 0 / 1 |
| 歌单音质徽标（源码断言，见下） | PASS |

歌单徽标那一处**只能做源码断言**：它没有库函数接缝（门直接写在 IPC handler 里）。断言三条正则——门存在、开关被读 ≥3 次、以及"开关 → `fetchNeteaseDetails`"的先后关系。

**变异验证（已做，可信）。** 把产物 `out/test/online/search-router.js` 的 `if (!this.allowBuiltin())` 改成 `if (false)` → **恰好三条**失败（搜索、热门搜索词、歌词候选搜索，即所有经 `SearchRouter` 的入口），每条都打印出**真实平台 URL** 作为证据：

```
https://c.y.qq.com/soso/fcgi-bin/client_search_cp?w=%E6%99%B4%E5%A4%A9&p=1&n=20&cr=1&new_json=1&format=json&t=0
https://c.y.qq.com/splcloud/fcgi-bin/gethotkey.fcg?format=json&inCharset=utf8&outCharset=utf-8&notice=0&platform=yqq.json&needNewCode=0
https://music.163.com/api/search/get/web?s=晴天+周杰伦&type=1&offset=0&limit=20
https://search.kuwo.cn/r.s?all=晴天+周杰伦&ft=music&itemset=web_2013&client=kt&pn=0&rn=20&rformat=json&encoding=utf8
```

`MUT_EXIT=1`；还原产物后重跑 7/7。**这条变异证明的是：断言挂在真实调用路径上，且失败时能指出是哪条 URL 漏出去的。**

**已接入 `npm run verify`**：新增 `"check:gate": "node tools/check-builtin-gate.mjs"`，`verify` 改为 `typecheck && build && test && check:gate`。放在最后是因为它依赖 `out/test/` 的构建产物（`test` 刚建好）。

**本脚本覆盖不到的四条（读结论时必须一起看）**：
1. **歌单徽标与 `index.ts` 内的几处注入只能源码断言**——`index.ts` 无法被任何测试导入（模块顶层执行 `app.getPath` 与 `fileURLToPath`）。源码断言挡不住"保留字符串、丢掉行为"的重构。
2. **音源脚本自己发起的请求不在范围内**——这是 E0 D1-a 的有意取舍（网络全局对脚本可用）。本脚本证明的是"宿主自己不发请求"，不是"脚本不发请求"。
3. **不能替代 `npm run test:e2e` 与人工冒烟**。
4. **`driveHotWords` 会用真实解析器解析一次 DNS**（`assertPublicHttpUrl` 走系统解析器，不经过被替换的 `fetch`），因此 stderr 有两条预期噪音：`热门搜索词获取失败 tx 拦截检查：这条请求不该发出`、`艺术家头像获取失败 周杰伦 拦截检查：这条请求不该发出`。**没有真实请求发出**——被替换的 `fetch` 在发出前就抛了。

**实现时踩到的三个真问题（都是这条脚本自己暴露出来的）**：
1. `import('./online/artist-image.js')` 这种**相对说明符会冲着脚本自己所在目录（`tools/`）解析**，不是冲着 `out/test/`，拿到的是另一个模块实例——它的 `fetch` 不是被替换过的那个，记录永远为零。必须用 `pathToFileURL` + 绝对路径。这正是脚本设计时预判的头号风险，实测确实踩中。
2. **"打开"那一半必须 `await` 完再数数**：请求发生在第一个 `await` 之后，同步读 `attemptCount()` 永远是 0。第一次写就对，靠的是这条正向断言报错——这也正说明它为什么必须存在。
3. `rm` 必须从 `node:fs/promises` 导入（`node:fs` 的是 callback 风格，返回 `undefined`，`.catch` 直接 TypeError）。

#### E2-3 前置修复：共享宿主的 IPC fork 参数缺陷（2026-09-28）

**缺陷**：`src/main/sources/source-runtime-host.ts:357` 原文为

```ts
state.child = fork(this.hostPath, [initPath, scratchDir], { stdio: [...], execArgv: [...] })
```

`source-host.ts:71-74,103-108` 声明的启动契约是 `argv[2] = 脚本路径`、`argv[3] = init.json`、`argv[4] = scratchDir`。这里**只有两个参数、脚本路径整个缺失**，子进程遂把 `initPath` 当脚本、把 `scratchDir`（一个目录）当 init 文件；`readInit()` 里 `readFileSync(initPath)` 对目录抛错 → catch 返回 `null` → `source-host.ts:122-125` `process.exit(2)`。

**后果**：**非 Windows 平台（IPC 模式）共享宿主从未成功启动过任何脚本**。win32 走 `restricted-launch.ts:122` 的文件模式（那条传对了三个参数，`fork` 甚至不被调用，走 `spawn`），所以生产未受影响、用户不会察觉。

**为什么类型系统抓不到**：`fork(modulePath, args)` 的签名接受**任意字符串数组**，两个元素与五个元素同样合法；失败发生在子进程内部，表现为"脚本坏了"而不是"宿主坏了"。

**修法**：改为 `fork(this.hostPath, [scriptPath, initPath], {...})`，并在上方加注释记录原值、后果与"为什么签名抓不到"。

**验证（`out/test/probe-ipc-argv.mjs`，隔离探针）**：

| 步 | 观察值 |
| --- | --- |
| 基线 | `args = ["...\script.js", "...\init.json"]` |
| 变异（把三份产物里的调用点改回 `[initPath, initPath]`） | `args = ["...\init.json", "...\init.json"]` → **MUTATION CAUGHT** |
| 还原 | 回到基线，`still broken on disk: none` |
| 文件模式 | `fork` 从未被调用（`null`）——文件模式走 `spawn`，故此处不覆盖 |

**探针本身踩了三个坑，都是"看起来验过其实没验"的形态**：
1. `import('node:child_process')` 返回**冻结的 ESM 命名空间对象**，`spawn.fork = stub` 直接抛 `TypeError: Cannot assign to read only property 'fork'`。必须用 `createRequire(...)` 拿可写的 CJS 对象，改完再 `syncBuiltinESMExports()`——**漏掉 sync 时宿主仍持原绑定，探针一条都记录不到却照样打印 PASS**。
2. **变异与基线跑在同一个热模块里，第二次 `start()` 不会重新执行被测代码** → 变异"没被抓到"，尽管产物确实改了。第一次误判即由此而来。修法：每次观察用 `?v=N` 让导入缓存失效。
3. **不能改用子进程求干净隔离**：`spawnSync(process.execPath, ...)` 在沙箱返回 `err.code === 'EPERM'` 且 stderr 为空（Node 不能派生 Node），故只能进程内观察。

**另一条教训（通用）**：每个入口点独立打包，`jj-provider-engine.js` 会**内联自己那份 `SourceRuntimeHost`**（`var SourceRuntimeHost = class` 在同文件 18378 处）。故**只改 `source-runtime-host.js` 证明不了任何事**——被执行的是另一份副本。变异必须覆盖所有含调用点的产物（本仓库为 3 份：`jj-provider-engine.js`、`source-engine.js`、`source-runtime-host.js`）。

**同时修正了两处不成立的断言**：
- 原第二条断言"两个参数在盘上存在且是文件"**必然失败**：stub 让子进程立刻"死掉"，`start()` 的 finally 清理了 `mkdtemp` 临时目录。已删除，改断言"第二个参数不是目录"。
- 原注释称"文件模式同样会走这道检查"是错的——文件模式不调用 `fork`。已改为一条正向断言 `file mode never routes through fork`。

**回归**：全量 **40 通过 / 7 失败 / 47 套件**，失败清单与修复前逐条一致（全部 `spawn EPERM`）。`npx tsc --noEmit -p tsconfig.node.json --composite false` → EXIT=0。

**未验证**：本沙箱无法真正启动 IPC 子进程（`spawn EPERM`），故**"修复后 IPC 模式下脚本能真正启动"未经端到端证实**；验证到的是"传给 `fork` 的参数正确"。`jj-provider-engine.test.mts` 末尾的同款断言在套件内**够不着**（套件在第二节 `音源初始化超时（15s）` 处即中止，那是既有的 EPERM 失败），因此同一组断言由隔离探针实际执行。

#### E2-3 本体：LX 引擎委托共享宿主（2026-09-28）

**开工前的两项裁决（用户 m04240，均按推荐档）**：

| 项 | 选定 | 备选与被否决理由 |
| --- | --- | --- |
| 委托范围 | **只做启动/生命周期委托** | 连请求派发一起委托（`requestFrom` → `host.request`）会改动 LX 的 wire payload；`host.request` 内部是 JJ 形状 `{requestKey, capability, providerId, payload}`，而 `send(state,id,source,action,info)` 才是 LX 形状。请求侧保持原样，把"两台引擎共用一套生命周期"与"两套协议各自成型"分隔开 |
| init 语义 | **`buildInit` 的 `source` 改为可选** | 让 LX 也发一个 `source` 字段等于**协议变更伪装成重构**——脚本会按字段存在与否分支。放宽返回类型为 `{ source?: string; version: string }`，LX 回调照旧不填，**对脚本可见的 init.json 逐字节不变** |

**委托链最终形态**（`src/main/sources/source-engine.ts`，1366 → 821 行）：

| 原自有实现 | 现在由谁做 |
| --- | --- |
| `mkdtempSync` + 写 `script.js`/`init.json` | 宿主 `start()` |
| `fork` / `launchRestricted` 两条启动分支 | 宿主 `start()` |
| `INIT_TIMEOUT_MS` 初始化超时 | 宿主 `createReadyPromise()` |
| `attachIpcLifecycle` / `attachFileProtocolLifecycle` | 宿主内（`attachIpcLifecycle`/`attachFileLifecycle`） |
| 心跳看门狗（20 s 静默 → 隔离） | 宿主 `checkHeartbeat()` |
| `handleChildExit` 崩溃三分类（abort / 退出码 1 / 普通） | 宿主 `handleChildExit()` → 回调 `onExit(state, info)` |
| `handleMessage`（ready / boot-error / log / response） | 宿主内 |
| `failAllPending` + `pending` + `nextId` | 宿主 `request()` / `send()` |
| `teardown`（删 scratchDir、`killChildTree`、SIGTERM→SIGKILL 等待） | 宿主 `teardown(state, reason)` |
| 请求派发 `writeRequest` vs `child.send` | 宿主 `send()`（按 `state.fileMode` 自动选择） |
| `captureLog` + 200 行环形缓冲 | 宿主 `onLog` 回调 + 本引擎 `pushLog()` |

删除的方法/类型：`captureLog`、`attachIpcLifecycle`、`attachFileProtocolLifecycle`、`handleChildExit`、`handleMessage`、`failAllPending` 六个方法；`HostMessage`、`RawSourceInfo`、`PendingRequest` 三个 interface；`HEARTBEAT_SILENCE_LIMIT_MS`/`supportsRestrictedLaunch`/`REQUEST_TIMEOUT_MS`/`EXISTS` 等一批重复常量与 import。

**策略留在引擎里**（这正是"不该被委托掉"的部分）：启动前静态校验与隔离、崩溃后 `enabled` 标志何时回退、平台归属索引（`rebuildOwners` 的排序规则）、品质阶梯（`buildQualityLadder`）、多源故障转移（`requestWithFallback`）。

**给宿主补的两个缺口**（LX 引擎有、宿主原本没有，不补就是回归）：

1. `start()` 开头的 `existsSync(this.hostPath)` 预检与那条打包报错文案（`source-host.js` 必须在 asar 之外）。
2. `fork` 分支的 `cwd: dirname(this.hostPath)`。宿主在求值脚本时会 `require` `iconv-lite`/`music-metadata`；cwd 若指向 scratchDir，这些裸标识符会解析失败，子进程在跑任何脚本前就死于 `Cannot find module 'iconv-lite'`——看起来像脚本坏了。win32 走文件模式恰好掩盖了这一点。

`MAX_LOG_LINES = 200` 改为 `export`：两份各自定义的环形上限会让设置页显示的历史量取决于谁捕获了某行。

**委托途中发现并修掉的真回归（必须记住）**

`host.start()` 在 **fork/spawn 阶段就失败**（`spawn EPERM`、解释器缺失）或**初始化超时**时，是**从 `start()` 直接 reject**、此时引擎还没来得及建立 runtime 记录。原自有实现把失败记在 `settle()`/`attachIpcLifecycle` 里，那段代码随委托一起消失后——

> **脚本的存储记录不再留下任何失败痕迹，设置页表现为静默失败。**

已补：`await host.start(...)` 外面包一层 catch，`setError` + `setEnabled(false)` + `rebuildOwners` + `sourcesChanged`/`scriptError` 后重抛。

**这个回归是被既有测试抓到的，不是我读代码看出来的**——`source-engine` 套件的 `the failure was recorded on the script` 从 PASS 变 FAIL。若不跑全套，它会直接进生产。

**基线对照（`git stash` 实测三次，非推断）**

| 状态 | `source-engine` 套件结果 | 失败项 |
| --- | --- | --- |
| 委托关闭（基线） | **110 passed / 1 failed** | `restricted-mode sources are advertised`；`only the requested script actions were dispatched`（后者是测试桩形状所致，见下） |
| 委托打开（补 start 失败处理**之前**） | 107 passed / 4 failed | 上两条（第二条变为 dispatch=0）+ `the failure was recorded on the script` + `no request was sent to the dead script` + `a source that starts then dies is reverted to disabled` |
| 委托打开（补**之后**） | **110 passed / 1 failed** | 仅 `restricted-mode sources are advertised` —— 与基线**同名同数** |

**测试桩的形状变更（两个文件，都是运行时才炸）**

`ScriptRuntime` 从扁平结构 `{api, child, scratchDir, sources, ready, pending, nextId, dead, logs, …}` 改为 `{api, host, sources}` 后，测试里手工构造的桩仍是旧形状：

| 文件 | 症状 | 修法 |
| --- | --- | --- |
| `src/test/source-engine.test.mts:461-471` `fakeRuntime()` | `TypeError: Cannot read properties of undefined (reading 'dead')` at `rebuildOwners` | 包成 `{api, host:{dead,sources,pending,nextId,logs,scratchDir}, sources}` |
| `src/test/source-engine.test.mts:604` `stalledRuntime.child = {...}` | 同上（`send` 挂错层） | 改 `stalledRuntime.host.child` |
| `src/test/source-engine.test.mts:577` `runtimes.get('c').dead = true` | 死源未被跳过 | 改 `.host.dead = true` |
| `src/test/downloads-import.test.mts:89` 内联桩 | 同上 | 同款包法；该套件随之 **24/1 → 25/25** |

**这类"桩形状"变更的危险在于它是运行时才炸、且编译期完全合法**（测试文件里 `engine.runtimes = new Map([...])` 走的是 `any` 路径）。若非跑了全套，第一处会在任何一次真实运行里以"引擎坏了"的形式爆出来。

**验证证据**

| 项 | 结果 |
| --- | --- |
| `npx tsc --noEmit -p tsconfig.node.json --composite false` | **EXIT=0** |
| `npx vue-tsc --noEmit -p tsconfig.web.json --composite false` | **EXIT=0** |
| `source-engine` 套件 | **110 passed / 1 failed**（与基线同名同数） |
| `downloads-import` 套件 | **25 passed / 0 failed** |
| 全量回归 | **40 通过 / 7 失败 / 47 套件**，失败清单与委托前逐条一致（全部 `spawn EPERM`） |

**未验证（不得记为通过）**

1. **IPC 传输路径本环境一次都跑不到**——`spawn EPERM` 使 `fork` 分支根本无法执行。委托后该分支的正确性只由 `out/test/probe-ipc-argv.mjs`（前置修复时写的隔离探针，验证的是"传给 `fork` 的参数正确"）间接背书，**不是端到端证明**。
2. `npm run test:e2e`、`npm run verify`、`npm run test` 在本沙箱均跑不通（同一 `spawn EPERM` 根因）。
3. 真实音源的手工冒烟未做。

## 5. 主要风险

1. `src/main/index.ts` 已 111657 字节，E3/E4/E5 都要改它。建议各任务内先做局部抽取，避免继续堆叠。
2. **AC3 是破坏性行为变更**：禁用所有完整音源后内置平台请求不得再发出。现有测试中 `search-merge`、`hot-words`、`lyrics-search`、`online-qualitys` 等会直接受影响，须在 E3 同步改写，不做事后修补。
3. **旧曲目兼容**：`providerId` 为可选字段，历史曲目永远为 `undefined`。E4 播放路径若不显式处理该分支，老用户曲库播放会回归。

## 6. 与需求文档的对应

本 Plan 不修改 AC1–AC7 与 §6 Scope/Constraints 的定义，仅新增 E0 并固化 §9 四项决策。AC 原文见 [Requirement Document §7](source-bound-online-capabilities.md)。
