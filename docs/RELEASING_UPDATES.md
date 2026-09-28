# Signed Windows update releases

The application currently ships no update public key and keeps installation disabled in default builds. U0's isolated Windows data-safety matrix passed for candidate Setup SHA-256 `4E35B04C18EECA5B74BB1DB03A5B8FCD6623E8EA5B8DF2B0852BF339702790FF`; U4's two-version update and release acceptance remains open. The tag workflow has a separate `JJ_UPDATE_U0_APPROVED=true` gate in the protected `signed-release` GitHub Environment. The workflow only creates a **draft** Release. Publishing it remains a deliberate release-review step after every asset is checked.

The U1–U3 code was implemented ahead of U0 by request. The verified U0 candidate creates the `nsis-install.marker`, migrates verified per-user profiles before uninstall, and rejects ambiguous per-machine profiles before elevation or uninstall. The latter require account-specific backup and recovery as described below. Setting the Environment variable alone does not make the updater available. The default local build embeds an empty public key and a closed U0 switch.

## Signing setup

Choose a custodian for one Ed25519 private key. Generate it offline, back it up securely, and set the entire PEM as the protected Environment secret `JJ_UPDATE_SIGNING_KEY_PEM`. Put the matching SPKI PEM in protected Environment variable `JJ_UPDATE_PUBLIC_KEY_PEM`. Never commit the private key. The protected Environment should require a reviewer and allow only version tags. The same public key must be embedded into the application build; a build with no key reports updates unavailable.

Before enabling this Environment, review the verified U0 matrix in [online-update-u0-verification.md](research/online-update-u0-verification.md) against the exact Setup artifact to be released. It covers per-user, per-machine, custom writable and relocated profiles, including library, settings, playlists and sources. The current local build keeps `JJ_UPDATE_U0_APPROVED` unset; enabling the protected Environment and completing U4 remain separate release decisions.

## Draft workflow

Push a stable `vX.Y.Z` tag matching `package.json`. The Windows workflow runs `npm run verify`, builds NSIS and ZIP, generates `latest.yml`, signs a fixed JSON manifest over the Setup's name, length, SHA-256 and SHA-512, and checks the six release assets. It then uploads exactly those files to a draft GitHub Release and checks the uploaded names. `latest.yml` is transfer metadata; the Ed25519 signature and installer hashes are the app's authorization checks. Ordinary PR CI keeps `contents: read` and has no signing secret.

The tag workflow's first job verifies with read-only repository permission and no signing key. The protected draft job receives the private key only for the signing step; the build and dependency installation steps do not receive it. For a local integration check, run `node tools/probe/smoke-update-release.mjs release X.Y.Z` after `npm run dist`. It uses a throwaway key against the real assets, verifies them, then removes the throwaway manifest and signature. Those files must never be published.

Inspect the draft's version, installer, ZIP, checksums, metadata, manifest and signature before making it public. A first-time 0.2.0 user must manually install the first update-capable release. Portable ZIP users continue to download and replace the ZIP manually.

## Failure and recovery

An old per-machine installation may contain `data/` or `data-location.json` inside `Program Files`. The candidate installer stops before uninstalling it because an elevated installer cannot determine which Windows account owns that profile. Exit JJ Music and make a verified copy of those entries outside the installation directory. Review each account's library, settings, playlists and sources, then restore the profile only into that account's `%APPDATA%\jj-music` (or restore its external directory pointer under `%APPDATA%\.jj-music-data-location.json`). Do not overwrite a different existing profile. Use `tools/probe/upgrade-data.mjs` to compare the source and restored directories while the app is closed. Only after the correct accounts have verified their restored data should the original entries be **moved** out of the installation directory into the verified backup; then rerun Setup and check each account again. Keep the backup until all accounts have opened the new version successfully. If ownership is unclear, leave the old installation intact and resolve the account mapping before retrying.

If signing, checksum or metadata checks fail, the workflow stops before creating the draft. If uploading fails, leave the draft unpublished and inspect its asset list; never publish an incomplete set. If the signing key is lost or compromised, stop publishing updates, distribute a new manually installed version with a rotated public key, and revoke the old protected Environment secret. An unsigned NSIS executable can still trigger Windows SmartScreen despite the Ed25519 manifest signature.
