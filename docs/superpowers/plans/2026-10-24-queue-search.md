# Queue Search Implementation Plan
> Inline executing-plans, TDD, one fresh final read-only reviewer; no Git delivery.
Spec: ../specs/2026-10-24-queue-search-design.md
Goal: search displayed queue page without changing full playback, order or history boundaries.
Architecture: PlaybackPanel reuses production filterPlaylistTracks/playlistTrackIndex; no new backend/state format.
- [x] RED: production Electron probe seeded with generated WAV/metadata; open queue and assert search exists, observe missing-input failure.
- [x] Implement filter input/count/empty state, complete original-index play mapping, nextTick reveal after clear, query/page/open scroll reset, filtered reorder guard and history remove prohibition.
- [x] GREEN production UI: normalization, original index/full queue, filter remove/clear/drag, locate, Esc, history readonly/play/reset; typecheck and npm run verify.
- [x] One final reviewer, fix meaningful findings, README/product/development records and GraphFlow.
Ledger: current dirty branch required by previous unreleased features. Reuse existing pure filter tests instead of duplicating implementation-mirroring tests; functional RED/GREEN gate is the production DOM probe.

Evidence: production UI missing input RED before implementation, then21/21 GREEN with zero renderer errors and owned profile cleanup. Reuse existing production filter/index helpers; nextTick locate follows post-flush reset.

Final acceptance: productionUI21/21 zero renderer errors; verify exit0,107/107 suites+5/5 gates; fresh final read-only review no P1/P2. No Git delivery.

- [x] Next continuation incremental index succeeded; prior transport failures are historical.
