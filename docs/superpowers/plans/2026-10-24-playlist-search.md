# F2 歌单搜索 Implementation Plan

> Use superpowers:executing-plans inline, TDD, one fresh final reviewer. No commit/merge/push/release.

**Goal:** Five-platform public playlist keyword search, readonly playable detail, confirmed save.
**Architecture:** Dedicated PlaylistSearchAdapter/Service and Pinia store; embed an independent playlist search panel in SearchView. Reuse authoritative import preview/save backend with explicit per-token discard.
**Tech Stack:** TS, Vue/Pinia, guarded HTTP, production-bundled Node tests and isolated Electron.
**Spec:** ../specs/2026-10-24-playlist-search-design.md (user approved).

## Constraints

20 summaries/page, max200 (10 pages); default wy, individual platform tabs; no local-list search or merged ranking. Memory cache1MiB/fresh5min/maxAge30min; global budget<=256MiB. No account/Cookie/third-party source execution. Preview uses existing importer bounds; no new song-count promise. Native IDs, no arbitrary renderer URLs. Preserve uncommitted charts.

## Review Focus

- Invalid IDs/fields are failures, valid empty results remain distinguishable.
- Old category/platform/query replies cannot overwrite active state.
- Same name across platforms is not one playlist.
- Preview token cleanup/repeated save cannot discard another view or create duplicate lists.
- Browsing never saves or plays; explicit queue uses obtained tracks and confirmation controls import.

## Task 1: official contracts

Files: ignored .cache/playlist-search/* and development ledger.
- [x] Bounded query “轻音乐” at five official search endpoints; max3 initial requests/platform; record failure without disguising it as empty.
- [x] Inspect schemas and existing import compatibility; do not execute response JS or guess fields. Additional discovery gets a reason in ledger.

## Task 2: adapter, service and IPC

Create shared/playlist-search.ts (PlaylistSummary, PlaylistSearchPage, strict source/query/page validation), main/online/playlist-search.ts (PlaylistSearchAdapter.search(source,keyword,page,signal)), main/online/playlist-search-service.ts (search ResourceEnvelope, memory budget/reliability), and main/online/playlist-previews.ts (bounded one-use token registry).
Modify platform-registry.ts, cache-budget.ts, shared/ipc.ts, main/ipc-validation.ts, main/index.ts, preload/index.ts, tools/build-test.mjs.
- [x] Write failing production tests for observed summaries, boundaries, empty/schema, identity and token one-use/discard; stage .mts as .mjs and run node --test after node tools/build-test.mjs.
- [x] Implement strict adapter, fixed URLs, 2MiB responses, policy-owned retries and private memory cache. Preserve old caches/settings compatibility.
- [x] Add providers/search IPC and token discard; renderer only submits IDs, force and cancellation handle. Run RED/GREEN IPC/service/cancel/stale/Retry-After checks.

## Task 3: search and detail UI

Create renderer/stores/playlist-search.ts, components/PlaylistSearchPanel.vue, views/OnlinePlaylistView.vue. Modify SearchView.vue classification gate, router/index.ts and PlaylistImportView.vue token lifecycle.
- [x] RED state tests: independent platform results, dedupe/200 cap, stale reply after switch, failure retry, detail token cleanup and late preview cleanup.
- [x] Keep song content mounted with v-show inside SearchView; playlist panel independent state. Gate song network functions/route watcher when kind=playlists and cancel generation on mode change. No KeepAlive; detail return restores playlist Pinia state and scroll.
- [x] Detail uses import.preview, TrackList and playQueue; confirm with counts/warnings before save, prevent double submit; discard its own UUID on route exit/change, including late responses. Existing import view discards replaced/closed tokens only.
- [x] Typechecks and focused production tests GREEN; no automatic song collection/download/import.

## Task 4: acceptance

Create tools/probe/playlist-search.mjs; update product rules, README, design/plan/development docs.
- [x] Run npm run verify in normal permissions for atomic temp writes; test suite must use production bundles.
- [x] Isolated production Electron controlled-HTTP checks for search kinds/platforms, load/retry, detail/back, no-source play guidance, confirm/cancel save, cleanup/double-submit; inspect screenshot and console.
- [x] Fresh read-only whole-feature reviewer, fix meaningful findings with RED/GREEN. Update per-platform live vs offline evidence.
- [x] GraphFlow supported-file indexing: service recovered on continuation; 13 supported TS files checked unchanged and updated Markdown incrementally indexed.

## Ledger

Ruling: continue in codex/platform-charts — new work depends on current uncommitted catalog/registry changes; no new checkout that loses those changes.

Ruling: QQ三个初始请求均无可验证歌单列表（旧接口-3003、新接口is_filter=-2、旧client_search无歌单字段）。追加官网搜索页静态读取及其明确引用模块，额外最多3次以定位当前契约；不盲目反复更换参数。其余平台先接入，不把QQ过滤结果标为空榜。酷我对象字面量不使用既有VM解析器，新增纯数据解析以遵守“不执行响应脚本”。

Ruling: QQ官网runtime已明确给出search分块23及哈希，前述额外3次均用于建立官方导入链。再追加最多3次（该明确search模块、必要时其common依赖、一个按官网参数构造的查询）；仍不执行模块，不携带登录Cookie，不进行猜测路径扫描。

Ruling: 官方搜索契约解析后，追加每个已接通平台最多3次固定现有导入接口请求，核实首条真实摘要ID可用于浏览曲目；只读取歌单元数据、不播放/保存/下载，不运行音源；超出预算立即停止并记录有限证据。

Ruling: 最终只读复核发现两处UI异步竞态，按明确原因补生产UI RED后修复：分类切换仅取消离开的歌曲请求；Panel await后增加存活/代次守卫。生产重复提交还发现共享DialogHost空读取，使用当前dialog快照和空守卫解决。三处修复均由原审查员只读核对，生产UI GREEN覆盖。

Task 1: complete — 四平台搜索真实20摘要回放；QQ按9次有限证据明确未接通。追加有界现有导入器检查：WY129/KG21/KW90/MG21曲目，均完整，无播放、保存或下载。
Task 2: complete — 适配器、独立内存缓存/健康、严格IPC及有界单次预览令牌实现；生产打包adapter5/service5测试通过，IPC纳入完整套件。
Task 3: complete — 状态/lease3项测试、分类/平台结果状态、只读详情常规队列、确认导入和旧导入清理完成，类型检查通过。
Task 4: complete — verify退出0：101/101套件、5/5准入；隔离生产UI27/27，零渲染异常，独占profile已删除；截图已查看。独立审查发现及修复已记录，README/产品规则/开发记录已同步。QQ真实搜索及真实音频/听感明确待验；没有提交、合并、推送或发布。
GraphFlow补索引：逐项index和context重试均Transport closed，未改变全局配置；服务恢复后补本批TS/Markdown索引。

Ruling: 用户继续执行后处理QQ未接通项。此前官网代码只核实了业务param，尚未核对官网明确引用vendor中请求封装的公共comm/传输默认值。本轮最多追加3次（1次已知vendor静态读取，至多2次仅按实际发现差异构造的固定官方请求）；无明确差异不盲试，不用Cookie、登录、签名绕过或执行官网脚本。

Continuation result: QQ官网vendor新增静态读取1次，发现完整comm默认值及游客uin0/CSRF5381；据此构造GET和POST各1次。两次仍code0/is_filter=-2/空列表，estimate_sum非零；无可用契约，保持明确未接通、不伪造空结果。本轮3次预算完成，累计12次。未登录、未执行/复刻签名，未改业务代码。
GraphFlow continuation: 服务已恢复，13个支持的本批TS文件逐个返回unchanged；最终Markdown文档补增量索引，先前Transport closed待办关闭。