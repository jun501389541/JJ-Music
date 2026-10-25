# 歌单内查找和JSON备份 Implementation Plan

> Use executing-plans inline, TDD, one fresh final reviewer. No commit/merge/push/release.

Goal: implement user-selected both playlist track filtering and metadata JSON backup.
Architecture: pure renderer filter/index helpers, existing full queue; queued PlaylistStore.backupSnapshot; main playlist-backup serializer/service; strict IPC + native save picker + atomic write; two UI buttons.
Tech: TS, Vue/Pinia, Electron, production esbuild tests.
Spec: ../specs/2026-10-24-playlist-filter-backup-design.md

## Tasks
- [x] RED/GREEN filter helpers: create utils/playlist-track-filter.ts and tests/production entry; metadata multiword normalization, original ordering and local-vs-online identity index. Integrate PlaylistDetailView query/session/count/clear, filtered rows and full queue mapping, disable reorder when filtered and capture reorder list ID.
- [x] RED/GREEN backup contracts/module: shared/playlist-backup.ts capacity/types; main/library/playlist-backup.ts whitelist serialization (no URLs/opaque extras/assets), byte limits, default name, guarded native selected destination and atomic writer. Test cancel/failure/root/junction plus data untouched.
- [x] PlaylistStore.backupSnapshot(id?) queues one clone with count guards behind durable writes; test concurrent write/failure and all/single. Add strict playlist:export-json optional ID IPC/preload/main; no renderer paths.
- [x] UI export: details exports full list even filtered, management exports all even filtered; scope confirmation, counts/success/error/cancel/busy, native save confirmation.
- [x] Run npm run verify using generated fixtures; isolated production UI filtering/full queue index/delete/drag/export actual files/all/cancel/failed save. Final fresh read-only reviewer; fix meaningful findings RED/GREEN; README/PRODUCT_RULES/development records; GraphFlow refresh attempted twice (transport unavailable).

## Review focus
Filtered index vs original index, hidden-row deletion/order, same id across local/online; queued writes vs snapshot read; unknown/bad entries not silently lost; byte budget and no private runtime metadata; selected path cannot overwrite service data; confirmation/leave/repeat actions; atomic failure no partial file.

## Ledger
Ruling: stay current dirty codex/platform-charts since preceding features are dependencies. No git delivery authorized.
Ruling: preserve normal playlist queue semantics; local filtering changes display only. JSON is a versioned information backup, not audio/full-settings backup or restore feature. These choices are documented within the user-selected two features.
Pre-flight: filter consumes PlayableTrack and playlistEntryKey, backup consumes queued stored snapshots; no renderer-supplied data/path at export boundary. Two UIs use the same IPC while scopes remain explicit.

Ruling: final review found unchecked position object; reproduced RED then validated nonnegative safe integer, GREEN and reviewer accepted.
Ruling: existing source-owner-lifecycle failed twice only in scratch cleanup after host exit; directory subsequently absent. Add bounded test-only rm retry (10 x 100ms), preserve lifecycle assertions, no runtime/permission changes; focused 4/4 passed.
GraphFlow: incremental index attempted twice after changes, both Transport closed. Refresh remains pending; do not claim synchronized.

Acceptance: final npm run verify exit 0, 106/106 suites +5/5 gate; production UI17/17, zero renderer errors, owned profile removed. Fresh final reviewer and position-fix follow-up passed. Git diff --check passed. No commit/push.
- [x] Service follow-up: GraphFlow recovered; incremental index succeeded, nine supported TS files individually confirmed unchanged/current. Vector backfill is separately budgeted and not claimed complete.
