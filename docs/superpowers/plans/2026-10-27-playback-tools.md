# Playback Tools Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:executing-plans, inline sequential execution. User explicitly approved the complete design and requested all three features in order; preserve this authorization without another execution-method prompt. One fresh final independent review.

**Goal:** Save the full current queue atomically, enter A/B times precisely, and fade sleep audio independently of user volume.
**Architecture:** Extend PlaylistStore's serialized transaction with a bounded sanitized queue snapshot. Add a generation-bound loop edit and independent sleep gain in the existing player/engine lifecycle. Reuse UI dialog styles and production probes.
**Tech Stack:** Existing Electron/Vue/Pinia/TypeScript, Web Audio, production esbuild bundles and isolated generated-media probes.
**Spec:** `docs/superpowers/specs/2026-10-27-playback-tools-design.md` (approved).

## Global Constraints

- Existing isolated `codex/manual-crossfade` worktree; preserve pushed d7fca385. No commits/push/merge/release for this new batch without request.
- Queue: current full queue only, immutable click-time snapshot, stable full-identity deduplication; 1–50000 raw tracks, 20MiB raw JSON max, trimmed name 1–4096 without NUL. One durable creation, no source CAS relaxation.
- Loop: seconds / mm:ss / hh:mm:ss, at most3 fractional digits; 0<=A<B<=finite duration, at least1s. Confirm enables, paused stays paused, reject changed playback generation atomically.
- Sleep: session-only 0/5/10/20/30/60s, default0. Immediate uses countdown tail, track-end uses rate-adjusted media tail only after deadline; unknown stops at deadline. Independent shared gain, no volume/mute mutation.
- Production tests via tools/build-test.mjs + runner. Synthetic/DOM acceptance distinct from human listening, no personal/live scripts.

## Review Focus

1. Click-time snapshot survives queue replacement/search; double submit creates once (Task2).
2. Persist rejection with concurrent playlist mutation leaves no partial empty list (Task1).
3. Same track replayed under a new generation invalidates old loop dialog (Task3).
4. Sleep stop resets gain only after audio is released; stale callbacks cannot silence fresh playback (Task4).
5. Sleep tail responds to seek/rate/late callbacks without competing with short or crossfade gain (Tasks4/5).

### Task 1: Bounded atomic queue save backend

**Files:** create shared/queue-playlist.ts; modify main/store/settings-store.ts, shared/ipc.ts, main/ipc-validation.ts, main/index.ts, preload/index.ts, tools/build-test.mjs; create test/queue-playlist.test.mts.
**Interface:** `PlaylistStore.createFromQueue(name:string,tracks:PlayableTrack[]):Promise<QueuePlaylistResult>`; result `{playlist:Playlist,inputTracks:number,tracks:number,duplicates:number}`. Preload `playlists.createFromQueue(name,tracks)`.
- [x] Add meaningful RED: full identity stable dedup, immutable payload, binding/metadata retained but runtime/inline script cover omitted, malformed/over-limit rejected before mutation, write failure rollback plus concurrent subsequent mutation, disk reload consistency, IPC arity validation.
- [x] Implement shared limits/result and pure queue cleaning; bounded raw validation before clone, whitelist existing typed track fields and preserve providerData; sanitize data URI cover via existing helper. Create list/items in one mutate.
- [x] Wire typed channel/preload/handler and validator; production build tests, stage/run new suite, typecheck.

### Task 2: Current queue save UI

**Files:** PlaybackPanel.vue, stores/library.ts, stores/ui.ts, DialogHost.vue; production DOM queue probe.
**Interface:** library `createPlaylistFromQueue`; existing prompt accepts optional explanatory message. Snapshot captured before awaiting dialog; serialized save action guards double click.
- [x] Current-page only button, empty disabled; name prompt displays input/dedup count and full-queue snapshot wording. Reuse serialized backend and refresh; errors notify, cancel no mutation.
- [x] Native DOM exercises filtered snapshot, replacement while dialog open, cancel, success order/count, history exclusion and input busy. No source-only UI assertion substitutes.

### Task 3: Strict loop time input

**Files:** create shared/loop-time.ts, renderer/components/LoopRangeDialog.vue; modify ui.ts, App.vue, track-actions.ts, player.ts, tools/build-test.mjs; pure parser and player regression tests.
**Interfaces:** parseLoopTime/formatLoopTime; player `loopEditContext()` and `applyLoopRange(context,a,b)` generation-bound atomic action. ui.loopRangeEdit stores context, dialog mounted at App.
- [x] RED parser valid numeric/clock/precision and invalid boundary tests; player changed generation, malformed range, paused outside range, pending prep cancellation, valid range/normal rollback.
- [x] Implement strict parser/formatter, context snapshot and atomic validation-before-cancel; confirm enables without play. Add accessible two-field modal with error/keyboard focus and existing styles.
- [x] Production parser/player regressions and native DOM actual input+validation+paused behavior.

### Task 4: Independent sleep gain and policy

**Files:** shared/audio-engine.ts, renderer/audio/web-audio-engine.ts, stores/player.ts, track-actions.ts, PlayerBar.vue; engine/player tests.
**Interfaces:** engine optional `setSleepGain(value:number)`; player sleepFadeDurationMs/sleepFading/setSleepFadeDuration. Shared output sleepGain node owns only sleep automation, initialized from stored scalar.
- [x] RED engine multiplication/initialization/stop/dispose checks and player countdown/track-end/rate/seek/pause/reset/stale callback/dual-deck cases.
- [x] Add dedicated gain, smooth target; use session ref0, validated menu choices. Active timer ticks100ms with generation guard; compute actual wall time or rate-adjusted tail, never move stop deadline. Stop audio before resetting gain, remove idle callbacks.
- [x] Recompute after transport and media changes; no snapshot gain rollback or competing volume updates. Add menu and status. Run production affected suites/typecheck.

### Task 5: Native integration, review and docs

**Files:** tools/probe/queue-search.mjs, crossfade-lifecycle-main.cjs (generated media harness), README, PRODUCT_RULES, development evidence and plan status.
- [x] Production DOM and native generated audio prove all three features, sleep decreasing energy and cancel recovery, stop release/zero external requests, owned profile cleanup.
- [x] Fresh full npm run verify after integration, check logs/exit; independent final reviewer per requesting-code-review, reproduce any material finding and rerun affected checks.
- [x] Document exact automated results and human/listening limits, validate links/whitespace, index GraphFlow. Leave new batch uncommitted.

## Self-review

Spec1→Tasks1/2, Spec2→Task3, Spec3→Task4; PT01–PT04→Tasks1/2, PT05–PT07→Task3, PT08–PT11→Task4, PT12→Task5. Three ordered features retain one plan because the user requested sequential delivery and shared final playback probes; no new dependencies or migration.
