# Playlist copy and merge Implementation Plan

> Execute inline with superpowers:executing-plans and test-driven-development; fresh final reviewer. No commit/push.

**Goal:** Preview and atomically create copies or a merged ordinary playlist, preserving originals.
**Architecture:** Store derives a bounded consistent snapshot and commits new candidates with source revision CAS. An independent main service owns a single expiring candidate; a management panel sends only IDs/mode/name/token through strict IPC.
**Tech Stack:** TS, Vue, Pinia, atomic JSON, production-bundled Node tests and owned Electron.
**Spec:** ../specs/2026-10-25-playlist-copy-merge-design.md — user approved all behavior 2026-10-25.

## Global constraints

Ordinary playlists only. Copy 1–1000 lists; merge2–1000. At most50000 input rows before dedup and20MiB input/output snapshots, no truncation. Copy suffix（副本）,4096name limit; merged trim1–128name. First identity wins; local/online/platform separation. 10min single token, source revisions checked inside one durable mutation. No music/network/queue changes. Preserve QQ and previous work. Existing sandbox worktree refusal fallback applies;112/112 baseline passed.

## Review focus

1. Copy preserves order and origin; merge follows renderer-declared visible order and retains first metadata.
2. Input limits checked before whole-batch cloning; generated candidates and result metadata bounded.
3. Late preview/cancel/discard and duplicate apply never revive or reuse token.
4. Selected source changes reject all; unrelated changes survive; write failure rolls back batch and queued edits remain.
5. Main trusts no renderer tracks/paths; maintenance/relocation/quit block new work; committed-but-refresh-failed UI does not retry a save.

## Task1: production backend

Create src/shared/playlist-derive.ts; src/main/library/playlist-derive.ts; src/test/playlist-derive.test.mts. Modify settings-store.ts and tools/build-test.mjs.
- [x] RED methods absent on production Store: copy, merge mixed identities, source change, atomic fail/reload and bounds.
- [x] Add Store.deriveSnapshot(ids) and createDerived(sources,candidates,assertReady), snapshot/CAS under existing queue, one persisted mutation.
- [x] Add PlaylistDerive preview/apply/discard/clear, own generation and10min lease; construct data in main.
- [x] GREEN production suites for lease, concurrency, caps/bytes, malformed rows and strict arguments.

## Task2: IPC and UI

Modify main/index.ts, ipc-validation.ts, shared/ipc.ts and preload/index.ts; create components/PlaylistDerivePanel.vue and integrate PlaylistsView.vue.
- [x] RED strict IPC malformed/extra tracks/paths; then wire preview(mode,ids,name), apply(token), discard(token), and existing request-ID cancellation.
- [x] Use UUID candidates, maintain gate at preview/actual commit. Clear on quit; flag relocation and flush queued playlist writes before copy.
- [x] Add copy/merge buttons to existing ordinary-list selection; panel presents counts and ordering/name, explicit preview/confirm/cancel; invalidate on source selection/filter/mode/leave; committed result refresh failures explicit.
- [x] Typechecks and targeted regression.

## Task3: acceptance

Create tools/probe/playlist-copy-merge.mjs; update rules/readme/development.
- [x] Production Electron generated data/profile: copy, mixed merge/dedup/order/metadata, cancel/stale/token/applyfail/refreshfail/selection/route behavior and source/queue/audio preservation. Cleanup and screenshot.
- [x] npm run verify, fresh final review, meaningful fixes with tests; record limits and graph indexing. No commit/push/version changes.

## Ledger

User approved both new-list approach and complete design. Scope changes require recording. Existing worktree creation sandbox ref-lock denial permits current-checkout fallback; keep all uncommitted files.
Ruling: Preview cancellation reuses cancellableMusic/cancellableRequest per-request AbortSignal; no global renderer cancelPreview channel, avoiding cancellation of a newer owner.
Completed: backend11/11 + IPC1/1, production UI26/26, fullverify114/114 and5/5; screenshot inspected; final independent reviewer no P1/P2. No commit/push/version change.
