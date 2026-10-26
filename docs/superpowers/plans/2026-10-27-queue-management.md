# Queue Management Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL superpowers:executing-plans, inline sequential execution with one independent final reviewer. User approved complete design and both features in order; no repeated execution-method approval. Preserve preceding uncommitted playback-tools work.

**Goal:** Edit selected current-queue entries together and save full historical queue snapshots without changing playback.
**Architecture:** A pure bounded-by-current-queue edit planner and a version/generation-bound player transaction handle identity and cancellation once. Existing TrackList selection menus consume it. Extend the existing snapshot save path to the shown historical page, retaining the same atomic main-process endpoint.
**Tech Stack:** Existing Vue/Pinia/TypeScript/Electron, production esbuild tests and owned-profile DOM/generated media.
**Spec:** `docs/superpowers/specs/2026-10-27-queue-management-design.md` (approved).

## Global Constraints

- Use existing isolated codex/manual-crossfade. Preserve all preceding uncommitted files. No commit, push, merge or release for this batch.
- Current-queue editing only; full identity keys, original queue order, strict whole-context rejection. Duplicate full identities in queue disable bulk editing. Same raw IDs across platform/local remain distinct.
- Actions remove / after-current / to-end. Removing current stops and clears resume; moves preserve current identity/media/time. Real no-op never cancels or revises. Random order algorithm unchanged.
- Capture revision, playback generation, current key/index, selected keys at menu construction. Validate before side effects; cancel/finish reservations once, update queue once, preserve unrelated AB/sleep/history/source lists.
- Historical save captures shown complete page before await, ignores search filter, same 1–50000 tracks/20MiB/name limits and stable dedup; never restores playback. Shared busy guard across paging.

## Review Focus

1. Selection toolbar and row menu act on the same keys including filtered hidden neighbors (Tasks1/2).
2. Natural advance or incoming commit during confirmation makes old context invalid (Task2).
3. Removing/moving a pending target returns shuffle draws once; no-op preserves pending target (Tasks1/2).
4. Handed-off crossqueue reservation is finalized before editing committed queue; old failure cannot restore edits (Task2).
5. History page changes/eviction and duplicate submit while naming never retarget save (Tasks3/4).

### Task 1: Pure queue edit planner and production store transaction

**Files:** create `src/shared/queue-edit.ts`, `src/test/queue-edit.test.mts`; modify player.ts, player-regression.test.mts, tools/build-test.mjs.
**Interfaces:** `QueueEditAction='remove'|'after-current'|'to-end'`; `planQueueEdit(queue,currentIndex,keys,action)` returns final queue/index/changed/affected/removesCurrent. player `queueEditContext(keys):QueueEditContext`, `applyQueueEdit(context,action):number` exposes immutable revision/generation/current identity + selected keys.
- [x] RED pure tests: noncontiguous selection in original order; current included in moves; removal index/empty; duplicate/unknown/ambiguous identities; true no-op.
- [x] RED player tests: keep loaded clock/AB/sleep; current deletion stops/releases/clears session; stale generation/revision/invalid/maintenance reject unchanged; pending and handed-off cancellation; random navigation pool and no-op reservation.
- [x] Implement planner O(n) via sets, strict context validation before callbacks; compute first, cancel once, replace once, revise once; align current key and filter removed random identities. Build production bundles and run affected suites/typecheck.

### Task 2: Current queue multi-selection menus

**Files:** PlaybackPanel.vue; tools/probe/queue-search.mjs or dedicated queue-management probe.
**Interfaces:** queueActions(track,index,selection) uses Task1 context captured at construction; async removal confirmation reuses exact captured context, no loop over removeFromQueue.
- [x] Native RED missing batch action then wire shared toolbar/row menu: counts, current removal warning, after-current/to-end targets, duplicate/maintenance unavailable reason and precise feedback.
- [x] Actual DOM checks Ctrl/Shift selections, toolbar and row menus, filtered order, cancel/delete current and noncurrent, no-op/pending transport, source lists unchanged. History editing remains excluded.

### Task 3: Historical page save

**Files:** PlaybackPanel.vue and native queue probe; reuse existing library.createPlaylistFromQueue/main API unchanged.
- [x] Native RED history save button missing, then capture shown.value full tracks/label/live before await; share existing bounds, name dialog and busy guard. History default name prefix 历史队列, explanatory source + counts.
- [x] Native checks filtered historical save while paging/live replacement/history eviction, duplicate confirm creates once; active queue/index/mode/audio unchanged and old history editor actions absent. Existing live save cases stay green.

### Task 4: Integrated validation, review and record

**Files:** native probes, README/PRODUCT_RULES, docs/development/2026-10-27-queue-management.md, plan/spec.
- [x] Full necessary npm run verify, generated-media/DOM acceptance, owned profiles cleanup; read actual exit/logs. Preserve baseline18 native cases and add actual bulk edit during crossqueue overlap/current removal; report observed counts.
- [x] Fresh final independent reviewer on delta from task-owned source snapshots; any material finding must be reproduced then fixed and affected checks rerun.
- [x] Record precise counts/boundaries, local link/whitespace checks, index changed graph. Leave work uncommitted, listening deferred.

## Self-review

QM01–08→Tasks1/2, QM09–11→Task3, final evidence→Task4. Planner and store interfaces precede menus; history reuses prior approved atomic save. Source snapshots at setup distinguish this delta from preceding uncommitted batch during final review.
