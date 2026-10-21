# Released reliability follow-up acceptance

User authorized the five remaining items in order. Listening stays deferred.

Constraints: preserve published tags/assets, daily profiles and original scripts. Install/update only on disposable GitHub-hosted Windows. Use production UI/preload/main paths and official published binaries; report controlled faults separately from actual upstream failures. No global config or signing-gate changes. Serialize shared out builds. Follow-up branch: codex/online-reliability-followup.

- [x] Fetch and verify zero main divergence; fast-forward and push main to6093c75.
- [x] Implement and run real application updater acceptance against official0.4.2→0.4.5 on disposable CI. CI39619505135 passed16 checks including actual installer/restart and synthetic data preservation; previous failed evidence retained.
- [x] Extend existing real UI probe to QQ, exercise preview/cancel/confirm apply with one seeded local difference.
- [x] Inspect admitted originals, bound update checks to at most8 unique declared URLs; preserve bytes and record unavailable candidates. Actual apply/rollback is externally blocked: both explicit endpoints returned notAScript, so no candidate transaction ran.
- [x] Exercise isolated controlled failure-cache feedback and rapid/binding interactions, retaining real-vs-controlled distinction.
- [x] Review complete delta, run relevant verification, update OR8 evidence and prepare final commit/fast-forward integration. Keep manual listening and genuine external blockers explicit; final Git integration is verified separately after this commit.

2026-10-21: Merge completed without conflicts or history rewriting. Current main and origin/main6093c75. Existing published artifact CI39550013388 remains valid; follow-up acceptance will not republish0.4.5 or reuse synthetic signatures.

2026-10-21: QQ actual UI10/10 and originalwy22/22 flows completed; controlled production interactions14passed,503cached data preserved,provider binding/rapid DOM controls passed,normal exit/profile removed. Source inventory21 preserved,2explicitURL notAScript,0candidate,transaction still externally blocked. Fresh review found probe startup auto-check race; bounded status wait added and independently approved,zero-install checks passed. Original OR8-followup.md was preserved byte-for-byte; new record is OR8-post-release-acceptance.md. Awaiting actual disposable updater CI.

Updater iterations: Node executable selection fixed; explicit current-user choice retained; baseline directory normalized to Installed/JJ Music. Run39614397601 reached Installation Complete/Finish, but restart CDP remained unavailable, so continuity is still unverified. NSIS shell launch may discard process-only debug opt-ins: the guarded fixture now temporarily sets the two previously absent debug User variables only in the disposable runner, restores and broadcasts on exit, and records exact-path owned processes. Independent review, native helper compilation, syntax, daily-host refusal and diff checks passed. Run39616546568 is queued pending an available Windows runner. No daily host/global Codex settings, published assets, runtime code or production debug gates changed.

Final update: runs39616546568 and39618073821 proved0.4.5 automatic process restart but no old-port listener. Separate old/restart ports were independently reviewed. Run39619505135 on e031be954be813b7f6ea190a7cb6393e2f471e35 passed all16 real API checks; target version0.4.5.0, created playlist/theme/volume/pending lyric/location preserved, screenshot inspected, normal close and no owned process/listener remaining. Artifact12353273379 digest9320fda708c25a5caa011dc2b0a7a15a10a4b7b789596fe1f62c96f96c5e92b7 verified. Source transaction remains externally blocked; listening deferred. Earlier queued/failure statements above are historical snapshots.
