# Playback identity follow-up Implementation Plan
> Execute inline using executing-plans and TDD; one fresh final reviewer; no commit/push.
Goal: preserve the approved local/platform+track identity when restored tracks share a raw ID.
Spec: ../specs/2026-10-24-playlist-restore-design.md (preserve independent track identities).
Architecture: reuse playlistEntryKey only in confirmed in-memory selection/random/history paths, keep generation guards and wire/native IDs unchanged.
Tech: Vue Pinia production store, Node bundled tests.
- [x] RED: append three production player-regression cases: playTrack targets existing full identity; random two same-ID entries both play and previous returns correct one; history preserves local vs online same-ID lists. Run focused tests, observe behavior assertions fail.
- [x] GREEN: use complete identity for playTrack lookup; random pool/history/mapping/draws; collision-free JSON queue signature. Run all player regression tests and typecheck.
- [x] Verify: npm run verify, one final read-only reviewer, fix meaningful issues; document boundaries and refresh index.
Ledger: preserve dirty branch. This is correctness follow-up of the approved restore identity rule, not a new feature or full asynchronous player rewrite. Existing pending source/live listening remain separate.

Ruling: initial random two-item/fixed-high-random test could pass sequential fallback. Strengthen to four identities and Math.random=0 with first-next index2. Reviewer found missed pool conversion (CRLF anchor mismatch); observe RED1vs2, fix explicit lines, GREEN77/77 and review accepted. Keep URL/native IDs and asynchronous guards unchanged.

Final verification: npm run verify exit0, 107/107 suites, 5/5 gate; production player77/77; read-only final review accepted, no Git delivery.

- [x] GraphFlow retry succeeded: 6 files, 55 symbols, 2 references indexed; no pending transport follow-up for this batch.
