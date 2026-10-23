# 全仓审查9项P2修复交接计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修复2026-10-22审查确认的9项P2，并将受控复现纳入正式回归。

**Architecture:** 沿用现有播放store、扫描代次、音源生命周期及更新服务。优先补齐异步提交前的有效性检查与持久化一致性，不新增播放重试层、不重构无关模块。

**Tech Stack:** Windows、Electron、Vue/Pinia、TypeScript、Node测试、esbuild生产模块打包。

**Spec:** [全仓审查报告](../../development/2026-10-22-global-audit.md)、[产品规则](../../PRODUCT_RULES.md)。

## 当前状态与续接入口

2026-10-22保存清单时9项全部未修复。2026-10-23用户授权实施后，**9项生产修复与对应正式回归已完成**；逐项RED/GREEN、全量验证及独立审查结果见[执行账本](../../development/2026-10-23-global-audit-fix-ledger.md)。后续按用户“继续执行”进入修复分支`codex/global-audit-fixes`的提交、推送与PR交付；本轮不发布新版本。基线为`a698dc2b01e12eec41210b1d712626914a8de258`。

下次可直接从本文件执行，不必重新全仓搜索。先核对当前HEAD及工作区，再读取审查报告中对应GA编号；行号可能随修复移动。

既有验证：正常权限第二轮`npm run verify`完整通过93/93套件、5/5门禁。第一轮92/93，唯一合成诊断源超时，单独重跑及第二轮全量通过；这不代表下面9项已修好。

## Global Constraints

- 保留未提交的`docs/development/2026-10-15-online-reliability/OR8-source-updates.md`、审查报告和本清单；不覆盖用户其他工作。
- 不改日常资料、原始音源、公开Release资产、签名密钥、更新门禁或全局设置。
- 每项先把受控缺陷复现变成正式失败回归，再最小修复并运行相同回归；测试应断言正确行为，而非现有错误行为。
- 生产模块离线套件通过`tools/build-test.mjs`和测试runner运行；共享`out`构建串行。真实音源、安装和听感单独授权、单独记证据。
- 修复授权、提交与推送以届时用户指令为准。本文件是待办记录，不是自动实施指令。

## Review Focus

- 目标目录已有同名资料：不静默丢弃当前资料，不在失败后切换指针。
- 恢复预加载失败：不擅自播放，不丢恢复位置，不增加原有重试次数或预算。
- 扫描迟到和磁盘不可达：尊重移除操作，区分暂时不可达与确认删除。
- 隔离、停用及写盘失败：元数据、持久化和实际运行实例不能互相矛盾。
- 取消后的异步完成与队列历史：旧任务不能提交成功，新操作不能制造重复历史。

## 修复任务（建议按GA01→GA09顺序）

- [x] **GA01 迁移目录冲突** — `src/main/index.ts:1825–1831`、`src/main/data-location.ts`。目标已有冲突资料时明确拒绝或按经确认的冲突策略处理；失败保持原指针。验收：源/目标不同歌单与设置、复制失败、中断时均不静默切入旧资料；正常空目录仍可迁移。复现：`root-repro.mjs`第二场景。
- [x] **GA02 静默恢复重试自动播放** — `src/renderer/src/stores/player.ts:363,1051`。保留当前播放意图及恢复位置到媒体重试。验收：`autoplay:false,startAt:42`遇可恢复错误后仍暂停且位置正确；正常主动播放仍可重试，预算不重置。复现：`playback/repro.test.mjs`恢复场景。
- [x] **GA03 移除当前曲目错存进度** — `src/renderer/src/stores/player.ts:899–903,983–998`。调整队列变更与会话保存顺序，避免把旧曲进度记到后继；明确清除失效快照。验收：删除队首/中间/末项后退出重启，不恢复被删条目、不把A的83秒给B；移除非当前项保持正确会话。
- [x] **GA04 不可达目录清空索引** — `src/main/library/music-library.ts:380–381,428–444`。先判断根目录是否可扫描，再决定该根下的prune范围，保留不可达目录的旧条目。验收：全部根不可达、部分根不可达均保留对应旧索引并给出状态；可达目录内确认已删除的文件仍可清理。
- [x] **GA05 扫描移除目录后回填** — `src/main/library/music-library.ts:306–312,361–364`。让移除操作使该目录在途读取失效，提交前复核归属/代次。验收：暂停读取→移除目录→释放读取后，内存及磁盘均不回填；其他目录的扫描不受影响。
- [x] **GA06 同名导入隔离后旧实例仍运行** — `src/main/index.ts:1847–1873`、`src/main/sources/source-store.ts`、`source-engine.ts`。隔离同名覆盖记录时停止/失效旧实例及其请求，避免旧响应标成新版本。验收：隔离后旧runtime不可请求、迟到结果不可回填、有效重新启用后身份正确；不执行受阻脚本。
- [x] **GA07 停用写盘失败状态分裂** — `src/main/sources/source-store.ts:387`、`src/main/index.ts:1961–1962`。明确持久化失败的回滚/停止语义，保证错误反馈与实际状态一致。验收：写入/rename失败后内存、磁盘、运行状态可解释且一致；正常停用和后续重启正确。
- [x] **GA08 校验期间取消仍ready** — `src/main/updates/service.ts:138–140`。异步文件校验完成后再次确认任务token/代次有效，取消后不提交ready。验收：校验中取消及随后重试时，旧任务不覆盖新状态；签名/摘要复核和安装确认保留。仅已开启更新的官方安装版具有实际入口。
- [x] **GA09 当前队列重复进入历史** — `src/renderer/src/stores/player.ts:664–675`。outgoing与incoming相同时不把当前页插入历史；维持最多两个不可变快照。验收：A→B→C→C后仍为当前C、历史[B,A]；恢复旧列表和不同列表替换仍正确。

## 复现与正式回归入口

已核对的本地复现均位于`.cache/audit-20261022/`，属于忽略目录，换机器可能不存在；若缺失，按审查报告触发步骤在正式测试中重建，不依赖缓存产物续接。

```powershell
node .cache/audit-20261022/root-repro.mjs
node --test .cache/audit-20261022/playback/repro.test.mjs
node .cache/audit-20261022/data/repro.mjs
node .cache/audit-20261022/sources/repro.mjs
```

这些脚本目前断言的是缺陷存在，不能当作修复后的验收测试。优先扩展`src/test/player-regression.test.mts`、`src/test/library.test.mts`、`src/test/scan-concurrency.test.mts`、`src/test/update-service.test.mts`、`src/test/source-store-persistence.test.mts`、`src/test/source-engine.test.mts`及`src/test/data-location.test.mts`；复用正式测试替身，避免依赖真实媒体、音源和用户目录。

## 收尾

- [x] 9项逐项提供失败→修复后通过的回归证据，复核相邻路径；见2026-10-23执行账本。
- [x] `npm run verify`确认轮全量通过93/93、5/5；首轮90/93及测试替身补齐结果分别保留。
- [x] 更新审查报告状态并复核工作区差异；修复按当前授权保留未提交，未创建修复提交。
- [ ] 根据届时用户指令决定提交/推送及是否发布；本次未创建修复提交。

保留边界：真实源更新/回退仍缺合格候选，人工听感仍待验；扫描与实际标签写入并发的候选未纳入这9项，不能在本轮顺带扩展修复。
