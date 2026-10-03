# LX 在线能力 E0 盘点

日期：2026-10-03
基线：`7bedfaf`
状态：E0 完成；供 E1–E5 实施使用。此文记录当前主干源码和一次只读网络探测，不代表功能已实现。

## 结论

- 当前有两条在线路由：LX `SourceEngine` 与 JJ 专属 `JjProviderEngine`。`src/main/index.ts` 同时创建并启动两套引擎，搜索/歌单路由优先走 JJ provider；没有 JJ provider 时，才由 `allowBuiltinOnlineSearch` 决定是否直连内置平台适配器。
- 该设置是全局布尔值，不能证明运行中的 LX 脚本实际声明了某平台；搜索路由在 provider 未声明平台时还会把它视为服务全部已知平台。这与计划要求的逐平台准入不符。
- 现有 `kw/kg/tx/wy/mg` 适配器支持曲目搜索；歌词、热词、歌单导入、艺人图片支持的子集不同。当前没有在线艺术家/专辑搜索和详情路由。
- `wy` 可以作为 E3 首轮精确详情平台候选：三位艺术家的精确 ID 均成功返回对应艺术家歌曲、头像和可翻页总量；三张专辑均成功按精确 ID 返回专辑基本资料与曲目。专辑接口忽略 `offset/limit`，因此 E3 若继续，须在应用内对已返回曲目分页，并限制/核验响应大小。

## 当前平台能力矩阵

“是”表示当前代码已有对应能力；头像和封面 URL 不等于独立的 `getCover` 目录 API。

| 平台 | 曲目搜索 | 热词 | 在线歌词 | 搜索结果封面 URL | 歌单链接导入 | 艺术家图片 | 艺术家/专辑精确详情 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `kw` 酷我 | 是 | 是 | 是 | 是 | 是 | 否；现有画像路径未接入酷我 | 未实现 |
| `kg` 酷狗 | 是 | 是 | 否 | 是 | 是 | 是 | 未实现 |
| `tx` QQ 音乐 | 是 | 是 | 是 | 是 | 是 | 是 | 未实现 |
| `wy` 网易云 | 是 | 是 | 是 | 是；搜索后会批量请求歌曲详情补封面和音质 | 是 | 是 | 本轮只读探测通过；尚未接入 JJ |
| `mg` 咪咕 | 是 | 否 | 是 | 是 | 是，且曲目分页 | 是 | 未实现 |

代码依据：

- 曲目搜索 provider 表：`src/main/online/search.ts`（`tx/wy/kw/kg/mg`）。网易云搜索后的 `/api/song/detail` 额外补封面和音质。
- 热词 provider 表：`src/main/online/hot-words.ts`（`tx/wy/kw/kg`）；缓存写入 `hot-words.json`，由 `SearchRouter` 管理。
- 歌词 provider 表：`src/main/online/lyrics.ts`（`tx/wy/kw/mg`）。
- 歌单导入：`src/main/online/playlist-import.ts`（`wy/tx/mg/kw/kg`）；咪咕、酷我和酷狗存在分页抓取。
- 艺术家图片：`src/main/online/artist-image.ts`（`mg/tx/wy/kg`），由 `src/main/library/artist-images.ts` 缓存并后台预取。
- 目前曲目标准化结果保存 `id`、`source`、`meta`、`singer`、`albumName`；没有通用 `artists[]`。QQ、网易云、酷我、酷狗的部分结果带 `meta.albumId`，但艺术家 ID 通常被丢弃。`OnlineMusicInfo.providerId` 是旧 JJ 脚本实例身份，不能当成 LX 脚本 ID。

## 平台网络请求入口清单

| 请求 | 当前入口与触发 | 当前准入/缓存 | E2 统一准入要求 |
| --- | --- | --- | --- |
| 曲目搜索、跨平台搜索 | `SearchView.vue` → `IPC.musicSearch/musicSearchAll` → `SearchRouter` → `search.ts`；本地曲库匹配也经 `SearchRouter` | JJ provider 优先；无 provider 才查全局 `allowBuiltinOnlineSearch`。五个平台内置搜索并行/分页；网易云另有歌曲详情请求 | 只对查询的平台检查健康、启用且实际声明该平台与 `musicUrl` 的 LX 脚本；没有则不发请求 |
| 热词 | `SearchView.vue` 空搜索时调用 `music.hotWords` → `SearchRouter.hotWords` → `hot-words.ts` | 全局设置；本地按日缓存 | 仅读取该平台当前有效的 LX 声明；来源切换、停用或崩溃后不可回退到其他平台 |
| 在线歌词与歌词候选 | 播放器 `lyric.resolve`、在线重搜、候选列表、曲库标签匹配 → `onlineLyric`/`lyric-service.ts` → `lyrics.ts`；候选曲目搜索经 `SearchRouter` | 歌词脚本/内置平台/跨平台搜索可按设置排序；平台歌词与候选搜索读全局设置 | 脚本侧按 LX `musicUrl` 生命周期；目录侧每次都检查曲目平台准入；无来源不做后台匹配 |
| 歌单链接导入及封面 | `PlaylistImportView.vue` → `playlistImportPreview/save` → `LibraryRouter`/`playlist-import.ts`；保存时另抓歌单封面 | JJ provider 的 `getPlaylist` 或全局内置设置 | LX v2 没有普通歌单 action；只对链接平台有有效 LX 来源时提供内置目录导入；保存前重验准入 |
| 艺术家头像 | 曲库扫描/更新时 `ArtistImageStore.prefetch` → `artist-image.ts` | `index.ts` 的 resolver 包装读全局设置；图片缓存写本地库 | 预取任务启动前及实际搜索时都检查平台准入；无来源时不能因本地扫描而请求平台 |
| 在线播放与下载 | `SourceEngine.musicUrl` / `PlaybackRouter`；下载通过 `DownloadManager.resolve`；来源验证会先搜索再取播放 URL | LX 来源与 JJ provider 目前共同运行；下载音频/封面另经 URL guard | 平台播放只能请求同平台健康 LX 脚本；下载前重新核验，不因保存的旧 `providerId` 静默转给另一脚本 |
| 封面/歌曲详情补充 | 搜索返回的 `picUrl` 被 `cover-fetch.ts`、下载流程或歌单保存流程消费；`match:cover` 可单独触发；歌单音质补齐调用 `fetchNeteaseDetails` | 媒体 URL guard 限制地址与响应，但它本身不负责来源准入；歌曲质量补齐读全局设置 | URL 安全校验与平台准入分开；无来源时不获取远端图片/音质；预览后来源停用则保存失败并说明 |
| 软件更新与音源脚本更新 | `release-source.ts`/UpdateService；`source-updater.ts` | 独立的受控更新来源 | 不是音乐平台目录请求；本地模式仍可检查软件更新。音源脚本更新保持单独的确认与回退流程 |

搜索、热词、歌词、歌单和头像目前分散在多个服务中。`url-guard.ts` 的职责是 URL、DNS、重定向与响应大小安全，不是来源授权；因此不能以 URL guard 替代 `OnlinePlatformRegistry`。

## `wy` 只读详情探测

探测时间：2026-10-03。Node.js `v24.15.0`；只发送无登录态 GET 请求，没有下载媒体文件、提交数据或修改平台账户。

### 艺术家

- 网易云网页搜索 `/api/search/get/web` 对“周杰伦”返回曲目中的精确 `artists[].id=6452`。
- `/api/v1/artist/songs?id=6452&limit=5&offset={0,5,10}` 三次均 HTTP 200、`code=200`，每页 5 首，`total=566`、`more=true`；返回曲目的 `artists[]` 含匹配 ID、名称“周杰伦”和 `picUrl`，不同 `offset` 返回不同曲目。
- 独立重复样本“陈奕迅”(artist `2116`)、“林俊杰”(artist `3684`) 都返回 `code=200`、对应艺术家资料、头像及 `more=true`。
- 专用 `/api/artist/detail?id=...` 本轮返回 `code=400`“参数错误”。所以候选 E3 不依赖这个专用接口；从按精确 ID 查询的歌曲页取艺术家元数据。若页内找不到匹配艺术家记录，应回退为“暂不可用”，不得按名称猜 ID。

### 专辑

- 网易云网页搜索曲目返回专辑 ID；以 `36412633`、“Life Continues…” (`6452`) 和“JJ陆” (`10770`) 三个 ID 请求 `/api/v1/album/{id}?id={id}`，均 HTTP 200、`code=200`，响应 `album.id` 与请求 ID 一致，并返回专辑名、图片、艺术家和曲目列表（样本列表分别 16、7、14 首）。
- 该端点对 `offset=0/5/10/15` 与 `limit=5` 返回相同的曲目列表，证明此路径不提供服务端分页。本轮选用的 E3 实现若以它为基础，需在 JJ 内存中分页完整曲目；必须设置响应大小与曲目数上限，并在界面上准确呈现已加载数据。

### E3 结论与风险

`wy` 满足本轮“至少一个平台能用精确 ID 获取艺术家及专辑资料和曲目”的准入门槛，可以进入 E3 实现。边界：艺术家资料取自其分页歌曲响应；专辑资料端点不分页；端点是网易云当前 Web API 行为，不是已确认的公开开发者稳定契约，后续需保留空结果/格式变化处理与集成冒烟。

## 基线验证

- `npm run verify`：类型检查和生产构建通过；测试为 **42/47 suites**。失败：`jj-provider-engine.test.mjs`（测试输出缺 `out/test/sources/source-host.js`）、`jj-source-protocol.test.mjs` 与 `provenance-persistence.test.mjs`（测试构建缺 `out/shared/types.js`）、`sandbox-probe.test.mjs`（启动退出码 1）、`source-engine.test.mjs`（受限模式来源声明断言失败）。日志：本计划 `.superpowers/sdd/.../baseline-verify.log`。
- `npm run check:gate`：**7/7 通过**。它只验证旧的全局开关关闭/打开行为；不能当作逐平台 LX 准入验收。
- `npm ci`：安装 412 个包；npm 报告 11 项传递依赖漏洞（1 moderate、10 high）。本次没有运行自动升级或修复依赖。

## E0 之后的实现约束

1. `OnlinePlatformRegistry` 的平台集合必须从实时 SourceEngine 状态计算：脚本已启用、运行健康、声明真实 `SourceInfo.id` 且 `actions` 含 `musicUrl`；排除 `local`。来源文件名、JJ provider 的来源声明和旧 `allowBuiltinOnlineSearch` 均不能开通平台。
2. 任何 UI/IPC/预取/下载请求都通过同一准入服务；URL guard 继续独立负责网络安全。
3. E3 仅首开 `wy` 精确详情。其他平台只可提供明确的候选搜索或不可用态；不得把搜索第一条伪装成精确详情。
4. 保留曲目 `id/source/meta` 原形、旧 JJ `providerId` 及已有资料；无法按确切身份继续播放的行标为暂不可用并允许重新匹配。
