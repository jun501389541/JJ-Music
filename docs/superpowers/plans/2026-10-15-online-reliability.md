# 在线资源可靠性 OR0–OR2 实施计划

> For agentic workers: use superpowers:executing-plans. 本次在当前会话顺序执行，不提交或推送。

**Goal:** 首期建立可定位、有界、保留上次成功值的在线资料路径。
**Architecture:** 主进程统一错误/预算、白名单诊断、版本化缓存；兼容原 IPC 结果字段，附加可靠性状态。搜索缓存只在内存，精确详情快照按能力持久化。
**Tech Stack:** Electron / Vue / TypeScript / Node test / 原子 JSON。
**Spec:** ../specs/2026-10-15-online-reliability-design.md

## Global Constraints

- OR-01–OR-12 全部适用；首批网易云 wy 与 QQ tx，不移除其他平台。
- 12 秒资料总预算，6 秒单次上限；可识别瞬时错误最多重试一次，250–750ms 随机退避；取消/结构错误/未知错误不重试。
- 搜索 5 分钟新鲜、30 分钟展示、200 页内存；详情 1 小时新鲜、7 天展示；元数据 48 MiB、单条 2 MiB。
- 不使用真实用户脚本/联网探针作离线验收；不修改已有并发修复，不改变播放/收藏身份。
- 当前 checkout 有未提交修复，.git 受限。原位增量开发，变更前保存差异；测试使用合成临时目录，避免复制遗漏未提交修复。

## Review Focus

- 两订阅者取消与最后订阅者取消，底层即使忽略 abort 也不得回填。
- 强制刷新、清缓存、修订变化后的迟到结果不得覆盖。
- 合法空值、200 错误页、结构异常不能混为成功。
- 时钟回拨、损坏桶、写失败与容量限制不能影响用户保存资料。
- 原始错误/伪造 ID/额外字段不能进入导出。

## Task OR0 — 基线

- [x] 保存当前差异并执行现有 offline runner，记录环境失败与已有修复。
- [x] 确认平台、测试构建入口、既有取消通道与持久化。

## Task OR1 — 错误、预算、诊断

Files: src/shared/online-reliability.ts; src/main/online/reliability-policy.ts; src/main/online/online-diagnostics.ts; src/test/online-reliability-policy.test.mts; src/test/online-diagnostics.test.mts; tools/build-test.mjs.

Interfaces: normalizeOnlineError(error, context): OnlineFailure; runOnlineRequest(work, context, options): Promise<T>; OnlineDiagnostics.record/export/clear/setEnabled/flush.

- [x] 添加分类、共享预算/唯一重试所有者、429 超预算、取消与白名单泄露回归，编译后运行确认 RED。
- [x] 实现错误与有界诊断（500 条/2 MiB），固定安全文案、受控 ID，串行原子保存，失败降内存。
- [x] 对相同编译套件确认 GREEN。

## Task OR2 — 缓存与接入

Files: src/main/online/resource-cache.ts; catalog-reliability.ts; search-router.ts; search.ts; entity-details.ts; hot-words.ts; src/main/index.ts; src/shared/types.ts; src/preload/index.ts; SearchView.vue; 对应 tests。

Interfaces: ResourceCache.get(key, loader, options): Promise<ResourceEnvelope<T>>; invalidate/clear/load/flush; CatalogReliability.search/entity 为路由接入边界；键包含 schema、适配修订、平台、能力、身份、语言。

- [x] 添加 stale+error、首次失败与合法空值、独立取消、代次、容量、回拨、损坏/写失败、版本与集成回归，确认 RED。
- [x] 实现 LRU/共享请求/持久快照；缓存仅接收完整验证结果，权限与确认不存在隐藏远程值。
- [x] 搜索与 wy 精确详情接入；tx 未有精确详情能力仍诚实报告不支持；热词复用既有每日调度，补版本和展示期限状态，不另包一层缓存。
- [x] 保持 IPC 兼容并显示过期/部分失败；新搜索保留意图隔离。
- [x] 运行局部 GREEN，再运行 npm run verify 与隔离 E2E，记录 RR 对照。

## Handoff

写 docs/development/2026-10-15-online-reliability/OR0.md、OR1.md、OR2.md 与 ledger.md，明确 OR3–OR8 尚未实施、真实验证未进行。后续遵循原设计阶段顺序。
