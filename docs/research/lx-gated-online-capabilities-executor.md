# JJ Music：由 LX 音源启用在线能力的 Requirement 与 Executor Plan

日期：2026-10-03  
状态：需求决策已确认，供 Executor 分阶段开发和 Review  
基线：`7bedfaf`。本文取代旧方案中“另写完整 `jj-source` 音源才能获得在线能力”的实施方向；旧研究文档保留为决策历史。本文不代表产品代码或验收已经完成。

## 1. Goal 与用户场景

用户希望直接使用维护中的 LX Music 自定义源脚本，无需另找人编写 JJ 专属完整音源。没有已启用的在线音源时，JJ Music 是本地音乐播放器；启用音源后，才开放它声明的平台的在线歌曲能力。在线播放时可以在应用内进入相关艺术家、专辑详情。在线歌单搜索、排行榜、只读歌曲评论是后续功能。

**绑定的含义：**LX 脚本负责它声明平台的播放地址，JJ Music 的平台适配器负责搜索、歌词、封面和目录数据；音源的启用与健康状态决定对应平台的在线能力是否可用。脚本更新不能修复 JJ Music 内置适配器的接口变化，后者必须随播放器更新。这是用户确认的取舍，界面和帮助文档也须如实说明。

## 2. Research：源码事实、方案比较与推荐

### 2.1 源码事实

- [LX 宿主动作白名单](https://github.com/lyswhut/lx-music-desktop/blob/ad95d5091c9ed689fa72b5e5c849df65f5a679ce/src/main/modules/userApi/renderer/preload.js#L28-L44)：常规平台的自定义源提供 `musicUrl`；`local` 伪平台另有 `lyric`、`pic`。搜索、歌单和榜单不是普通 LX 脚本的 action。
- [LX 平台模块](https://github.com/lyswhut/lx-music-desktop/blob/ad95d5091c9ed689fa72b5e5c849df65f5a679ce/src/renderer/utils/musicSdk/kw/index.js#L1-L43)在应用内注册搜索、热词、歌单、榜单、歌词、封面和评论，再将播放地址交给所选自定义源。其[更新提示](https://github.com/lyswhut/lx-music-desktop/blob/ad95d5091c9ed689fa72b5e5c849df65f5a679ce/src/renderer/core/useApp/useInitUserApi.ts#L145-L157)主要引导用户打开作者地址。
- LX 当前[曲目类型](https://github.com/lyswhut/lx-music-desktop/blob/ad95d5091c9ed689fa72b5e5c849df65f5a679ce/src/common/types/music.d.ts#L21-L46)没有通用歌手 ID；其[路由](https://github.com/lyswhut/lx-music-desktop/blob/ad95d5091c9ed689fa72b5e5c849df65f5a679ce/src/renderer/router.ts#L8-L65)没有通用歌手、专辑详情页。JJ Music 的该需求是新增能力。
- [MusicFree 插件协议](https://musicfree.catcat.work/plugin/protocol.html)展示另一种完整插件方案：搜索、播放、歌手作品、专辑、歌单、榜单和评论分别是可选方法。但现成 LX 脚本不会因此自动具备这些方法。
- 当前 JJ Music：`SourceEngine` 运行 LX v2 脚本；`src/main/online/search.ts` 等内置适配器处理五个平台；`SearchRouter`/`LibraryRouter` 依赖独立 `JjProviderEngine`，并由 `allowBuiltinOnlineSearch` 控制内置请求。`ArtistsView.vue`/`AlbumsView.vue` 是本地曲库视图；`NowPlayingView.vue` 的歌手、专辑目前仅是文本。`OnlineMusicInfo` 保留部分专辑 ID，但通常只有歌手名称。
- 旧 Review 的 R1–R12 仍是当前基线的问题清单，不能把旧计划中的“已实施”当作验收。普通 LX 启动、双引擎重复启动、更新失败回退、缓存身份和分页均需重新验证。

### 2.2 两种路线

| 路线 | LX 兼容性 | 搜索等如何更新 | 结论 |
| --- | --- | --- | --- |
| A. LX 式分工：脚本给播放地址，播放器给目录数据，并由脚本控制平台准入 | 现成 LX v2 脚本可直接使用；复用当前 `SourceEngine` 和内置适配器 | 随 JJ Music 更新 | **采用**：满足用户希望使用 LX 音源生态和“无音源即本地模式” |
| B. 所有请求都由脚本承担，保留完整 `jj-source` 协议 | 普通 LX 脚本只有播放能力；其他功能需作者改写 | 随扩展脚本更新 | 不采用为主流程：缺少真实可用的完整音源，重现用户当前困难 |

只参考 LX 的公开接口与行为，不直接搬运其平台模块代码；LX 项目另有[补充许可条款](https://lxmusic.toside.cn/desktop/license)。现有 JJ Music 平台适配器可继续演进。

## 3. Scope、Constraints 与接口契约

### 3.1 首轮范围

1. 歌曲搜索、热词、在线播放、在线歌词/封面，以及粘贴平台链接导入歌单。
2. 播放在线歌曲时，从正在播放页进入应用内艺术家、专辑基本详情：艺术家名称/头像/分页歌曲，专辑名称/封面/分页曲目，曲目可继续播放。
3. 无音源、按平台限制、多音源解析与故障提示；来源脚本更新、回退、旧数据兼容。
4. 已保存的在线歌曲、歌单和历史在音源缺失时保留并标记暂不可用，不自动访问平台，也不删除记录。
5. 软件**自身**的更新检查在本地模式仍可工作；它与音乐平台请求、音源脚本更新分开。

### 3.2 不在首轮实现

- 在线歌单**搜索**、排行榜、歌曲只读评论。现有“按链接导入歌单”仍在首轮。
- 评论发布、账号登录、官方音源目录、把普通 LX 脚本伪装成具备它未实现的搜索/榜单 action。
- 复制 LX 平台模块源码、发布安装包或修改外部账号状态。

### 3.3 统一准入与能力

建立主进程的 `OnlinePlatformRegistry`，从**运行健康、已启用、实际声明平台且具备 `musicUrl`** 的 LX 脚本推导可用平台。`local` 伪平台不使任何在线平台开放。所有音乐平台请求都经过同一个准入点；“任一音源启用即可查询全部平台”不允许。

建立每平台 `PlatformCatalogAdapter` 能力表。首轮能力为 `searchTracks`、`getHotWords`、`getLyric`、`getCover`、`importPlaylistUrl`、`searchArtists`、`getArtistDetail`、`getArtistTracks`、`searchAlbums`、`getAlbumDetail`、`getAlbumTracks`。能力可以缺省：只显示已实现且当前平台可用的入口；失败、空结果、无音源和未实现能力要分别说明。后续预留 `searchPlaylists`、`listCharts`、`getChartTracks`、`getComments`，首轮不得对它们发请求或展示可用按钮。

移除独立的 `allowBuiltinOnlineSearch` 产品开关语义：内置适配器不再是与音源并列的在线通路，而是**只有该平台 LX 音源健康时才能使用**。旧设置值不得绕过来源准入。

### 3.4 曲目和实体身份

保留 `OnlineMusicInfo.id` 既有格式、`source` 平台键及传给 LX 脚本的 `meta` 字段。新增可选的 `artists: [{ source, id?, name }]` 和 `album: { source, id?, name }`；保留 `singer`、`albumName` 供旧数据、列表和 LX v2 `musicInfo` 使用。搜索、歌单导入和详情页的规范化结果尽量保留原始平台 ID，不凭名称自动认定同名实体。

新内置目录结果属于**平台**，而非 JJ 脚本实例；不要把旧 `providerId` 偷换成 LX 脚本 ID。播放由当前平台 LX 脚本按稳定优先级解析，首选失败时依次尝试其他健康同平台脚本，并显示实际使用者。播放 URL 缓存至少按平台、曲目、音质、实际脚本稳定 ID/版本隔离；脚本切换、禁用和更新时失效。旧 JJ `providerId` 记录原样保存；无法确认转换关系时标记不可用并提供重新匹配，不静默改绑。

艺术家、专辑有可靠平台 ID 时打开精确详情；只有名称时进入**同平台候选搜索**，由用户选择。多位艺术家先显示选择项。本地曲目仍使用现有本地艺术家/专辑页，不混入在线详情。

### 3.5 更新与安全

从 JS 直链导入时保存导入 URL；已启用的该类脚本启动后最多每日检查一次，也提供手动检查。只下载、解析并比较版本与 SHA-256，不在确认前执行候选代码。版本未变但字节变化时标为“内容变化”，仍需用户确认。`@homepage` 若为网页只作作者主页，不当作 JS。`updateAlert` 呈现作者提示；无法确定直链时引导用户手动重新导入。

确认安装后做预检、候选启动和持久化提交；任何一步失败恢复旧脚本、启用状态与运行能力，并向 UI 报失败。重新导入和更新保留脚本稳定 ID。沿用现有脚本隔离、URL 校验、DNS 地址检查、响应大小限制；复核 renderer 直接消费脚本返回媒体地址的路径。

## 4. Executor Implementation Tasks

每项独立提交可 Review 的改动、对应验收证据和剩余风险。依赖顺序：E0 → E1 → E2 → E3/E4 → E5。

### E0. 固化需求并盘点准入边界

- **Goal / Scope：**以本文为新需求基线；逐一列出平台 HTTP 请求、后台预取、UI 入口、缓存和旧 `jj-source` 数据读取路径。记录 `kw/kg/tx/wy/mg` 当前适配器已支持的能力；对艺术家/专辑精确详情做平台 API 可用性探针，首轮至少选出一个可可靠提供两类详情的平台。
- **Constraints：**不得依据脚本文件名猜平台；以运行时声明为准。旧研究文档只作历史，不再驱动实现。
- **Acceptance Criteria：**每个可能发音乐平台请求的入口均映射到统一准入点；首轮精确详情平台及其他平台的候选搜索/不可用行为写入能力矩阵。
- **Verification：**代码搜索清单、平台只读探针、现状/目标对照 Review。若没有任何平台能可靠提供两类精确详情，暂停 E3 并反馈，不把候选搜索当作精确详情验收。

### E1. 恢复 LX 运行时，退出 JJ 专属主流程

- **Goal / Scope：**修复 `source-host.ts` 普通 LX 初始化崩溃；由单一脚本生命周期管理器负责启动、停止、reload 和健康状态。移除 `JjProviderEngine` 的启动及在线路由依赖，保留读取旧记录所需兼容代码；不删除用户数据。
- **建议入口：**`src/main/sources/source-host.ts`、`source-runtime-host.ts`、`source-engine.ts`、`src/main/index.ts`。
- **Acceptance Criteria：**一份脚本只运行一次；LX v2 `inited/request/updateAlert` 可用；坏脚本不影响其他脚本；纯 `local` 来源不开放在线平台。
- **Verification：**普通 LX、双平台 LX、启动失败和同平台双脚本夹具，在 IPC 与 Windows 文件传输各完成真实请求；旧 `source-engine` 回归。旧 Review R1、R7 在此复核；R2–R6 的 JJ 专属路径随退出范围封存，不伪称已修复。

### E2. 平台目录适配器与本地模式

- **Goal / Scope：**实现 `OnlinePlatformRegistry` 与能力表，将搜索、热词、歌词、封面、歌手头像、歌单链接导入和在线下载接入平台准入；修复搜索第三页及歌单多页导入/部分结果提示。无音源时隐藏或禁用在线入口，但保存的在线记录可见且标记不可用。
- **建议入口：**`src/main/online/*`、`src/main/index.ts`、搜索与歌单视图、设置存储。保留独立适配器，不复制 LX SDK。
- **迁移：**已有且启用的 LX 音源用户，在首次开放新的平台资料请求前看到一次说明并确认；新导入音源时说明 LX 脚本供播放、JJ Music 供目录数据。旧 `allowBuiltinOnlineSearch` 值不得单独开启无音源平台请求。
- **Acceptance Criteria：**零音源时音乐平台请求为零，本地播放与软件更新可用；只有 `kw` 音源时不能查询其他平台；来源关闭或崩溃后停止该平台后续请求；搜索三页以上可达，导入不会静默截断。
- **Verification：**主进程网络拦截、来源状态矩阵、分页与 UI 测试；更新 `check:gate` 以验证新规则。

### E3. 在线艺术家与专辑

- **Goal / Scope：**保留平台实体引用，新增在线艺术家/专辑路由、分页数据接口和正在播放页入口。精确 ID、候选搜索与不可用三种状态明确区分；至少一个已验证平台完成精确艺术家和专辑完整链路，其余平台依 E0 能力矩阵开放。
- **建议入口：**`OnlineMusicInfo` 规范化、搜索/导入结果、主进程在线服务、`NowPlayingView.vue` 和路由。现有本地 Artists/Albums 视图不改作在线页。
- **Acceptance Criteria：**在线曲目可点击正确艺术家/专辑并浏览、播放其分页曲目；只有名称时用户先选候选；重名、跨平台和多艺术家不会误跳；无音源时页面不预取。
- **Verification：**含精确 ID/无 ID/多艺术家/重名的夹具、至少一个平台实际冒烟、导航与分页 E2E。

### E4. LX 音源更新、播放身份与媒体安全

- **Goal / Scope：**实现直链来源检查、提示后确认安装、事务回退及稳定 ID；复核同平台多脚本优先级、URL 缓存和下载去重；补齐脚本返回的播放/图片 URL 在宿主与 renderer 的消费链路。
- **Acceptance Criteria：**拒绝更新不执行新代码；坏脚本恢复旧版本且仍可播放；同平台 A 失败可尝试 B，UI 显示 B；A/B 地址、缓存和下载记录不串用；非法/内网/危险重定向媒体被拒。
- **Verification：**本地 HTTP 新旧脚本服务、更新失败注入、双脚本连续播放及重启、URL/DNS/Range/图片体量回归。旧 Review R8、R9、R12 及媒体安全缺口在此复核。

### E5. 完整 Review 与交付

- **Goal / Scope：**复核新需求、旧 LX 数据、Windows 打包运行及真实来源；清理不再适用的 JJ 专属说明和死入口，保留历史研究记录。
- **Acceptance Criteria：**E1–E4 全部独立通过；真实且获准使用的 LX 脚本能完成导入、平台准入、搜索与播放；直链更新、手动重新导入与失败回退使用受控来源逐项验证；无音源时符合本地模式。未取得真实来源或实际安装证据时不得标记完整验收。
- **Verification：**`npm run verify`、`npm run test:e2e`、Windows 文件传输及安装冒烟、平台网络拦截、旧数据夹具、真实音源操作记录。记录命令、退出码、版本和失败项；测试替身通过不能代替真实来源。

## 5. 后续工程任务，不纳入 E5 完成条件

1. **F1 在线歌单搜索与排行榜：**在已开放的平台及适配器能力内提供搜索、榜单列表、榜单曲目分页和播放；复用曲目身份、来源准入及安全抓取。当前 JJ 专属榜单页在 F1 前不应显示为可用。
2. **F2 歌曲只读评论：**按歌曲平台 ID 分页读取和展示评论，不提供登录、发布、点赞或回复；无音源、平台无评论能力时不请求、不显示假数据。[MusicFree 的可选评论能力](https://musicfree.catcat.work/plugin/protocol.html#getmusiccomments)可作数据形状参考，但分页契约由 JJ Music 定义。

## 6. 总验收矩阵

| 场景 | 必须观察到 |
| --- | --- |
| 无任何已启用 LX 在线音源 | 本地曲库可用；音乐平台请求为零；软件自身更新检查可用；已保存在线记录不删除且不可播放 |
| 只启用一个平台 | 仅该平台已实现的在线能力可用，其他平台不发请求 |
| 同平台多个脚本 | 稳定优先级、失败后逐个尝试，实际脚本可见，缓存不串源 |
| LX 脚本更新 | 有新版先提示，确认才安装；失败自动回退；平台声明变化立即刷新准入 |
| 在线艺术家/专辑 | 精确 ID 导向精确详情；仅名称先选候选；至少一个平台完成详情和曲目分页全链路 |
| 旧数据与旧 JJ 记录 | 原数据保留；能安全读取的继续读取，不能安全转换的明确提示重新匹配 |
| 故障与安全 | 音源超时/崩溃、坏 URL、危险重定向不影响本地播放或其他音源 |

Executor 最终报告须逐项链接改动、测试与实际运行证据；凡未验证的场景保持“未通过/受阻”，不能以旧计划或旧 Review 的文字代替。
