# Crossfade Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add configurable, automatic crossfade between eligible queue tracks using two media elements in one Web Audio context.

**Architecture:** Extend the engine-agnostic `AudioEngine` contract with optional preparation and crossfade operations. `WebAudioEngine` owns two media decks and their equal-power gain envelopes; `player.ts` owns queue reservation, URL resolution, current-track identity, and rollback. A new persisted duration setting controls automatic overlap independently from short pause/switch fades.

**Tech Stack:** TypeScript, Vue 3, Electron 42, Web Audio API, Node built-in `node:test`, existing `tools/build-test.mjs` and `tools/run-tests.mjs`.

**Spec:** `docs/superpowers/specs/2026-10-26-crossfade-design.md` (user approved 2026-10-26).

## Global Constraints

- `crossfadeDurationMs` is proposed as 0–12,000 ms in 1,000 ms steps, default 0; 0 disables crossfade.
- `shortAudioTransitions` remains independent and continues controlling the existing short pause/resume and manual-switch fades.
- Crossfade only follows eligible automatic advances. Manual next/previous/direct selection keeps the existing short fade.
- Do not crossfade list mode at its last row, single-repeat, single-track audition, a repeated queue identity, unknown durations, or tracks too short for at least 1,000 ms of overlap.
- Reserve at most one next entry. Reuse its selection through handoff; revalidate queue identity, play generation, and URL lease before loading it.
- Never lower the outgoing gain while resolution or media preparation is pending. On failure after handoff starts, restore outgoing state and keep playback-history records for an incoming track that actually became audible.
- Before handoff, seek cancels the reservation and seeks the outgoing track. After handoff, seek finishes the handoff and seeks only the incoming track.
- Keep current uncommitted user work intact. In particular, `src/main/store/settings-store.ts` already contains playlist changes: edit only the settings default/normalization needed here. Do not commit, merge, or push as part of this plan.
- Use generated or synthetic media only. Automated crossfade probes must make zero external requests; real sources and listening acceptance remain separate.

## Review Focus

1. A prepared online URL expires or is still buffering at the fade boundary: the outgoing track stays at full gain and the normal ended path remains usable. Pin in Task 5 with `expired or late prepared URL leaves the outgoing track unchanged`.
2. Queue order, play mode, or random reservation changes while preparation is pending: no stale/deleted row is played and random selection is consumed once. Pin in Task 5 with `queue edits invalidate stale reservations without drawing random twice`.
3. The incoming track fails after it becomes audible: outgoing identity, index, live position, lyrics, and media controls are restored; audible history is not erased. Pin in Task 5 with `mid-crossfade failure restores outgoing playback state`.
4. Pause, seek, disable, stop, or a newer manual selection races with the envelope: only the intended deck remains audible and no stale callback changes state. Pin in Tasks 2, 3, and 5 with the corresponding cancellation/seek tests.
5. Single-repeat, audition, unknown duration, short clips, and queue boundaries: playback follows the documented fallback without overlap. Pin in Task 5 with `ineligible modes and durations use the existing ended path`.

---

### Task 1: Define the Optional Audio Engine Crossfade Contract

**Files:**
- Modify: `src/shared/audio-engine.ts`
- Create: `src/shared/crossfade.ts`
- Modify: `tools/build-test.mjs` (bundle shared modules used by the production test suites)
- Test: `src/test/audio-crossfade-contract.test.mts`
- Test: `src/test/player-regression.test.mts` (update typed engine fixtures only if required)

**Interfaces:**
- Add opaque `PreparedAudioTrack { readonly token: number }`.
- Add `CrossfadeOperation` with `started: Promise<void>`, `completed: Promise<void>`, and `pause()`, `resume()`, `finish()`, and `cancel()` methods. `started` rejects if preparation fails before becoming audible; `completed` rejects only for a failure after `started` resolves.
- Add optional `AudioEngineCapabilities.crossfade?: boolean` and optional engine methods `prepareTrack(options: LoadOptions): Promise<PreparedAudioTrack>`, `crossfadeTo(track: PreparedAudioTrack, durationMs: number): CrossfadeOperation`, and `discardPreparedTrack(track: PreparedAudioTrack): void`.
- Add `supportsCrossfade(engine: AudioEngine): boolean`, true only when the capability is declared and all three optional methods exist.
- Add `CROSSFADE_DURATION_MIN_MS = 0`, `CROSSFADE_DURATION_MAX_MS = 12_000`, `CROSSFADE_DURATION_STEP_MS = 1_000`, `DEFAULT_CROSSFADE_DURATION_MS = 0`, `normalizeCrossfadeDurationMs(value: unknown): number`, and `crossfadeGains(progress: number): { outgoing: number; incoming: number }` to `src/shared/crossfade.ts`.
- Contract: `started` resolves when the incoming deck emits its first valid `playing` event and the fade has begun; `completed` resolves after the outgoing deck is released. Failure before completion rejects `completed`; `cancel()` restores the outgoing deck, while `finish()` promotes the incoming deck and releases the outgoing one immediately.

- [x] **Step 1: Add failing tests for the optional engine contract, duration normalization, and gain curve**

Tests: `engines without crossfade methods remain on the legacy path`, `crossfade capability without all methods is unsupported`, `duration normalization clamps and quantizes to whole seconds`, `equal-power gains start on outgoing only`, `equal-power gains end on incoming only`, `equal-power midpoint keeps both gains finite and balanced`, and `gain progress clamps and non-finite values stay finite`.

- [x] **Step 2: Run the offline suite and confirm the new contract suite fails**

Run: `npm test`

Expected: the new `audio-crossfade-contract.test.mjs` suite fails because the optional contract and shared helpers do not exist; unrelated suites remain green.

- [x] **Step 3: Add the optional engine types, capability guard, shared constants, normalizer, and pure gain curve**

- [x] **Step 4: Run the offline suite and web typecheck**

Run: `npm test`

Expected: all offline suites pass, including `audio-crossfade-contract.test.mjs`.

Run: `npm run typecheck:web`

Expected: exit 0.

### Task 2: Implement a Deterministic Crossfade Envelope

**Files:**
- Create: `src/renderer/src/audio/crossfade-controller.ts`
- Modify: `tools/build-test.mjs` (bundle the controller for production-source tests)
- Test: `src/test/crossfade-controller.test.mts`

**Interfaces:**
- Import the shared `crossfadeGains` helper from `src/shared/crossfade.ts`; do not define a second curve.
- Export `CrossfadeController` to schedule, pause/resume, finish, and cancel the two gain envelopes using an injected audio clock and scheduler.
- Use the shared equal-power curve: outgoing `cos(progress * π / 2)`, incoming `sin(progress * π / 2)`, with progress clamped to `[0, 1]`.

- [x] **Step 1: Add failing tests for envelope scheduling and lifecycle**

Tests: `controller schedules both decks from the injected audio clock`, `pause and resume preserve remaining envelope time`, `finish promotes incoming and releases once`, `cancel restores outgoing gain`, and `cancelled callbacks cannot finish a newer transition`.

- [x] **Step 2: Run the offline suite and confirm the new controller tests fail**

Run: `npm test`

Expected: the new `crossfade-controller.test.mjs` suite fails because the controller does not exist.

- [x] **Step 3: Implement the cancellable envelope controller**

Keep master volume and mute outside the controller. Pausing must hold both gain values; resuming continues only the remaining duration. `finish()` promotes incoming; `cancel()` restores outgoing.

- [x] **Step 4: Run the offline suite**

Run: `npm test`

Expected: all offline suites pass.

### Task 3: Add Two Media Decks to `WebAudioEngine`

**Files:**
- Modify: `src/renderer/src/audio/web-audio-engine.ts`
- Modify: `src/renderer/src/audio/crossfade-controller.ts` (only if the engine integration requires a narrow controller hook)
- Test: `src/test/audio-engine-crossfade.test.mts`

**Interfaces:**
- `prepareTrack(options, signal?)` loads one inactive deck and resolves to an engine-owned token only after metadata and `canplay`; it must not change active progress, emit active `playing`, or replace the current deck. An optional `AbortSignal` cancels a preparation before a token exists.
- `crossfadeTo(token, durationMs)` returns the `CrossfadeOperation` from Task 1 and uses the controller from Task 2.
- `discardPreparedTrack(token)` aborts and releases only that prepared deck.
- `capabilities.crossfade` is `true` for `WebAudioEngine`.

- [x] **Step 1: Add fake media-element and fake Web Audio graph tests**

Tests: `prepared deck shares the active AudioContext`, `preparation failure leaves the active deck audible`, `abort cancels an inactive preparation without stopping the active deck`, and `only the promoted deck emits active progress and ended events`.

- [x] **Step 2: Run the offline suite and confirm the new deck tests fail**

Run: `npm test`

Expected: the new deck tests fail because there is only one media element.

- [x] **Step 3: Implement two deck records in `WebAudioEngine`**

Create each `MediaElementAudioSourceNode` once. Route both decks through per-deck crossfade gain, the shared equalizer, shared user-volume/mute gain, analyser, and destination. Keep active-deck identity separate from prepared-deck identity.

- [x] **Step 4: Cover all shared controls and teardown paths**

Tests: `volume mute equalizer and rate apply to both decks`, `changing rate during a crossfade retimes it before either media deck can end`, `load and stop discard any prepared deck`, `destroy releases both media elements`, `outgoing ended before a pending incoming deck starts cancels it and advances once`, and `outgoing ended during crossfade completes the handoff without advancing twice`.

- [x] **Step 5: Run tests and web typecheck**

Run: `npm test`

Expected: all offline suites pass.

Run: `npm run typecheck:web`

Expected: exit 0.

### Task 4: Persist the Crossfade Duration Setting

**Files:**
- Modify: `src/shared/types.ts`
- Modify: `src/main/store/settings-store.ts`
- Modify: `src/renderer/src/stores/defaults.ts`
- Modify: `src/renderer/src/utils/settings-pages.ts`
- Modify: `src/renderer/src/App.vue`
- Test: `src/test/crossfade-settings.test.mts`

**Interfaces:**
- Add `AppSettings.crossfadeDurationMs: number`.
- Set both main-process and renderer defaults to `0`.
- Sanitize persisted and updated values to the supported set `0, 1000, …, 12000`; invalid values fall back to `0`.
- Add a playback setting control with an explicit `关闭` option and 1-second increments. Keep `shortAudioTransitions` unchanged.
- Add `player.setCrossfadeDuration(durationMs: number)` and synchronize it from the settings watcher and startup initialization in `App.vue`.

- [x] **Step 1: Test old settings migration, invalid values, persistence, and independence from short fades**

Tests: `legacy settings load with crossfade disabled`, `invalid crossfade durations normalize to zero`, `crossfade duration persists in whole seconds`, and `short transition preference stays independent`.

- [x] **Step 2: Run the offline suite and confirm new settings assertions fail**

Run: `npm test`

Expected: the new `crossfade-settings.test.mjs` suite fails before the setting exists.

- [x] **Step 3: Add the setting to the shared type, both defaults, store normalization, settings page, and App initialization/watchers**

In `settings-store.ts`, preserve all existing playlist changes; make a focused edit to `DEFAULT_SETTINGS`, load normalization, and update normalization only.

- [x] **Step 4: Run settings tests and typechecks**

Run: `npm test`

Expected: all offline suites pass.

Run: `npm run typecheck`

Expected: both node and web typechecks pass.

### Task 5: Coordinate Queue Reservation and Player State Handoff

**Files:**
- Modify: `src/renderer/src/stores/player.ts`
- Test: `src/test/player-regression.test.mts`

**Interfaces:**
- Add a single pending reservation containing the full `playlistEntryKey`, queue/play generation, selected next index, resolution controller, prepared engine token, outgoing snapshot, and optional `CrossfadeOperation`.
- Add `setCrossfadeDuration(durationMs: number): void`.
- Use the existing `resolveWithTimeout`, `playbackUrlLease`, `pickNextIndex`, and `playlistEntryKey`; do not add a second resolver or a separate random-selection algorithm.
- Commit `currentIndex`, progress ownership, lyrics, media controls, and play history when `operation.started` resolves. Keep incoming play history if it became audible; on `completed` rejection restore the outgoing snapshot only if its identity is still present and valid.

- [x] **Step 1: Add failing tests for eligibility, bounded reservation, URL expiry, and random selection**

Tests: `ineligible modes and durations use the existing ended path`, `reservation prepares at most one next track`, `expired or late prepared URL leaves the outgoing track unchanged`, and `queue edits invalidate stale reservations without drawing random twice`.

- [x] **Step 2: Run the offline suite and confirm the new player tests fail**

Run: `npm test`

Expected: the named crossfade player tests fail while existing queue and URL-resolution tests remain green.

- [x] **Step 3: Add bounded next-track reservation and preparation**

Start resolution within the existing `RESOLUTION_BUDGET_MS` lead plus the configured overlap. Recheck source epoch, queue identity, playback generation, and URL lease before passing the prepared track to the engine. Do not change outgoing gain until preparation is ready.

- [x] **Step 4: Add handoff, rollback, and user-operation cancellation**

Tests: `handoff commits on incoming playing only`, `mid-crossfade failure restores outgoing playback state`, `incoming audible history is not rolled back`, `seek before handoff cancels preparation`, `seek after handoff finishes transition`, `pause resume stop and manual selection cancel or preserve the correct operation`, and `late deck events cannot overwrite a newer selection`.

- [x] **Step 5: Verify queue modes and settings interactions**

Tests: list tail stops, repeat/random reuse the reservation, single-repeat and audition do not crossfade, duplicate identity is skipped, 0 ms disables automatic crossfade and finishes an active transition, disabling during preparation discards its reservation, and `shortAudioTransitions` still controls only short fades.

- [x] **Step 6: Run the offline suite and typechecks**

Run: `npm test`

Expected: all offline suites pass.

Run: `npm run typecheck`

Expected: both node and web typechecks pass.

### Task 6: Verify the Shipped Audio Graph and Record Acceptance

**Files:**
- Create: `tools/probe/crossfade-lifecycle.mjs`
- Create: `tools/probe/crossfade-lifecycle-main.cjs`
- Create: `tools/probe/crossfade-lifecycle-bundle.ts`
- Modify: `tools/build-test.mjs` (browser IIFE bundle of production player + audio engine)
- Create: `docs/development/2026-10-26-crossfade.md`
- Modify: `docs/superpowers/specs/2026-10-26-crossfade-design.md` (mark implementation status and link evidence after acceptance)

**Interfaces:**
- The probe uses the production test bundle, generated local audio fixtures, an isolated Electron profile, and zero external requests. It must assert actual simultaneous deck playback and release, not just controller math.

- [x] **Step 1: Add the isolated native Electron probe**

Cases: overlap start and completion, disabled setting, next-deck decode failure with outgoing restore, manual skip during overlap, seek after handoff, playback-rate wall-time and mid-fade retiming, and teardown with no active media requests.

- [x] **Step 2: Run the native probe and inspect its evidence**

Run: `node tools/probe/crossfade-lifecycle.mjs`

Expected: all cases pass under Electron with `blockedExternalRequests=0` and no leftover generated profile.

- [x] **Step 3: Run complete offline validation**

Run: `npm run verify`

Expected: node/web typechecks, production build, all offline test suites, and built-in gates pass.

- [x] **Step 4: Record evidence and scope boundaries**

Record commands, case counts, Electron version, and probe run id in `docs/development/2026-10-26-crossfade.md`. State that live sources, installation, and human listening remain separate acceptance. Do not commit or publish.

---

## Plan Self-Review

- Spec coverage: preference migration is Task 4; queue modes, preparation, URL lease, handoff, rollback, pause/seek/manual operations, and history are Task 5; dual-deck graph and cleanup are Tasks 2–3; synthetic acceptance and evidence are Task 6.
- Review Focus: all five risks above have a named regression test in the task that owns the behavior.
- Type consistency: Tasks 1 and 3 use the same `PreparedAudioTrack` and `CrossfadeOperation` contract; Task 5 owns the queue reservation and consumes the Task 3 engine token.
- Validation: `npm test` uses `tools/run-tests.mjs`, which bundles production engine modules with `tools/build-test.mjs`; final `npm run verify` adds production build and built-in gates.
- Dirty worktree: implementation and verification ran on isolated worktree `codex/crossfade-reliability` at `C:\Users\50138\.codex\visualizations\2026\10\15\01a13e60-2e94-7fe2-bcb9-3c5ac39a2fc8\jj-music-crossfade`. The original checkout and its pre-existing playlist and OR8 work were preserved; this branch was not committed or pushed.
