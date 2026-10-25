# 更多平台榜单 Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans inline; one fresh final reviewer. Do not commit or push.

**Goal:** Extend approved charts to kg/kw/mg with truthful per-platform support and unchanged wy/tx.
**Architecture:** Shared platform config and per-platform adapter contracts; reuse ChartsService reliability and production UI. Stable period or bounded snapshot required for additional pages.
**Tech Stack:** TypeScript, Vue/Pinia, fixed-host guarded HTTP, production-bundled Node tests, isolated Electron.
**Spec:** ../specs/2026-10-24-more-platform-charts-design.md (approved by user “开始实施”).

## Global Constraints

20 tracks/page, max500; 2MiB chart cache; no sources/account/Cookie/third-party proxy; preserve uncommitted work in codex/platform-charts. Initial real probe max3 requests/platform, extra discovery needs a recorded reason. Never equate synthetic tests with real availability. No commit/merge/push/release.

## Review Focus

- Platform IDs and kg hashes/mg copyright identities survive cache persistence; reject URLs and malformed IDs.
- Missing period cannot silently merge moving pages; stable snapshot or explicit first-page-only limitation.
- No unavailable platform masquerades as valid empty or successful synthetic support.
- Existing wy/tx period, partial retry and request cancellation semantics remain intact.
- Five tabs fit and each owns loaded state; standard favorites and queue still use native identity.

## Task 1: contracts and ledger

Files: ignored .cache/more-charts/*; docs/development/2026-10-24-more-platform-charts.md.
- [x] Fetch bounded official list/one page, with optional discovery request; inspect saved responses, record each attempt and failures without retries.
- [x] Establish exact schema, IDs, available period or snapshot; explicitly record blocked platforms.

## Task 2: contracts and adapters

Files: src/shared/chart-types.ts; src/main/online/platform-charts.ts; new focused adapter helper if needed; src/test/platform-charts.test.mts.
Interfaces: ChartAdapter.list(source, signal): Promise<ChartSummary[]> and tracks(source,id,page,period,signal): Promise<ChartPage> stay compatible; export shared chart platform descriptors and validators.
- [x] Add failing observed-schema/identity/strict ID tests for kg/kw/mg; build with node tools/build-test.mjs, stage suite and run node --test out/test/platform-charts.test.mjs; confirm failure before implementation.
- [x] Implement fixed official URLs, platform-specific normalization, stable version checks or first-page-only limitations; add tests for empty/malformed, total caps, unknown versions and missing identity.
- [x] Run the suite to GREEN, including original wy/tx assertions. Recorded real failure may only yield a precise unavailable branch, never invented fixtures claimed as real.

## Task 3: service and page integration

Files: charts-service.ts, platform-registry.ts, charts store, ChartsView.vue; charts-service/store/ipc-validation tests.
Interfaces: preserve chartList/chartTracks capabilities, ResourceEnvelope and cancellation IDs; shared configuration initializes five platform states.
- [x] Write RED tests for three platform cache restoration, cross-platform identity rejection and UI state switching.
- [x] Generalize validation and cache platform whitelist; retain old revisions and total budget. Expand tabs/state from shared config and display pagination limitations.
- [x] Run focused production-bundled tests and type checks to GREEN.

## Task 4: acceptance and delivery record

Files: tools/probe/platform-charts.mjs, README, PRODUCT_RULES, design/plan/development docs.
- [x] Extend isolated production UI with synthetic HTTP only for verified schemas and explicit unavailable states, exercise native favorites and preserve wy/tx tests.
- [x] Run npm run verify (normal file permissions required), production UI probe, inspect screenshot and console results.
- [x] Dispatch one final read-only reviewer, fix evidenced issues with RED/GREEN; update real-vs-offline evidence and remaining platform gaps.
- [x] Incrementally index changed supported files, record GraphFlow failures if any; do not commit/push.

## Ledger

Ruling: keep current codex/platform-charts checkout — changes extend the same uncommitted feature, and a fresh worktree would omit that dependency; no branch or main mutation.

Ruling: 咪咕前三次探测仅得到首页、主模块和返回HTML的榜单分块，尚未出现可验证API；主模块明确引用官方 @migusdk-617e3513.js。为完成同一已批准平台，追加一次只读SDK获取（2MiB/12秒上限），只静态查找榜单路由、不执行脚本。若找到明确路由，再仅请求列表及一个首页，额外最多3次；不扩大到猜测性路径扫描。


## 明确保留的未完成平台

- [x] 咪咕：继续调查时取得官方模块/API契约，已接通9榜及快照分页；前次未接通记录为历史状态。当前完整verify退出0、98/98套件、5/5准入，五平台生产UI27项通过。

Ruling（继续实施）：用户“继续执行”继续授权处理咪咕未完成项。先验证官方榜单模块在带官网Referer时是否仍返回HTML，并从官网搜索结果查可复用公开入口；本轮最多6次有界官方请求，逐次登记，仍不执行网页脚本、不使用账号或任意路径扫描。

## 咪咕接通补充实施（继续授权后）

Ruling: 带官网Referer后原榜单分块可读取，静态API模块明确给出rank-index/rank-info；已按同一官方接口取得真实目录与27553319榜单。响应内含完整contents和songData，无需执行SDK或另查播放URL。本轮5次请求，未用第6次预算。根因先前是公开模块获取条件不完整，不是“咪咕没有榜单”。

- [x] 新建 src/main/online/platform-charts-migu.ts，接口 miguChartList / miguChartTracks 与现有额外适配器签名一致；对完整有界有序ID快照做指纹，分页时核对，缺失songData不猜造元数据。
- [x] 为实际嵌套JSON与songId/copyrightId、快照变化、畸形/空榜及缺少完整快照写RED，再实现；允许MG数字榜单ID、恢复真实目录能力和页面入口，扩展持久化测试。
- [x] 真实响应回放、隔离生产UI含MG分页/收藏/快照变化、完整verify、独立复核并同步剩余边界；不提交推送。
