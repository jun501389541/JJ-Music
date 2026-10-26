# Playback Expansion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans inline, task by task. User approved the full design and sequential implementation; no execution-method approval is needed. One independent final review.

**Goal:** Deliver A–B loop, sleep-after-track and protected cross-queue manual transitions together.
**Architecture:** Extend the existing player reservation and session lifecycle. Keep A–B state session-only; sleep is a higher-priority transport intent. Cross-queue selection stages an immutable queue transaction, commits on valid playing and rolls back only while the outgoing deck remains valid. Serialize owned history/session persistence.
**Tech Stack:** Existing Vue/Pinia/TypeScript, WebAudioEngine, esbuild production tests, isolated Electron probes; no new dependencies.
**Spec:** `docs/superpowers/specs/2026-10-26-playback-expansion-design.md` (user approved).

## Global Constraints

- Preserve all preceding uncommitted manual-crossfade changes; work in existing isolated `codex/manual-crossfade` worktree. No commit, merge, push or release.
- A–B minimum 1 second, finite duration, full track identity; session-only, never persisted. Manual seek outside pauses looping.
- Sleep deadline exits A–B and finishes the currently committed whole track; unknown duration stops immediately. Preserve nonexpired sleep intent across queue changes.
- User new-queue actions are explicit; internal retry/resume and historical queue restore retain legacy behavior.
- Prepare without changing current queue/history; commit on started before completed cleanup. At most two decks. Failed preparation leaves old queue untouched.
- Production offline tests via `tools/build-test.mjs` and runner. Synthetic/native media and human listening are distinct; no personal/live scripts.

## Review Focus

1. B equals media tail: ended/progress must not both loop and advance (Task1).
2. Deadline races incoming playing/late prepare: exactly one retained identity, no late audio (Task2/3).
3. Queue edits or source changes during transaction: no stale rollback overwriting new edits (Task3).
4. Delayed persistence completion after rollback: final saved queue/history must reflect latest intent (Task3).
5. Nonexpired sleep and old A–B survive failed new-queue preparation, but cannot revive after stop/deadline (Task2/3).

## Files and responsibilities

- `src/renderer/src/stores/player.ts`: playback state/actions and shared priorities; reuse existing store pattern.
- `src/test/player-regression.test.mts`: deterministic production player/engine cases, plain JavaScript compatible with runner staging.
- `src/renderer/src/utils/track-actions.ts`, `components/PlayerBar.vue`: existing menu/status surfaces.
- User new-queue callers in components/views, `utils/settings-pages.ts`: explicit boundary and help.
- `tools/probe/crossfade-lifecycle-main.cjs`, `tools/probe/queue-search.mjs`: generated native media/production DOM.
- README, PRODUCT_RULES, development record: final delivered behavior and validation boundaries.

### Task 1: Implement session A–B loop

**Files:** player store and player regression suite.
**Interfaces:** `abLoop: {key:string,a:number,b:number|null,enabled:boolean}|null`; `setLoopA():void`, `setLoopB():void`, `setLoopEnabled(enabled:boolean):void`, `clearLoop():void`. Invalid actions retain prior valid state and notify.
- [x] RED tests `AB loop`: A/B at10/20; gap<1 rejected; unknown duration rejected; progress20→10; ended at B=duration→A without next; outside seek disables; pause preserves; stop/new audible track clears; manual prep suspends and failure restores.
- [x] Add identity-bound refs/actions and a guarded shared boundary handler called by progress/ended; internal loop seek bypasses user outside-seek disabling but suppresses reservation reentry. Disable auto prefetch during active loop, suspend with manual reservation, capture/restore with outgoing snapshot.
- [x] Build tests, stage suite, run `node --test --test-name-pattern='AB loop' out/test/player-regression.test.mjs`; observe FAIL before implementation and PASS after.

### Task 2: Add sleep completion policy

**Files:** player store/regression suite.
**Interfaces:** `sleepMode:'immediate'|'track-end'`, `sleepWaiting:boolean`, `setSleepMode(mode):void`; preserve `setSleepMinutes` and cancellation. Check deadlines also on progress/playing, making wall-clock sleep wake reliable.
- [x] RED tests with controlled `Date.now`: deadline exits AB but does not stop finite current until ended; single repeat overridden; paused waits; unknown duration stops; pending manual canceled; active fade finished; valid user selection cancels waiting; nonexpired clock survives new queue; deadline cancellation blocks late ready.
- [x] Implement expiry/ended/error priority and state cleanup. Selection intent helper cancels only expired wait, legacy internal paths preserve nonexpired timer; stop always cancels.
- [x] Production focused sleep/AB tests green and node/web typecheck.

### Task 3: Implement protected new-queue transaction

**Files:** player store/regression suite; optional small private type/helper files if necessary.
**Interfaces:** `playUserQueue(tracks:PlayableTrack[],startIndex?:number,label?:string,options?:{playMode?:PlayMode;singleTrackAudition?:boolean}):Promise<void>`. Reservation optional queue transaction contains immutable target and old queue/history/random snapshot. Shared feedback continues existing manual target contract.
- [x] RED tests `cross queue`: old queue/index/history unchanged while resolving; started atomically commits; prep failure preserves AB/sleep; post-start error restores old live clock/queue/mode/history; latest request supersedes; old ended advances target once; settings0 converts same selection; source/edit/seek/pause/stop cancel; current-queue next cancels new queue first.
- [x] Generalize reservation validity/commit/rollback for staged queues, reuse bounded resolve/preparation/lease and existing operation ordering. Flush outgoing session before commit; snapshot A–B and random state. Finish handed-off transaction before edits or new request.
- [x] Serialize queueHistory/lastSession writes through one owned-save chain; capture sanitized field payloads when enqueued, report failure once and retain in-memory state. Tests delay first write then rollback/newer selection and verify final persisted values and unrelated settings untouched.
- [x] Run full player/engine/settings regressions and typecheck.

### Task 4: Connect menus and explicit user entrypoints

**Files:** track-actions, PlayerBar, settings-pages and all direct user new-queue callers (rg references); historical/internal calls stay legacy.
- [x] Add A/B actions and loop status; sleep expiry-mode choice with existing presets, no deadline reset on choice. Shared status shows waiting/target/loop without hiding cancel actions.
- [x] Route user new-queue calls from library, playlists, search (including audition), charts and public playlist preview through `playUserQueue`; preserve filters/full indices and existing queue options. Leave playQueueSnapshot/restore/retry untouched.
- [x] Extend actual DOM probe to exercise loop menu, sleep mode, new queue preparation/commit and historical restore exclusion; verify new settings text and typecheck.

### Task 5: Validate and document complete delivery

**Files:** native probes, README/PRODUCT_RULES, development record, plan/spec status.
- [x] Add generated-media native cases for A/B repeat and tail, deadline/whole-track stopping, cross-queue overlap/rollback/latest intent and exact deck release; collect boundary deviation rather than claiming sample accuracy.
- [x] Run `npm run verify`, native media and production DOM probes; inspect output/exit status. Validate changed markdown links/new files and `git diff --check`.
- [x] One fresh independent final reviewer for complete expansion patch; reproduce material issues RED→GREEN and rerun affected checks only.
- [x] Update evidence and boundaries, index GraphFlow, leave all changes uncommitted. Human listening stays pending.

## Plan self-review

Tasks1/2/3 own loop, sleep and queue transaction; Task4 owns all UI boundaries, Task5 owns native/whole delivery. Shared snapshot, stop and reservation interfaces are sequential and reuse one state machine. Review Focus1→Task1,2/5→Task2/3,3/4→Task3. No uncovered design requirement identified. API names above stay consistent across tasks; exact private helpers are implementation choices.
