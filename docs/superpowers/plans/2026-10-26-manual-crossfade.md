# Current-Queue Manual Crossfade Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax for tracking. User approved the design and explicitly requested continued implementation; execute inline with one independent final review.

**Goal:** Crossfade current-queue manual next/previous/row selection while preserving the outgoing track during preparation.
**Architecture:** Extend the existing single reservation with explicit automatic/manual origin and manual navigation intent. Reuse production resolution, leases, prepared decks and rollback; mark the queue-row boundary with a dedicated action, leaving internal loads and new queues on their existing paths.
**Tech Stack:** Electron, Vue3, Pinia, TypeScript, Web Audio, production-bundled Node tests and isolated native Electron probes.
**Spec:** `docs/superpowers/specs/2026-10-26-manual-crossfade-design.md` (user-approved).

## Global Constraints

- Current queue only; previous >3 seconds restarts current unless navigating an uncommitted request chain.
- Independent `manualCrossfadeDurationMs`:0–12000ms,1000ms steps,default0; auto and short transitions independent.
- Outgoing stays audible during preparation; first valid incoming playing commits identity/history; failure preserves/restores valid outgoing.
- At most2 decks; explicit generation/queue/source/URL lease checks; full entry keys distinguish local/online/platform identity.
- Short/unknown duration keeps preparation protection with immediate handoff; `started` commit opportunity precedes `completed` cleanup.
- New intent immediately finishes an already audible handoff before preparing the next target; no3rd deck.
- Keep source files, daily data, main and published assets unchanged. No commit/push unless separately requested for this batch.

## Review Focus

1. Late pending selection or end event: only the latest still-valid manual target may play, once.
2. Rapid random next/back: unused draws return once in original order; unplayed targets never enter actual history.
3. Zero-duration handoff: completion must not clear reservation before identity commits.
4. Independent settings or auto reservation reuse: one origin cannot cancel the other or consume random twice.
5. UI boundary: filtered queue row maps to full index; history/new-list/retry never accidentally use manual overlap.

### Task 1: Preserve immediate prepared-handoff promise ordering

**Files:** `src/renderer/src/audio/web-audio-engine.ts`, `src/test/audio-engine-crossfade.test.mts`.
**Interface:** existing `CrossfadeOperation`; no new engine capability or resolver.
- [x] Add a meaningful asynchronous incoming-playing test proving zero-duration `started` handlers run before `completed`, correct deck promoted/released, and pre-playing failure preserves outgoing.
- [x] Build production test bundles, stage this suite, observe the lifecycle assertion fail.
- [x] Correct lifecycle ordering without changing nonzero, abort, seek or rollback semantics.
- [x] Run engine and controller suites; record results.

### Task 2: Add independent manual-duration setting and store contract

**Files:** `src/shared/types.ts`, `src/main/store/settings-store.ts`, renderer `stores/defaults.ts`, `stores/player.ts`, `utils/settings-pages.ts`, `App.vue`, `src/test/crossfade-settings.test.mts`.
**Interface:** `manualCrossfadeDurationMs` and `player.setManualCrossfadeDuration(ms)`; strict persisted validation matches existing automatic setting.
- [x] Add load/update/persistence/independence assertions and observe RED.
- [x] Add default0, normalization, independent settings control and App initialization/watch.
- [x] Add player ref/setter; changing manual0 must later affect only manual-origin reservations.
- [x] Run settings suite and typechecks; record results.

### Task 3: Implement protected current-queue manual requests

**Files:** `src/renderer/src/stores/player.ts`, `src/test/player-regression.test.mts`.
**Interfaces:** reservation origin, manual request generation, `playQueueEntry(index)` action, reactive pending target and generation-bound failure notice. Existing `playTrackAt` remains internal/legacy. Exact private field names may follow local conventions.
- [x] Add failing tests for enabled next/real previous/row select, old-state preservation, short/unknown immediate handoff, successful commit and preparation/post-start failure.
- [x] Route explicit eligible manual actions through the existing resolver/preparation; auto reservation may be adopted only before handoff, with refreshed outgoing snapshot.
- [x] Implement pending feedback/failure state separately from outgoing media errors; preserve leases and fallback target if outgoing naturally ends.
- [x] Run player regression suite; old automatic/manual-disabled paths remain green.

### Task 4: Complete navigation, cancellation and origin isolation

**Files:** `src/renderer/src/stores/player.ts`, `src/test/player-regression.test.mts` (small private helpers allowed; no second shuffle algorithm).
- [x] Add RED tests for next-next, pending previous undo, latest row select, same target/current restart, random draw ledger and history, automatic/manual reuse and failed-target prefetch suppression.
- [x] Maintain a pending cursor and draw ledger using existing random selection; return unused valid draws to pool front once, preserve actual audible history.
- [x] Cover pause/seek/stop/queue/source change, incoming failure, old ended before start, mid-fade new intent, independent setting changes and rate bounds.
- [x] Run player/engine/controller regressions and typechecks.

### Task 5: Connect current-queue UI and feedback

**Files:** renderer `components/PlaybackPanel.vue`, `components/PlayerBar.vue`, `App.vue` and player contract; existing Toast mechanism.
- [x] Pin current-page filtered-row selection to the full queue identity and the new manual action; history branch still uses its existing action.
- [x] Show generation-bound preparation target in existing player status area; surface failure once through existing notices without changing outgoing error state.
- [x] Add meaningful native DOM cases for current row, filtered row, history exclusion and latest preparation feedback; do not substitute source-string assertions for interaction proof.
- [x] Run focused native generated-media/DOM probe and typechecks.

### Task 6: Full verification, documentation and final independent review

**Files:** extend `tools/probe/crossfade-lifecycle*` or a dedicated generated-media probe using the same owned-profile/bundle harness; `tools/build-test.mjs` if needed; README, PRODUCT_RULES, design status, `docs/development/2026-10-26-manual-crossfade.md`.
- [x] Exercise native manual overlap, asynchronous start, immediate handoff, failure rollback, rapid selection and exact outgoing release with zero external requests; retain automatic cases.
- [x] Run `npm run verify`; validate changed-document links and `git diff --check` (include new files explicitly).
- [x] Request one fresh final review of the complete implementation, resolve material findings with regressions, then rerun affected checks only.
- [x] Record exact evidence and manual/live boundaries, incrementally index GraphFlow, leave the completed branch uncommitted for user review.

## Plan Self-Review

Every spec section maps to Tasks1–6. Settings are established before reservation integration; UI consumes the Task3 action/feedback contract. All five review risks have named coverage. Tests run from production bundles; real sources and listening remain separate from synthetic proof.
