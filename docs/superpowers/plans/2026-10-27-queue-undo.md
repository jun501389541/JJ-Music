# 队列单步撤销 Implementation Plan
> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans.
**Goal:** 最近一次排序/移动可逆排列恢复，保留实时播放/资料。
**Architecture:** 纯逆排列帮助函数、player单条不可变守卫记录、直接按钮。所有代次/结构变更同步失效，编辑成功才安装新记录。
**Tech Stack:** TypeScript/Pinia/Vue/Electron。
**Spec:** [批准设计](../specs/2026-10-27-queue-undo-design.md)

## Global Constraints
- 保留未提交排序基线；只撤销排序/拖动/批量移动，单条会话记录，无重做、不撤销删除。
- 当前按出现位置映射，资料从当前对象取；代次/结构/维护变化失效；无操作保留记录。
- 不提交推送，生成媒体不替代听感。

## Review Focus
重复同对象的逆映射、资料替换不回旧快照、同曲重载即时禁用、拖动交接收束、旧UI记录不能撤销新记录。

### Task 1: Pure inverse and store
**Files:** create src/shared/queue-undo.ts and src/test/queue-undo.test.mts; modify queue-sort.ts, player.ts, player-regression.test.mts, build-test.mjs.
**Interfaces:** invertQueueOrder(order):number[]; restoreQueueOrder(queue,inverse,currentIndex):{queue,currentIndex}; sort plan adds order:newIndex->oldIndex; player.queueUndoAvailable/queueUndoLabel, queueUndoContext():number, undoQueueEdit(id):void.
- [x] Snapshot prior uncommitted source into owned ledger workspace.
- [x] RED pure bijection/duplicate objects/current occurrence; production undo sort/move/drag, latest-only/no-op/stale id, metadata replaced, same-key reload/maintenance/stop/structural invalidation, pending/handoff/random.
- [x] Implement inverses and record guards, explicit sync invalidation at all generation/revision writes and maintenance, unified single drag edit lifecycle, actual edits install records after revision.
- [x] Production affected tests/typecheck green.

### Task 2: UI and native proof
**Files:** PlaybackPanel.vue, queue-search.mjs, crossfade-lifecycle-main.cjs.
- [x] DOM missing undo button RED then live-only busy protected button, disabled reason/title, wrapping action bar.
- [x] Real sort/move/drag and undo, filtered full range, duplicate click, new-record/current changes, history excluded and layout bounds.
- [x] Generated media later duplicate paused/current clock, pending cancel and drag while overlap.

### Task 3: Verify/review/record
**Files:** README, PRODUCT_RULES, development record/spec/plan/roadmap.
- [x] Full verify and DOM/native probes pass; fresh reviewer sees exact baseline snapshots as well as full diff; fix material findings.
- [x] Update evidence/links/whitespace and GraphFlow, preserve uncommitted work, cleanup owned temp.
- [x] Continue second feature lyrics offset design without reasking selected order.

## Self-review
QU01–08 Task1/2, QU09 UI Task2, QU10 Task3. Pure helpers precede UI; docs/verification last. Inline execution authorized by current user request.
