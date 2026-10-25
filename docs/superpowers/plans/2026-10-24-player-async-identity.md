# Async playback identity follow-up Implementation Plan
> Execute inline with executing-plans and TDD; one final fresh reviewer. Preserve prior uncommitted work, no Git delivery.
Spec: ../specs/2026-10-24-playlist-restore-design.md complete independent track identity.
Goal: fix only reproduced media/source retry and lyric/art provenance collisions after restore.
Architecture: playlistEntryKey for equality/queue lookups in confirmed paths; keep native IDs over IPC, generation cancellation and retry budgets intact.
- [x] RED production player tests: media expiry must retry the online row; source URL failure must retry same online row; enrichment must write art/assets to that platform only; manual lyric source must not follow another platform sharing raw ID.
- [x] GREEN targeted complete-key queue lookups and lyric-choice ownership; full player suite + typecheck.
- [x] Verify full production offline suites, final read-only reviewer, documentation/index.
Ledger: follow-up correctness under existing approved restore identity rule; not a new protocol or asynchronous engine redesign.

Evidence: four production behavior failures observed before implementation, then81/81 passing. Source-failure fixture uses128k to isolate retry from quality fallback; assertions retained. Existing no-picUrl online rows now accept canonical cover update; native IDs and budgets unchanged.

Final acceptance: player81/81; verify exit0,107/107 suites+5/5 gate; independent read-only review no P1/P2; diff check passed. No Git delivery.

- [x] Service recovered on next continuation, incremental index succeeded; prior Transport closed is historical.
