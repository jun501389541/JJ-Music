# JSON Playlist Restore Implementation Plan
> Execute inline via executing-plans; one fresh final reviewer. No commit/push.
Goal: implement the approved restore-as-new workflow.
Architecture: validated backup parser -> bounded main-process lease -> queued atomic PlaylistStore batch -> strict IPC -> management preview panel.
Tech: Electron, TypeScript, Vue, production esbuild offline suites.
Spec: ../specs/2026-10-24-playlist-restore-design.md

## Global constraints
20MiB /1000 lists/50000 tracks, v1 only; original local/online identities and track order; new list UUIDs; existing lists, favorites and playback untouched. No real source/personal music reads.

## Tasks
- [x] 1 RED/GREEN src/main/library/playlist-restore.ts + src/shared/playlist-backup.ts: parsePlaylistBackup(bytes), readPlaylistBackup(path) bounded handle read, kind/version/date/scope/count/duplicate/shape checks and serializer whitelist. Tests src/test/playlist-restore.test.mts production build entry.
- [x] 2 RED/GREEN PlaylistRestore preview service single lease (10 minute TTL), native picker cancellation, immutable authoritative snapshot; concurrent preview generation, token-only consume/discard. PlaylistStore.restoreBackup accepts validated snapshots, single mutate/save/rollback, new IDs and suffixed names. IPC three channels choose/apply/discard; no renderer paths.
- [x] 3 management UI component with preview summaries, confirm all as new, busy/cancel/leave cleanup, committed-vs-refresh-failed feedback. Keep current queue and system lists untouched.
- [x] 4 npm run verify, isolated production Electron restore probe, final read-only fresh review and corrections, README/rules/development/index.

## Review focus
Crafted JSON local/online discriminator mismatch, native IDs and hidden extras; byte limit TOCTOU; repeated/expired leases and stale file picker result; successful disk save vs UI refresh failure; all-or-nothing queue concurrency.

## Ledger
Ruling: keep current dirty codex/platform-charts because this work extends its uncommitted export format. Preserve earlier work, no Git delivery.
Preflight: parser consumes export v1 and returns PlaylistBackupSnapshot[]; main service owns snapshots, IPC only carries summaries/tokens; Store uses same existing mutation queue. UI only uses saved result counts and refreshes list.

Ruling: 4096-char valid source names must stay exportable. Observed RED when unconditional suffix exceeds export validation; retain original name only if suffix would exceed 4096, keep new UUID and preview explanation. No truncation.

Ruling: reviewer reproduced raw-ID reorder/remove data loss after valid restore. Expand affected edit/copy/favorite and queue-menu chains to complete identity keys. RED/GREEN: restore10/10, player74/74. Old ambiguous edit protocol rejects; new mode is strict boolean.
Final acceptance: verify exit0, 107/107 +5/5 gates; production UI27/27, zero renderer errors, owned profile removed; review follow-ups accepted. UI waits for refreshed DOM/menu, product assertions unchanged. No Git delivery.

- [x] Service follow-up: next continuation incremental index succeeded; prior Transport closed remains historical.
