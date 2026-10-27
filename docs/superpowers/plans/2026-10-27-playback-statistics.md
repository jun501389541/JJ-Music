# 本机播放统计 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans. Inline execution is preserved from the approved work.

**Goal:** 双声道有效墙钟时间、30秒/短曲完整计次和本机只读排行可靠持久化。
**Architecture:** shared纯tracker和协议；独立PlaybackStatisticsStore令牌累计高水位/原子batch；WebAudioEngine只读声道采样；Pinia协调访问与批次；独立统计页。
**Tech Stack:** TypeScript/Vue/Pinia/Electron，生产bundle、虚拟时钟和真实生成媒体。
**Spec:** [已批准设计](../specs/2026-10-27-playback-statistics-design.md)

## Global Constraints
- 实际墙钟时间，单区间<=2000ms，min(dt,mediaAdvance/rate)；30秒门槛，短曲无seek完整覆盖至EOF，250ms端点容差。
- 交叉渐变各曲各计，旧曲回滚继续同访问；自动重试同访问，未发声无记录。
- 累计batch<=16，client未终结<=16，main活动<=32/renderer及closed缓存256；5秒上报/资格或结束立即，失败退避1/2/4/8/30秒。
- version1独立文件50000首/16MiB，安全整数，键<=4096，name/singer<=1024，写成功才提交。
- 保留所有前置未提交实现，不提交推送；统计只读不追历史。

## Review Focus
1. 两个真实Audio元素的暂停/等待/自然EOF与强制finish区别。
2. retry与回滚不能把同曲计两次，generation不可代替访问。
3. batch重试、closed token重放、候选落盘失败不推进高水位。
4. renderer页刷新清理旧令牌，关闭迁移仅等待已接受批次。
5. 页面旧应答revision、空/坏文件、只展示100条与总览范围。

### Task 1: Shared measurement and main store
**Files:** create shared/playback-statistics.ts, main/store/playback-statistics-store.ts, test/playback-statistics.test.mts, test/playback-statistics-store.test.mts; modify build-test.mjs, ipc.ts, main/index.ts, preload/index.ts.
**Interfaces:** PlaybackSample {visitId,at,time,duration,rate,flowing,event}; PlaybackMeter.sample()->{totalMs,qualified,final,started}; StatsTrack {key,name,singer,platform}; StatsSnapshot {revision,records}; StatsReport {token,totalMs,qualified,final}; store.get/begin(owner,track)/submit(owner,reports)/releaseOwner/flush.
- [x] Capture full relative-path source baselines and ledger.
- [x] RED meter 30s/short/seek/rate/wait/long-gap/overlap, store replay/rollback/concurrency/corrupt/limits; observe failures.
- [x] Implement pure math, strict protocol and serialized batch candidate-write-commit, fixed file, token limits/replay, IPC shutdown/owner cleanup.
- [x] Affected production tests/typecheck GREEN.

### Task 2: Engine observer and coordinator
**Files:** audio-engine.ts, web-audio-engine.ts, new renderer/stores/playback-statistics.ts, player.ts, App.vue, player/engine tests, new test/playback-statistics-client.test.mts.
**Interfaces:** LoadOptions.statisticsVisitId; AudioEngine.observePlayback?(handler):unsubscribe; stop optional preserveStatisticsVisitId for automatic retry; Pinia.initialize/register/sample/flush/shutdown; reservation statisticsVisitId and loaded statistics id.
- [x] RED client delayed begin/ack/retry，GREEN累计确认；生产engine双声道/seek/stalled和奇数声道重试先失败后通过。协议上限/旧应答由实现校验并独立审查，未逐个增加新测试。
- [x] Add read-only per-deck flow/wait/id and observer boundaries, reuse existing200ms progress loop (ruling: finer than suggested250ms, no extra audio timer). Explicit normal-vs-forced fade completion.
- [x] Bind ids only to current intent/reservation; retain on auto retry/reload, stop finalizes, rollback retains outgoing deck identity. Status ready gates sampling, no audio blocked by failures.
- [x] Run affected suites/typecheck and build.

### Task 3: Read-only view and acceptance
**Files:** new StatisticsView.vue, SideBar.vue, router/index.ts, statistics probes or existing probes.
- [x] 视图投影RED后实现summary/full identity/search/pagination100/sort/time labels和distinct errors；复用生产DOM增加真实route/menu覆盖，未单独运行缺路由RED。
- [x] Actual production DOM seeded stats and live segments, normal restart and corrupt-file safety; preserve prior110 cases.
- [x] Native real >30s threshold, natural short vs seek, both-deck fades/rollback; preserve prior27, virtual time not presented as real30s.

### Task 4: Final verification/review/record
**Files:** README/PRODUCT_RULES, development/2026-10-27-playback-statistics.md, spec/plan/roadmap.
- [x] Required full verify and fresh independent reviewer vs exact relative baselines; fix reproduced material findings and affected checks.
- [x] Record exact counts and limited evidence, cleanup owned temp/profiles, links/whitespace and GraphFlow.
- [x] Leave all requested feature work uncommitted; human listening remains deferred.

## Self-review
ST01–03 Task1/2; ST04/05 Task2/3; ST06–08 Task1/2; ST09/10 Task3/4. No new settings or external service. Interface names shared above, all counts/bounds anchored to approved spec.
