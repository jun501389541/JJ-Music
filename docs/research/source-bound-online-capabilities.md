# 在线能力与音源绑定：Requirement Document

日期：2026-09-28　状态：Research 完成，Plan 已评审定稿（见 [实施 Plan](source-bound-online-capabilities-plan.md)）　范围：JJ Music 在线音乐能力（非播放器自身升级）

## 1. Goal

让平台接口的实现、解析和更新由用户安装的音源提供。播放器负责调用、展示、缓存、下载和安全边界；平台改版时，音源作者可独立发布修复，用户确认安装新版音源后即可恢复对应在线能力，无须等待播放器发版。

用户已确认两项决策：

1. 搜索、播放、歌词、封面、榜单、歌单等在线能力全部交给音源。
2. 发现音源新版本时提示，由用户确认后安装；不静默执行新版脚本。

这里的“同步平台最新更改”指 **音源可独立更新平台适配逻辑**，不保证第三方平台接口永远可用，也不代表安装旧版 LX 音源就会自动获得搜索、榜单等能力。

## 2. Current State 与证据

| 现有能力 | 当前实现 | 迁移影响 |
| --- | --- | --- |
| 音源运行与播放地址 | `src/main/sources/source-engine.ts` 按平台汇集多个 LX 音源，处理 `musicUrl`、`lyric`、`pic`；`src/main/sources/source-store.ts` 保存 LX `user_api.json` | 保留 LX v2 运行协议；新增完整音源协议与按能力路由。|
| 在线搜索、聚合搜索 | `src/main/online/search.ts` 内置五个平台请求；`src/main/index.ts` 的 `musicSearch*` IPC 直接调用它 | 改为枚举已启用且声明 `search` 的音源；聚合由宿主做。|
| 热词 | `src/main/online/hot-words.ts` 内置四个平台端点和按日缓存 | 请求交音源；缓存策略保留在宿主。|
| 在线歌词与封面 | `src/main/online/lyrics.ts`、`cover-fetch.ts`、`src/main/index.ts` 的 `musicEnrich`；`src/main/library/lyric-service.ts` 有多来源顺序 | 平台请求交音源；用户本地 `.lrc`、内嵌标签、缓存和来源记录由宿主保留。|
| 歌单导入 | `src/main/online/playlist-import.ts` 负责各平台链接、分页和曲目转换；`src/main/index.ts` 负责预览与保存 | 音源负责识别及读取平台歌单；本地预览、选择、保存继续由宿主负责。|
| 艺术家头像、元数据匹配 | `src/main/online/artist-image.ts`、`src/main/library/artist-images.ts`、`metadata-match.ts` 仍直接请求或调用内置搜索 | 改走音源能力路由；缺少能力时显示无结果，不绕开音源请求平台。|
| 排行榜/榜单 | 当前 `src/main`、`src/renderer/src` 未发现现成榜单业务页面 | 属于新增 UI 与数据契约，不应当算作“迁移已有功能”。|
| 搜索页平台标签 | `src/renderer/src/views/SearchView.vue` 从内置 `searchProviders()` 获取 | 改为能力注册表；无 `search` 的音源不出现在搜索标签。|
| 下载及跨平台播放兜底 | 下载通过 `SourceEngine.getMusicUrl`；播放器可跨平台搜索同一首歌 | 保留宿主下载与匹配逻辑，但搜索/解析必须走能力路由并保留曲目来源。|

`src/shared/types.ts` 的 `SourceAction` 虽列出 `search`、`hotSearch`、`songList`、`leaderboard` 等字符串，当前 LX 协议实际只有 `musicUrl`、`lyric`、`pic`；类型名称不能视为已有协议实现。尤其 LX v2 的 `lyric` / `pic` 主要面向 `local` 伪平台，不能据此假设现有 LX 脚本可以承担真实平台全部在线能力。

当前曲目只稳定保存 `source`（平台 ID）及 `meta`，没有“产生该曲目的音源实例 ID”。同一平台有多个音源时，搜索来自 A 而播放落到 B 可能出现 ID、签名参数不兼容。这是绑定设计的核心数据迁移点。

安全现状：音源代码在独立子进程中运行，有启动前静态检查、隔离/停用和请求超时；独立进程主要隔离崩溃，不能当作不可信代码的完整操作系统沙箱。导入 URL 经过公共 HTTP URL 检查和有界抓取。封面下载与艺术家头像另有 `COVER_HOSTS` 等平台白名单；新音源的图片域名不能直接复用静态表。

## 3. GitHub 案例与可借鉴点

| 案例 | 已核实做法 | 对 JJ Music 的启发 |
| --- | --- | --- |
| [MusicFree](https://github.com/maotoumao/MusicFree) 及其[插件协议](https://musicfree.catcat.work/plugin/protocol.html) | 插件分别实现搜索、播放地址、歌词、歌单、榜单等可选方法；缺失的方法决定 UI 是否展示该能力；分页、缓存由播放器处理。桌面版[插件管理器](https://github.com/maotoumao/MusicFreeDesktop/blob/master/src/shared/plugin-manager/main/index.ts)记录支持的方法并通过 IPC 调用。 | 采用“能力声明 + 宿主统一编排”，避免一个音源缺少榜单就导致其他能力不可用。 |
| [LX Music](https://github.com/lyswhut/lx-music-desktop) 的[官方自定义源文档](https://lxmusic.toside.cn/desktop/custom-source)及[协议类型](https://github.com/lyswhut/lx-music-desktop/blob/master/src/common/types/user_api.d.ts) | 普通平台自定义源声明 `musicUrl`；`local` 可声明 `lyric`、`pic`。脚本通过 `inited` 报告平台与音质，通过 `request` 收到解析任务。`updateAlert` 提示更新并给出链接。 | 继续兼容导入、事件交互和播放解析；不能通过重命名 action 让旧脚本实现搜索。 |
| [Listen 1](https://github.com/listen1/listen1_chrome_extension) | 多平台搜索、播放和歌单在各平台 provider 中组织，并支持跨平台播放源切换；其 README 的平台问题修复仍随项目代码发布。 | 平台级模块化有利于维护，但若模块随应用打包，平台变更仍需播放器更新；不满足本次独立更新目标。 |

### 3.1 LX Music 与本次目标的具体对照

| 问题 | LX Music 的已核实方案 | JJ Music 的规划取舍 |
| --- | --- | --- |
| 平台搜索、歌单、榜单由谁实现？ | [自定义源协议](https://lxmusic.toside.cn/desktop/custom-source)没有这些 action；应用向脚本提供已经取得的 `musicInfo`，脚本解析播放地址。由此可见自定义源不承担这些平台目录能力。 | 用户要求这些能力随音源更新，因此在新 `jj-source` 协议中定义为独立可选方法；宿主只做聚合和展示。 |
| 如何识别源支持的内容？ | 脚本 `inited` 上报平台、`actions`、`qualitys`；[源码](https://github.com/lyswhut/lx-music-desktop/blob/master/src/renderer/core/useApp/useInitUserApi.ts)把声明的 action 装配到播放器调用接口。 | 沿用能力声明和初始化握手的思路，但为搜索、歌词、歌单、榜单等单独定义输入输出和 UI 可见性。 |
| 如何兼容已有脚本？ | 旧脚本依赖 `globalThis.lx`、`lx.version`、`musicUrl` 的字段和质量类型。 | LX 运行时及 `user_api.json` 保持原约定；新协议使用独立版本，不把 JJ 方法塞入 LX action 列表。 |
| 平台改版如何更新？ | [官方文档](https://lxmusic.toside.cn/desktop/custom-source)的 `updateAlert` 传 `log` / `updateUrl`；[桌面代码](https://github.com/lyswhut/lx-music-desktop/blob/master/src/renderer/core/useApp/useInitUserApi.ts)显示提示，确认后打开更新地址。 | 借鉴提示交互，增加版本检查、确认安装、校验、原子替换和失败回退；用户已选择确认后更新。 |

**结论：** LX Music 是 JJ 当前兼容策略的直接参考，也是新设计必须守住的兼容基线。若完整照搬 LX 的“播放器负责目录数据、音源负责播放解析”分工，平台搜索、榜单、歌单接口变化仍要修改播放器代码，不能满足这次“全部跟音源绑定”的目标。MusicFree 的能力模型更适合作为扩展部分的参考；其具体协议、代码和第三方插件不能直接复制到 JJ 的 LX 兼容运行时。

## 4. Options 与架构兼容性

| 方案 | 做法 | 与现有架构兼容性 | 代价与风险 |
| --- | --- | --- | --- |
| A. 内置平台模块独立更新 | 把 `src/main/online/*` 打包为可更新的适配模块，LX 音源仍只管播放 | 对现有 UI、曲目模型改动较小 | 在线功能并未“跟用户音源绑定”；宿主仍维护各平台接口、模块分发和可信更新链。与已确认目标不符。 |
| B. 新增 JJ 完整音源协议，保留 LX v2 桥接 **（推荐）** | 新协议声明可选能力；按 `providerId` 追踪曲目来源；所有平台请求迁到音源。LX v2 仍可作为播放解析型音源 | 复用现有子进程、SourceStore、IPC、搜索 UI、缓存、歌单保存框架；需要改造路由、曲目持久化和若干服务 | 工程量较大，需要至少一个真实完整音源作端到端验证；旧 LX 脚本不会自动支持搜索等新能力。 |
| C. 直接扩展或替换 LX v2 协议 | 把 `search`、榜单等塞进 LX `sources.actions`，所有脚本走一个运行时 | 表面改动较少 | 会把 JJ 私有协议伪装成 LX，造成版本/行为误判；旧音源未实现新 action；未来上游兼容难维护。 |

**推荐 B。** 为 JJ 完整音源另设协议标识与版本，LX v2 接口行为保持一致。过渡期先并行接入；全部入口迁完后，默认在线平台请求只由已启用音源发起。旧 LX 音源保留其已具备的解析能力，搜索、榜单等入口按能力隐藏或明确提示缺少完整音源。不能把当前内置平台请求留作静默兜底，否则用户无法判断当前用的是哪一版音源，目标也无法验收。

## 5. 推荐设计

### 5.1 协议与路由

定义 `jj-source` 独立 API 版本（从 `1` 起），同一音源可声明一个或多个平台，每个平台列出支持的能力。首版能力建议：

| 能力 | 输入/输出要点 | 宿主职责 |
| --- | --- | --- |
| `searchTracks` | 关键词、页码 → 标准曲目页、结束标记 | 跨源并发、去重、取消和错误汇总。 |
| `resolveTrack` | 音源自己的曲目 ID/有限元数据、音质 → URL、必要请求头、有效期 | 质量回退、URL 校验、播放和下载。 |
| `getTrackDetail` / `getLyrics` / `getCover` | 曲目 → 可选详情、歌词、封面 URL | 缓存、歌词来源顺序、封面抓取及来源记录。 |
| `getHotWords` | 平台 → 词条列表 | 按日缓存、跨源合并；无能力则隐藏热词行。 |
| `parsePlaylist` / `getPlaylist` | URL 或 ID → 歌单标识、分页曲目、封面 | 有界分页、预览、用户选择后保存本地快照。 |
| `listCharts` / `getChartTracks` | 榜单列表及分页曲目 | 新增榜单页面和加载状态；无能力则隐藏该音源榜单。 |
| `findArtistImage`（可选） | 艺术家名/ID → URL | 本地头像缓存和安全抓取。 |

搜索结果与歌单曲目统一携带持久化 `providerId`、`platformId`、`nativeId`、标准展示字段，以及有限大小的 `providerData`。后续播放、歌词、封面优先回到**产生该曲目的同一音源**。只有明确声明兼容该曲目格式或通过宿主跨平台重新匹配，才允许换音源兜底；不能仅凭平台 ID 把私有曲目对象直接交给另一个脚本。旧曲目无 `providerId` 时走兼容迁移分支，保留其现有 `source`/`meta`，并给出可恢复的失败提示。

能力注册表从“已启用、初始化成功的音源 + 实际声明的方法”生成。方法缺失、超时、取消、错误、空结果必须区分；UI 只显示支持的操作，不能把缺少能力解释成“平台无内容”。宿主继续管搜索聚合、缓存、请求取消、超时、下载、本地列表以及同曲匹配。

### 5.2 音源更新

安装时记录来源 URL、音源 ID、版本和本地校验值。仅对用户明确指定更新来源的音源检查新版；检查只读取有限大小的版本元数据，不执行新脚本。发现新版后展示来源、版本、能力变化、校验结果和主要风险提示；用户确认后下载、静态检查、保存旧版、原子替换并重新初始化。失败则恢复旧版并说明原因。更新提示脚本本身可以提供，但不能直接触发下载与执行。远程清单里的 SHA-256 只能校验下载一致性，不能单独证明发布者身份；若未来需要无人值守更新，需另行设计签名及信任根。

现有 `source-store.ts` 的“同名覆盖”以及最多 20 个 LX 音源等规则，不宜直接充当完整音源的稳定 ID 和更新策略；协议和存储格式需显式版本化。更新成功后清理或按音源版本隔离平台缓存，避免旧响应掩盖新修复。

### 5.3 安全及数据边界

继续使用独立子进程、启动前校验、请求超时和隔离机制。新增协议所有输入输出都要做运行时结构校验、大小上限和错误归一化；脚本返回 URL、图片、歌词、歌单时由宿主执行公共地址和下载校验。网络访问范围与凭据能力单独设计，首版不引入平台账号登录。音源更新需用户确认且可回退。不要把任意脚本代码、登录凭据或整份平台响应写入曲目/歌单持久化记录。

## 6. Scope / Constraints

**包含：** 当前已有的在线搜索、播放解析、热词、歌词、封面、歌单导入、艺术家头像、元数据匹配、下载所需在线数据入口；新增可选榜单展示；音源检查更新与确认安装；LX 兼容迁移与清晰的能力提示。

**不包含：** 播放器本体在线升级、平台账号登录/私密歌单同步、自动静默执行第三方脚本、承诺任何平台接口长期有效。用户本地曲库、标签写入、播放列表与缓存仍由播放器管理。

**约束：**

- 保留 LX v2 旧脚本的既有调用约定及可读 `user_api.json`；新增协议不能冒充 LX 版本。
- 默认在线平台请求不再由内置 `online/search.ts`、`lyrics.ts`、`hot-words.ts`、`playlist-import.ts` 等直接完成；迁移期可有受控开关，但最终默认关闭且无静默兜底。
- 旧 LX 音源只有其原本声明的能力；没有完整音源时，搜索/榜单/歌单等显示缺少能力，不虚构结果。
- 曲目、下载任务、歌单快照和会话恢复必须能识别音源来源；旧数据可读取，不丢失本地列表。
- 新增榜单首版只浏览与播放，不涉及平台账号或收藏同步。

## 7. Acceptance Criteria 与 Verification

| 编号 | 可观察条件 | 验证方式 |
| --- | --- | --- |
| AC1 | 完整音源仅声明 `searchTracks` 时可被搜索，榜单/歌单入口不展示；声明全部能力时各入口出现。 | 假音源能力矩阵的单元/IPC 测试与 UI 检查。 |
| AC2 | 搜索、歌单、榜单产生的曲目在重启后仍能由原音源解析播放、歌词与封面；同平台多个音源不会串用不兼容 ID。 | 两个同平台假音源 + 持久化重启集成测试。 |
| AC3 | 禁用所有完整音源后，内置平台搜索/热词/歌词/歌单请求不再发出；旧 LX 音源仅显示实际可用能力。 | 拦截网络请求的端到端测试；能力 UI 检查。 |
| AC4 | 音源超时、崩溃、取消和不合法响应不会使播放器或其他音源失效；URL/图片抓取遵守地址与大小限制。 | SourceEngine 故障注入、协议契约和 SSRF 回归测试。 |
| AC5 | 发现新版只提示；确认后更新；校验或初始化失败恢复旧版；拒绝更新不会执行新代码。 | 本地测试服务器提供新旧/损坏脚本，检查运行版本和持久化记录。 |
| AC6 | 已保存的 LX 曲目、下载记录和本地歌单可加载；无法解析时说明缺少能力或音源。 | 旧版本数据夹具迁移测试与手工回归。 |
| AC7 | 榜单浏览、歌单导入、热词、在线歌词/封面、本地曲目在线匹配都只经能力路由获取平台数据。 | IPC/服务依赖检查、假音源全链路测试，`npm run verify`、`npm run test:e2e`。 |

## 8. Engineering Tasks / Executor Implementation Tasks

以下任务按接口依赖排序；每项完成后独立 Review。任务中建议文件是当前入口，实际实现可调整，但不得绕过验收条件。

### E1. 协议、曲目来源与兼容数据模型

- **Goal / Scope：** 定义版本化 `jj-source` 能力、请求/响应 schema、`providerId` 曲目来源和旧记录读取策略；不接真实平台请求。
- **依赖 / 建议位置：** 无；`src/shared/types.ts`、源元数据类型、持久化曲目及歌单读取处。
- **交付接口：** 能力表、标准曲目/歌单/榜单 DTO、迁移策略和供后续任务使用的契约测试夹具。
- **验收 / 验证：** 旧 LX 数据原样可读，新曲目重启后保留音源 ID；畸形/过大字段拒绝。运行契约与迁移测试、`npm run typecheck`。

### E2. 完整音源运行时、能力注册表与请求路由

- **Goal / Scope：** 基于现有子进程边界增加独立协议加载、方法声明、请求取消/超时、响应校验和同音源路由；保持 LX v2 原调用行为。
- **依赖 / 建议位置：** E1；`src/main/sources/source-engine.ts`、`source-host.ts`、`source-store.ts`。可拆为独立 `jj-provider-engine`，避免修改 LX 的 `lx.version`。
- **交付接口：** `listCapabilities()`、按 `providerId` 调用能力、错误/健康状态、假音源开发样例。
- **验收 / 验证：** AC1/AC2/AC4 中的路由与故障条件；两个同平台假音源并行测试、原有 `source-engine.test.mts` 回归。

### E3. 搜索、热词与本地匹配迁移

- **Goal / Scope：** 搜索标签、全平台聚合、热词缓存、本地元数据/歌词匹配改走 E2；最终移除默认内置平台请求。
- **依赖 / 建议位置：** E2；`src/main/index.ts`、`online/search.ts`、`online/hot-words.ts`、`library/metadata-match.ts`、`library/lyric-service.ts`、`SearchView.vue`。
- **交付接口：** 可复用的在线查询服务，供播放器和本地曲库调用。
- **验收 / 验证：** AC1/AC3 中搜索与热词、AC7 的本地匹配；无完整音源时清晰空状态，假音源/网络拦截测试。

### E4. 播放、歌词、封面、下载与艺术家图像迁移

- **Goal / Scope：** 保持搜索结果的音源归属直至播放和下载；在线歌词/封面/艺术家头像调用音源，宿主继续执行安全抓取和来源记录。
- **依赖 / 建议位置：** E2、E3；`src/main/index.ts`、`src/main/downloads/download-manager.ts`、`src/main/library/artist-images.ts`、`src/renderer/src/stores/player.ts`。
- **交付接口：** 统一曲目详情/媒体解析服务，复用现有播放队列与下载器。
- **验收 / 验证：** AC2/AC4/AC7 对应部分；同平台双音源、坏 URL/图片、重启恢复、旧 LX 曲目回归。

### E5. 歌单导入与榜单

- **Goal / Scope：** 歌单 URL 识别、分页与曲目由音源返回；保留本地预览/保存；新增能力驱动榜单页面。
- **依赖 / 建议位置：** E2、E4；`src/main/online/playlist-import.ts`、`src/main/index.ts`、歌单视图和新榜单视图。
- **交付接口：** 统一歌单/榜单 DTO 与分页能力；无能力时不展示入口。
- **验收 / 验证：** AC1/AC2/AC7 对应部分；分页、重复项、空结果、超限数据和封面失败测试，`npm run test:e2e`。

### E6. 音源版本检查、确认更新与回退

- **Goal / Scope：** 只检查用户指定来源；展示版本/能力变化；确认后下载校验、原子替换、重新初始化；失败回退。
- **依赖 / 建议位置：** E1、E2；`source-store.ts`、导入 URL IPC、`SourcesView.vue`、`source-validator.ts`。
- **交付接口：** 更新状态、来源和版本记录、回退入口/诊断信息。
- **验收 / 验证：** AC5；本地 HTTP 测试源覆盖拒绝、校验失败、超时、初始化失败、成功和重启后版本保持。

### E7. 迁移收口与发布 Review

- **Goal / Scope：** 查找并切断剩余平台直连调用，更新设置、帮助文案和旧音源能力说明；用至少一个真实、获准使用的完整音源做手工冒烟验证。
- **依赖 / 建议位置：** E3–E6；`README.md`、Sources/Search/Settings 等 UI、`src/main/online/*` 余留模块。
- **交付接口：** 迁移说明、旧数据回归记录、全功能验收记录。
- **验收 / 验证：** AC1–AC7；`npm run verify`、`npm run test:e2e`、平台请求拦截检查及人工操作记录。

## 9. Open Questions / 实施门槛

以下四项已于 Plan 评审时决策定稿，全部采用原建议方案；结论作为 E1–E7 的硬约束，实现在此不再自行假设：

1. **来源信任（已决策）**：完整音源首版只允许“用户主动导入 + 显式启用”，不建官方目录，不引入可信发布者机制。
2. **LX 兜底（已决策）**：旧 LX 音源仅在曲目具备可验证的 LX 字段、且用户显式开启兜底时用于同平台播放；否则同音源失败即提示，或走宿主的跨平台同曲匹配。
3. **榜单范围（已决策）**：首版只做“按音源浏览榜单和曲目”，不做榜单订阅与定时同步。
4. **网络权限（已决策）**：完整音源的网络权限与 URL 安全边界**单独立项为 E0 研究任务**，与 E1 并行执行；E2 实现前必须逐条引用 E0 结论，不得从代码反推边界。E0 交付 `jj-source-permission-and-url-security.md`。

E0 的结论同时约束 E4（宿主执行 URL/图片抓取校验）与 E6（更新来源信任边界），因此不并入 E2 实现。
