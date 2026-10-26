# QQ playlist search from LX reference Implementation Plan

> Execute inline with superpowers:executing-plans and test-driven-development; fresh final reviewer. No commit/push.

**Goal:** Complete the already approved F2 QQ public playlist search using the anonymous official contract verified from LX Music.
**Architecture:** Extend the existing PlaylistSearchAdapter and capability registry; remove QQ's static unavailable UI gate. Reuse current service/cache, preview/import and queue paths.
**Tech Stack:** TypeScript, Vue/Pinia, guardedFetch, production-bundled Node suites and owned Electron probe.
**Spec:** ../specs/2026-10-24-playlist-search-design.md (approved). User explicitly requested LX reference on 2026-10-25; no new product flow.

## Global Constraints

20 requested summaries/page; 10 pages and 200 displayed maximum; manual pagination only. Fixed HTTPS official search endpoint; 2MiB bound; existing cancellation, Retry-After, retries and memory cache. No login/Cookie, source scripts, signed song-search request implementation, version changes or publishing. Preserve existing uncommitted README, refresh coverage and records.

## Review Focus

- Sparse QQ pages may return15/17 of20; use declared total/page slots without silently fetching extra pages.
- Nonzero code/subcode, wrong pagination, missing/invalid total or rows must fail, not become zero matches.
- Preserve native decimal-string playlist IDs and numeric HTML entities as text, no evaluation.
- Admit only observed qpic.y.qq.com artwork host in addition to existing gtimg.cn; no qq.com wildcard.
- UI must reach actual adapter and existing preview/save; browsing must not save or play.

## Task1: source and live contract

- [x] Pin LX ad95d5091c9ed689fa72b5e5c849df65f5a679ce; inspect tx/songList.js search separately from signed tx/musicSearch.js.
- [x] At most3 search calls: HTTPS/HTTP comparison then HTTPS page2. HTTPS returned code0, page0:15, page1:17, perPage20, total56355.
- [x] One existing detail call: first native playlist7739249772, complete90/90. No profile/source/audio/image operations.

## Task2: backend and UI admission

Files: src/main/online/playlist-search.ts, platform-registry.ts, cover-fetch.ts; src/shared/playlist-search.ts; src/test/playlist-search-qq.test.mts and existing playlist-search.test.mts.
- [x] RED: native fields, exact URL/header/signal pins, sparse pagination/cap, empty vs schema/error, cancellation/429, artwork boundaries and Pinia/registry admission.
- [x] Implement official HTTPS legacy contract independently, decode numeric title/creator entities, validate QQ schema and page metadata. Keep original four platform behavior.
- [x] GREEN after tools/build-test.mjs production bundling. Remove obsolete unsupported-only assertion.

## Task3: integration and delivery

Files: tools/probe/playlist-search.mjs, README.md, docs/PRODUCT_RULES.md and docs/development/2026-10-25-qq-playlist-lx.md.
- [x] Update owned Electron HTTP fixture to expose QQ search pages and native detail/save, preserving four-platform and race checks.
- [x] Full npm run verify, owned Electron acceptance, inspect screenshot, check errors and cleanup.
- [x] Fresh final read-only review; address findings with targeted evidence; update records and incremental graph.

## Ledger

Ruling: Existing F2 design and current user request authorize this missing platform adapter; no new UI/product design approval needed.
Ruling: Sandbox denied Git worktree ref lock. Per using-git-worktrees fallback, continue current checkout; earlier111/111 baseline retained, no Git mutations or commits.
Ruling: HTTPS works with the full LX query/header combination; do not infer a single decisive parameter without an ablation experiment, and do not ship HTTP fallback.
Ruling: Reimplement field mapping from verified responses; do not run/import LX code or copy its six-attempt recursion/signature runtime. Reference source links remain in delivery record.
Task2 complete: QQ6 RED -> GREEN; existing adapter5 and cover18 pass.
Task3 complete: verify112/112 + gate5/5, owned UI36/36, raw-page production replay15/17, final review no P1/P2. No commits/push or release.
