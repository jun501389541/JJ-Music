# Bulk Playlists and Missing References Implementation Plan
> Inline executing-plans/TDD; one fresh final read-only reviewer; no Git delivery.
Spec: ../specs/2026-10-24-playlist-bulk-missing-design.md
Goal: two approved independent improvements, both completed in this batch.
Architecture A: PlaylistStore.removeMany one mutation + strict ID-only IPC + PlaylistsView selection and committed-state feedback.
Architecture B: stored minimal local reference snapshot -> bounded stat-only MissingFiles service -> cancellable ID-only IPC -> dedicated view -> existing 50-item relink flow.
Global limits: deletion1000 unique ordinary IDs; missing50000 unique refs,8 workers,500 displayed problems,30s total deadline; unknown access distinct from confirmed missing.
- [x] A RED/GREEN production store tests batch protection, atomic rollback and queued writes. Add strict IPC. UI mode/filter/selectall/confirm/protected cards, cleanup order settings and refresh failure reporting.
- [x] B RED/GREEN production scanner tests local ID+path de-dup/origins, online exclusion, present/missing/unknown/root offline, concurrency8, cap/row truncation, cancel/deadline. Store minimal queued local refs bounded before returning.
- [x] B IPC/view with manual start/cancel/epoch, counts/uncertain/incomplete, max50 missing selection and old relink navigation.
- [x] Whole verify + isolated production UI for both features, final review, docs/README/rules and index.
Ledger: preserve dirty workspace dependencies. GraphFlow plan attempted twice; second returned automatic review stream-disconnect failure (explicitly not unsafe). Continue separately authorized local files/tests; graph mutation not bypassed, leave sync pending. User approved both concrete features.

Ruling: source snapshots capped at50000 minimal local rows per source and scanner50000 distinct refs; capacity flags always report incomplete. Same ID/different old paths are selected separately due existing relink ID contract.
Ruling: reproduce unplug-after-root success RED then fresh root check GREEN; native-checkbox rejection RED then event synchronization GREEN; cancelled OS stats doubling RED then shared pool GREEN. Final read-only reviewer accepted all corrections.
Evidence: bulk3/3, missing8/8, strict IPC and typecheck; production UI25/25, no renderer errors, owned profile removed; no Git delivery.

Final verify exit0:109/109 suites+5/5 gate; UI25/25. Planning-tool retry during closeout again returned automatic-review stream disconnect (not unsafe verdict); repository work completed through approved local plan.

Index closeout succeeded:5 files/152 symbols/71 references; graph plan write remains unavailable due approval-stream disconnect; local implementation and validation complete.
