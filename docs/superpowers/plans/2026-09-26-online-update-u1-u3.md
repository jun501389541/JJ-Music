# Windows Online Update U1–U3 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build and test the signed stable-release pipeline, main-process update service, and user controls while retaining a closed installation gate until U0 is verified.

**Execution status (2026-09-26):** Tasks 1–4 are implemented and `npm run verify` passes 37/37 suites. Task 5's local package checks pass with a throwaway signing key. U0's real Windows migration and installer identity, and U4's two-version upgrade run, remain open. The checkboxes below are the original implementation sequence; the verified outcome is recorded in `docs/research/online-update-u0-verification.md`.

**Architecture:** A release tool signs one strict JSON manifest with Ed25519. The main process verifies that manifest and cross-checks GitHub release metadata and `latest.yml` before allowing electron-updater to download; a second hash check gates installation. The preload exposes narrow commands and sanitized status to Vue. Packaging defaults to an unconfigured public key and thus an unavailable updater until a protected release environment supplies the matching key and U0 is complete.

**Tech Stack:** Electron 42, electron-builder/app-builder-lib 26.15.3, electron-updater 6.7.3, Node crypto, TypeScript, Vue 3, GitHub Actions.

**Spec:** `docs/research/online-update-requirements.md`; U0 evidence: `docs/research/online-update-u0-verification.md`.

## Global Constraints

- Windows x64 NSIS installer only; portable ZIP never calls Setup.
- Stable GitHub releases only from `jun501389541/JJ-Music`, with fixed asset names.
- No automatic download; no install on ordinary quit; no installation while U0 gate is closed.
- No signing private key or GitHub token in Git. Build failure or unavailable update is preferable to an unverified install.
- The first implementation uses complete NSIS downloads, not differential updates.
- The existing `npm run verify` and package probes remain passing.

## Review Focus

- A malicious or incomplete Release must not prompt for an installation.
- A replaced `latest.yml` must not redirect to a different version or asset.
- A file replaced after download must be rejected at install time.
- Tray mode, ordinary quit, and startup must never trigger install on their own.
- A ZIP copy or developer build must never invoke the installer.

---

### Task 1: Signed release contract and CLI

**Files:** Create `src/main/updates/manifest.ts`, `tools/release/update-manifest.mjs`, `src/test/update-manifest.test.mts`; modify `tools/build-test.mjs`.

**Interfaces:** Produces `parseAndVerifyManifest(bytes, signature, publicKey, currentVersion): VerifiedManifest` and `checkLatestMetadata(latestYaml, manifest): void`. The manifest contains `schemaVersion=1`, `tag`, `version`, `channel='stable'`, `platform='win32'`, `arch='x64'`, and setup `{name,size,sha256,sha512}`. The CLI writes exact UTF-8 bytes and detached base64 signature.

- [ ] Write tests with generated Ed25519 keys and literal malformed cases: invalid signature, wrong tag/version, downgrade, pre-release, wrong architecture/name/digest, and `latest.yml` mismatch.
- [ ] Run focused tests; verify failure from missing module.
- [ ] Implement strict validation and signature verification; use fixed filenames and lengths, compare SHA-512 in base64 format.
- [ ] Run focused tests and the full test suite. Record any data-format ruling.

### Task 2: Draft Release supply chain

**Files:** Create `.github/workflows/release.yml`, `tools/release/check-assets.mjs`, `docs/RELEASING_UPDATES.md`; modify `electron-builder.yml`, `tools/package.mjs`, `package.json`, `package-lock.json`.

**Interfaces:** Consumes Task 1's manifest format. Produces installer, ZIP, `latest.yml`, `SHA256SUMS.txt`, signed manifest, and detached signature in one draft Release. Only protected release job reads signing secret.

- [ ] Write local artifact-check tests with temporary files: missing, duplicate, mismatched and valid asset sets.
- [ ] Run focused tests to see the absent checker fail.
- [ ] Add `publish.github` metadata while retaining `--publish never` for local packaging. Add a tag-only Windows workflow with read-only verify job and protected draft-upload job; check tag and package version before upload. Signing key comes from a protected environment secret.
- [ ] Run checker tests and `npm run dist`; inspect real `latest.yml` and artifact set. Run `npm run verify`.

### Task 3: Main-process update service

**Files:** Create `src/main/updates/service.ts`, `src/main/updates/release-source.ts`, `src/main/updates/types.ts`, `src/test/update-service.test.mts`; modify `src/main/index.ts`, `tools/build-test.mjs`, `package.json`, `package-lock.json`.

**Interfaces:** Consumes Task 1's verified manifest. Produces `check()`, `download()`, `cancel()`, `install()`, `getState()`, and `onState()` methods. Public status contains version, notes, size, progress, error, release URL; no local file path or asset URL reaches renderer.

- [ ] Write tests against a fake updater at the trust boundary for no download without consent, mismatch refusal, cancelled/failed retry, hash mismatch, and closed U0 gate.
- [ ] Run focused tests; verify the intended failure.
- [ ] Add `electron-updater@6.7.3`, configure `autoDownload=false`, `autoInstallOnAppQuit=false`, and differential download disabled. Fetch only fixed official release assets; verify signature before updater check; rehash the downloaded installer and rehash before install. In developer and ZIP builds, report unavailable.
- [ ] Run focused and full tests. Build and inspect packaged integration.

### Task 4: Narrow IPC and Vue controls

**Files:** Modify `src/shared/ipc.ts`, `src/preload/index.ts`, `src/main/index.ts`, `src/renderer/src/views/SettingsView.vue`, `src/renderer/src/App.vue`; create `src/shared/update-types.ts`.

**Interfaces:** Consumes Task 3 methods. Produces only check, download, cancel, install, status IPC and a main-to-renderer state event.

- [ ] Write tests for state projection and main-window-only IPC access; verify unavailable/idle/available/downloading/ready/error states.
- [ ] Run focused tests; verify failure.
- [ ] Add settings → about controls and startup prompt using current UI patterns. Installation requires a separate user click. Provide retry and fixed official Release fallback.
- [ ] Run `npm run verify` and packaged manual UI check where possible.

### Task 5: Integration record and release gate

**Files:** Modify `docs/RELEASING_UPDATES.md`, `docs/research/online-update-u0-verification.md`; create `tools/probe/check-update-package.mjs` if needed.

**Interfaces:** Consumes Tasks 1–4. Produces build-time proof that default packages cannot install and a checklist for the later U0/U4 Windows run.

- [ ] Inspect generated installer/ZIP and manifest assets. Confirm the default public-key and U0 gates disable installation.
- [ ] Run `npm run verify`, local release checker, package probe, and `git diff --check`; record exact results.
- [ ] Keep U4 and U5 open until the two-version VM upgrade succeeds and the signing key is provisioned.
