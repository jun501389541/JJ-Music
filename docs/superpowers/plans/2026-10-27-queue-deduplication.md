# 队列去重整理 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** 用户确认后稳定去重完整当前队列，保留确切当前行和音频状态，恢复批量编辑能力。
**Architecture:** queue-edit纯规划返回最终队列、索引和统计；player窄上下文负责版本校验和一次事务；PlaybackPanel提供完整队列确认。复用既有预约收束、随机池和会话生命周期。
**Tech Stack:** Electron/Vue/Pinia/TypeScript，生产bundle测试及生成媒体CDP探针。
**Spec:** [已批准设计](../specs/2026-10-27-queue-deduplication-design.md)

交付补记：以下“不提交推送”约束属于实施阶段。全部验证完成后，用户另行明确授权提交并推送本批改动；合并和发布仍未授权。

## Global Constraints
- 完整键来自playlistEntryKey，当前确切索引行优先，其他保留首次；剩余行原顺序和对象保留。
- 仅当前完整队列；无操作不改状态，过期整批拒绝；不提交推送发布。
- 复用当前隔离worktree和既有依赖，先RED再GREEN，无人工听感替代。

## Review Focus
1. 当前后出现同键对象资料不同：保留对象与实时音频而非first-key行（Task1）。
2. 准备取消同步回调与已发声迟到失败：阻止重建重复队列（Task1/3）。
3. 原随机池已有重复，但实际导航历史重复有意义：两种状态不同处理（Task1）。
4. 对话框期间同曲重载和队列替换：版本与代次拒绝（Task1/2）。
5. 筛选/历史翻页及重复提交：始终作用捕获的完整当前队列、至多一次（Task2）。

### Task 1: Pure plan and player transaction
**Files:** src/shared/queue-edit.ts, src/test/queue-edit.test.mts, src/renderer/src/stores/player.ts, src/test/player-regression.test.mts.
**Interfaces:** planQueueDeduplication(queue,currentIndex):QueueDeduplicationPlan {queue,currentIndex,inputCount,retainedCount,removedCount}; QueueDeduplicationContext {revision,generation,currentKey,currentIndex,inputCount,retainedCount,removedCount}; player.queueDeduplicationContext(); player.applyQueueDeduplication(context):number.
- [x] Write pure RED: current-later identity retained by object, platform/local identity, no-current, invalid index, no-op; player RED: clock/AB/sleep/paused/loading, stale/invalid/maintenance, pending/handoff, random pool/history, no-op.
- [x] Build production via node tools/build-test.mjs; copy affected .mts to out/test .mjs; node --test --test-name-pattern='queue dedup' affected files; observe missing interfaces failures.
- [x] Implement O(n) stable planner, immutable context, validate/recompute before side effects; use editingQueue + cancelCrossfadeReservation; single assign/revision/session, stable unique pool excluding current, preserve actual random history.
- [x] Re-run affected tests and typecheck, expect pass.

### Task 2: Confirmation UI
**Files:** PlaybackPanel.vue, tools/probe/queue-search.mjs.
**Interfaces:** consume Task1 context/action; computed duplicate count drives live-only button.
- [x] Add native DOM checks for button/confirm counts, filtered full scope, cancel, stale, history exclusion, double submit, current-later clock and batch menu; run missing-button RED.
- [x] Wire busy guarded confirm, no-op/maintenance disabled/reason, full range copy, source preserved, success/error feedback; update duplicate batch refusal wording.
- [x] Build and run DOM probe, expect all existing and new checks pass.

### Task 3: Integration and review
**Files:** tools/probe/crossfade-lifecycle-main.cjs, README.md, docs/PRODUCT_RULES.md, docs/development/2026-10-27-queue-deduplication.md, spec/plan.
- [x] Add generated-media acceptance of later current duplicate and overlap/deferred callback, preserve existing native coverage.
- [x] Run npm run verify, DOM and media probes, read exits/reports; only retry for new changes/failures.
- [x] Fresh independent final reviewer of complete delta vs c503009; reproduce/fix material findings then affected verification.
- [x] Record evidence and boundaries, check links/whitespace, incrementally index; leave uncommitted.

## Self-review
QD01–03→Task1; QD04/05→Tasks1/2; QD06–08→Tasks1/3; QD09/10→Tasks2/3. No new IPC or migrations. User has approved direct implementation and session execution method persists; do not ask another execution-method confirmation.
