# 逐首歌词偏移 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans.

**Goal:** 逐首持久化±30秒/100ms的手动歌词校准，统一主/桌面计时和点击seek，不改原文件或音频进度。
**Architecture:** shared lyric-offset定义键/数值/时钟；主进程LyricOffsetStore串行原子单键提交、窄IPC；独立Pinia状态加载并仅合并已确认键，player提供统一校准时钟，现有歌词菜单复用。
**Tech Stack:** TypeScript/Vue/Pinia/Electron与生产bundle测试。
**Spec:** [批准设计](../specs/2026-10-27-lyric-offset-design.md)

## Global Constraints
- 完整键隔离，本机重启保留；独立lyric-offsets.json version1，50000条/4MiB/键<=4096无NUL，非零100ms整数[-30000,30000]。
- offset负提前正延后；lyricTime=audio*1000-offset；点击(parsedTime+offset)/1000限合法曲长。
- 成功落盘才更新；读取损坏整体不可用且不覆盖；0删除；写入失败后可继续。
- 保留当前未提交排序/撤销，先基线快照；不提交推送发布；无听感/真实平台替代结论。

## Review Focus
已有LRC offset叠加一次；暂停同一行内小偏移也更新桌面逐字；不同键应答/并发不覆盖；同曲重载旧窗口失效；损坏文件与关闭收尾。

### Task 1: Shared rules, durable store and IPC
**Files:** create src/shared/lyric-offset.ts, src/main/store/lyric-offset-store.ts, src/test/lyric-offset.test.mts, src/test/lyric-offset-store.test.mts; modify main/index.ts, shared/ipc.ts, preload/index.ts, tools/build-test.mjs.
**Interfaces:** validateLyricOffsetKey(key), assertLyricOffsetMs(value), parseLyricOffsetSeconds(text), lyricTimeMs(audioSeconds,offsetMs), lyricSeekSeconds(lineMs,offsetMs,duration); LyricOffsetStore.get():Promise<Record<string,number>>, set(key,offsetMs):Promise<{key,offsetMs}>, flush(); window.jj.lyricOffsets.get/set.
- [x] Copy owned baseline files and ledger before implementation.
- [x] RED shared input/identity/direction/clamp and store missing/restart/concurrent/rollback/no-op/corrupt/limits; run production tests and observe failure.
- [x] Implement strict shared rules, 4MiB read check, blocked load failures, serialize candidate-write-commit and narrow IPC, services shutdown admission/flush.
- [x] Production focused GREEN/typecheck.

### Task 2: Unified frontend and controls
**Files:** create src/renderer/src/stores/lyric-offset.ts; modify player.ts, App.vue, NowPlayingView.vue, player-regression.test.mts; add src/test/lyric-offset-client.test.mts.
**Interfaces:** useLyricOffsetStore.initialize/status/offsets/busy/set; player.lyricOffsetMs/lyricTimeMs/lyricOffsetReady/Busy, lyricOffsetContext(), applyLyricOffset(context,ms), lyricSeekTime(lineTimeMs).
- [x] RED load/error/write busy/stale response client; player clock/LRCoffset/paused/no media change/current identity/generation and crossqueue rollback.
- [x] Implement confirmed per-key state, startup initialize before resume, shared clock to activeLine/desktop elapsed and click seek; no timestamp mutation.
- [x] Add menu current status,100ms steps/input/reset; shared dialog guard, captured context, strict parser and failure feedback.
- [x] Production tests/typecheck/build GREEN.

### Task 3: Actual acceptance, review and evidence
**Files:** tools/probe/queue-search.mjs, crossfade-lifecycle-main.cjs, docs/README/PRODUCT_RULES/spec/plan/roadmap.
- [x] Native DOM missing control RED then step/input/reset/paused/stale/double submit, desktop payload and normal close/restart persistence.
- [x] Generated media verify unchanged actual clock and clicking compensated line, plus committed handoff/rollback per-key offsets; preserve existing coverage.
- [x] Run required full verify and probe results; independent reviewer against baseline, fix reproduced material findings and affected checks.
- [x] Fill exact records, local links/whitespace, GraphFlow and owned cleanup; next enter playback statistics design.

## Self-review
LO01/05/07/08/10→Task1, LO02–06/09→Task2, native/restart and final proof→Task3. No AppSettings map race. Inline method persists after user implementation approval, no extra handoff confirmation.
