# 完整队列排序 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 完整当前队列按歌名/歌手升降序稳定排列，保留所有行和当前媒体。
**Architecture:** 新共享queue-sort模块负责中文自然数字比较、原始行索引排列；player管理不可变上下文和一次编辑；面板提供四项菜单和确认。
**Tech Stack:** Electron / Vue / Pinia / TypeScript，生产bundle和CDP生成媒体探针。
**Spec:** [已批准设计](../specs/2026-10-27-queue-sorting-design.md)

## Global Constraints
- 中文拼音Intl.Collator，numeric=true，sensitivity=base，NFKC+trim；双向空值末尾，同键稳定。
- 当前按原始行索引映射，保留所有重复行/对象，不按完整键findIndex定位。
- 完整队列不受筛选/多选影响；排序字段快照变化或队列/播放代次变化整批拒绝。
- 复用编辑保护和预约收束，不重洗随机池，不新增依赖/IPC/设置，不提交推送。
- 沿用已存在的隔离worktree和本会话实施方式，先RED后GREEN，最后独立审查。

## Review Focus
1. 相同对象重复出现及后出现同键当前行的索引区别（Task1/3）。
2. 降序不能反转相等组，空值双向末尾（Task1）。
3. 异步资料只改排序字段却不增加修订（Task1）。
4. 预载取消同步回调、已交接迟到失败不能覆盖新顺序（Task1/3）。
5. 菜单打开后翻页/筛选、确认时切歌和重复提交（Task2）。

### Task 1: Stable planner and player transaction
**Files:** create src/shared/queue-sort.ts, src/test/queue-sort.test.mts; modify tools/build-test.mjs, src/renderer/src/stores/player.ts, src/test/player-regression.test.mts.
**Interfaces:** QueueSortField='name'|'singer'; QueueSortDirection='asc'|'desc'; queueSortValue(track,field):string; planQueueSort(queue,currentIndex,field,direction):{queue,currentIndex,changed}; QueueSortContext {field,direction,revision,generation,currentKey,currentIndex,keys:readonly string[],values:readonly string[],changed:boolean}; player.queueSortContext(field,direction), player.applyQueueSort(context):boolean.
- [x] Write pure RED: natural Chinese/number order, equal/blank/reverse, exact current duplicate occurrence and shared-object duplicate, identity/multiplicity/no-mutation, invalid/no-current/no-op; player RED: state preservation, raw metadata stale/nonselected update, frozen/forged context, maintenance, same-key reload, pending and handedoff, random navigation/no-op.
- [x] Add bundle entry and run build-test then staged .mts->.mjs with node --test --test-name-pattern='queue sort'; observe missing APIs RED.
- [x] Implement cached O(n log n) stable comparison; exact index permutation; context arrays frozen; validate/recompute before lifecycle effects; one queue/index/revision/session update, preserve random pool/history after normal reservation return.
- [x] Run affected tests and typecheck, expect pass.

### Task 2: Menu and confirmation
**Files:** PlaybackPanel.vue, tools/probe/queue-search.mjs.
**Interfaces:** consume Task1 field/direction/context/changed/action; shared sorting busy ref.
- [x] Add DOM missing-menu RED, then wire live-only button disabled for <2; four actions, busy guard, no-op toast, full-range confirmation and error/success feedback.
- [x] Native DOM: all four actions, filtered full list, stable order/current clock, cancel, stale switch, no-op, double submit, history exclusion and source retained; baseline66 checks preserved.

### Task 3: Integration, independent review, evidence
**Files:** tools/probe/crossfade-lifecycle-main.cjs, README.md, docs/PRODUCT_RULES.md, docs/development/2026-10-27-queue-sorting.md, spec/plan.
- [x] Native generated media verifies later duplicate current identity/time/paused and active overlap sorting/delayed cancellation, preserve prior21 cases.
- [x] Run npm run verify, production DOM and native media probes, inspect actual exits/counts and cleanup.
- [x] Fresh independent final reviewer of full delta vs 4f55806; reproduce and fix material findings then affected verification.
- [x] Update records/plan/spec, local links/whitespace, GraphFlow index; preserve work uncommitted.

## Self-review
QS01–04/07→Task1, QS05/06→Tasks1/2, QS08/09→Tasks1/3, QS10→Tasks2/3. Snapshot interfaces precede menu and native checks. Review risks each have test steps. No extra execution-method approval needed after user explicitly approved implementation.
