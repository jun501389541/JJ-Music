# 歌单管理后续 Implementation Plan

> Use executing-plans inline, TDD and one fresh final reviewer; no commit/merge/push. User chose all three directions. Spec: ../specs/2026-10-24-playlist-management-design.md

Goal: ship saved-list filter, online-search controls and confirmed bounded batch relocation.
Architecture: Vue computed filter; existing Pinia request generations; separate main batch scanner/opaque map and retained RelinkCandidates, reuse existing relinkApply transaction.
Tech: TypeScript, Vue/Pinia, Node fs, Electron production bundle tests.

## Tasks
- [x] Saved filter: create renderer/utils/playlist-filter.ts production entry and tests, then PlaylistsView input/count/clear/session state. Verify order and IDs unchanged.
- [x] Search controls: extend playlist-search store tests for cancel/clear/refresh failure, then implement store actions and panel draft/count/buttons. Extend production probe.
- [x] Batch backend: shared batch types; main/library/batch-file-relink.ts scanner and opaque mapping with expiry/cancel/root checks; RelinkCandidates supports retained bounded previews while default remains one. New scan/preview/discard IPC; existing apply/discard handles retained owner. RED/GREEN generated filesystem tests, strict IPC injection rejection.
- [x] Batch UI: selected local references on UiStore; track-actions route entry; LocalRelinkBatchView mapping/preview/confirm/apply sequential/stop/progress/token cleanup; route. Reuse player begin/finish and library.acceptLocalRelink, drain settings, no automatic play.
- [x] Final code acceptance: production Electron fixtures for all three, full npm run verify, one fresh read-only review/fixes, README/product/development records.
- [x] GraphFlow supported TS/Markdown index resumed on subsequent search-state turn; 12 TS receipts and final MD indexing.

## Review focus
Symlink/root escape, exact existing local identity, old file recovered/candidate changed, duplicate target, >limits and partial scan, token expiry/lifecycle, partial commit with next failure, refresh cancelled late response, navigation away during async work.

## Ledger
Ruling: remain codex/platform-charts because prior uncommitted F1/F2 are dependencies; preserve .graphflow.
Ruling: implement all three chosen directions without asking the same scope decision again; routine matching/capacity choices are conservative proposals documented in the spec.
Ruling: batch means one candidate mapping review and confirmation followed by existing per-file durable transactions; no all-or-nothing multi-file journal redesign. UI reports partial completion and stops at first failure.
Pre-flight: filter consumes library.orderedPlaylists (no mutation); search controls consume current per-platform state; batch consumes LocalRelinkPreview plus existing relinkApply result/settings. New retained preview registry must remain separate from manual preview so views cannot invalidate each other.

Tasks 1-4: complete — local filter and controls RED/GREEN; batch scanner4 tests, retained preview isolation, strict IPC and real generated WAV confirm path through existing transaction. No changes to music files or user data formats.
Review: one fresh read-only reviewer found stale first-page fallback dropping appended rows and maintenance overlay blocking stop. Both observed RED in production tests/UI and fixed; reviewer checked fixes. IPC malformed UUID case also RED/GREEN.
Verification: final npm run verify exit0, 103/103 and5/5; new production UI22 checks and existing manual relink UI21 pass, screenshots inspected, isolated profiles removed. Failed102/103 and early UI failures retained as diagnostics, not claimed pass.
Ruling: production UI uses owned generated WAV and deterministic native picker; test-only delayed actual atomic rename permits real pointer stop hit-testing. Wait for Vue route transitions before interacting with returned saved-list screen.
Pending graph paths: src/shared/batch-file-relink.ts, src/shared/ipc.ts, src/main/library/batch-file-relink.ts, src/main/library/local-file-relink.ts, src/main/index.ts, src/main/ipc-validation.ts, src/preload/index.ts, src/renderer/src/stores/ui.ts, src/renderer/src/stores/playlist-search.ts, src/renderer/src/utils/playlist-filter.ts, src/renderer/src/utils/track-actions.ts, src/renderer/src/router/index.ts; this spec/plan/development, PRODUCT_RULES, README. No global repair attempted.

## Follow-up 2026-10-24
- [x] RED/GREEN: zero eligible refs skip traversal; unrelated duplicate filenames do not signal candidate truncation; only needed names retained.
- [x] RED/GREEN: preview/application failures identify exact old path, while cancellation/late previews release only owned tokens.
- [x] Full verify, production UI failed-item context, one final read-only review, update records.
- [x] GraphFlow follow-up index: service recovered on search-state follow-up; supported files rechecked.
Ruling: this is correctness/performance follow-up within the approved batch-relink scope, not a new matching algorithm or product phase. Keep existing limits, explicit manual choice and transaction behavior.

Ruling: existing default tests unexpectedly read the fixed personal music folder (metadata only; writes on copies). Replace default sample source with owned generated WAV+ID3 fixture to honor offline isolation. Preserve real MP3/FLAC checks as explicit sample opt-in; do not claim generated WAV proves them. Invalid --music-dir exits2 before build or cleanup, with targeted RED/GREEN guard proof.
Follow-up complete: BatchRelink8 tests pass; independent reviewer checked committed-vs-renderer-sync distinction. Full104/104+5/5 and productionUI27 pass. Final explicit-arg stat check validated by focused test after full run; no redundant full run claimed. See development/2026-10-24-playlist-management-followup.md for receipts and historical metadata-read correction.
## Search-state follow-up 2026-10-24
- [x] RED/GREEN: platform explicitly cleared remains empty on return; only first visit inherits the previous draft.
- [x] RED/GREEN: successful first-page refresh/retry resets state and DOM scroll; failed refresh keeps rows and offset.
- [x] Production UI30, full offline104/104+5/5, final read-only review and records/index.
Ruling: these are state-consistency fixes in the existing approved search controls; no new product scope or personal-data access.

Search-state follow-up complete: store7 tests GREEN; old production UI reproduced cleared draft; final UI30 and full104/104+5/5 pass. One fresh read-only reviewer found no new Important/Critical. Supported TS indexed12; final Markdown incrementally indexed; no commit/push.
