# Releases and updates

Repository: <https://github.com/prapawity/GITVerse-by-PRAPAWITY>.

## Current distribution model

The Tauri release workflow builds DMG installers for macOS (arm64 and x64), an NSIS installer for Windows x64, and an AppImage for Linux x64. `npm run release:tauri` builds for the current host.

The release workflow builds each target on its native OS/architecture, signs update bundles, then creates a **draft** GitHub Release after all jobs succeed. Nothing is published automatically.

Packaging generates `THIRD_PARTY_NOTICES.txt` from the installed packages on each build machine and includes it in the application resources. It includes build dependencies conservatively, because their code may be bundled. Review every missing license text flagged in that file against the corresponding upstream package and check the final application for Electron/Chromium notices and any separately bundled binaries before distribution. The generated inventory is a starting point, not a license clearance.

Updater signatures use the Tauri signing key described in [updater.md](docs/rust-migration/updater.md). Apple Developer ID signing, notarization and Windows code signing are not configured; unsigned installers can trigger OS warnings. Never put signing secrets in source.

Local Electron macOS builds use an ad-hoc signature, not a Developer ID signature or notarization. Verify a test bundle with `codesign --verify --deep --strict --verbose=2 "path/to/GITVerse by PRAPAWITY.app"` and launch that packaged app before handing it off. Its `CFBundleName` must match the packaged helper prefix; keeping the old bundle name after renaming helpers causes Electron to exit with `Unable to find helper app`. Development bundles retain their executable/helper name while `CFBundleDisplayName` provides the public branding.

## Before the first public push

1. Inspect the files being added. Never include API keys, tokens, private keys, local app state, screenshots with private data, or existing `release/` artifacts.
2. Review licenses for dependencies, bundled assets, and shared skills.
3. Enable private vulnerability reporting in GitHub repository settings.
4. Enable GitHub Actions and allow the release job's `contents: write` permission.
5. Add a dedicated app icon and actual UI screenshots when available.
6. Review `npm audit` results and update/test affected dependencies before public distribution. A successful build does not mean the dependency audit is clean; rerun the audit even if the current lockfile previously passed.

No repository initialization, remote changes, tags, or pushes are performed by the setup files themselves.

## Publish a stable release

1. Test the Git workflows on disposable repositories. Run `npm ci`, `npm run lint`, `npm run format:check`, `npm test`, `npm run test:electron`, and `npm run security:audit`. Resolve high/critical advisories before publishing.
2. Bump `package.json`, `package-lock.json`, `src-tauri/tauri.conf.json` and `src-tauri/Cargo.toml` to the same version, then update `src-tauri/Cargo.lock`.
3. Stabilize on `release/<version>` branched from `develop`. Merge the reviewed release into `main`, tag that production merge with the matching version (for example `v0.1.1`), then merge the release back into `develop`. Push the branches and tag. The workflow rejects mismatched tags and prerelease versions.
4. Wait for the macOS, Windows, and Linux release builds to finish. The release requires signed updater bundles for all four supported platform/architecture combinations.
5. Download the draft assets and smoke-test each on a clean supported machine: launch, open/clone a repository, check Git availability, terminal behavior, and an update check.
6. Verify that the draft contains all installers and the signed updater feed.
7. Review generated release notes, document known limitations and unsigned status, then publish the draft.

GitHub's latest-release API only sees published releases. Do not mark the release as a prerelease if it should be offered to installed users.

## Automatic updates

The public application name is **GITVerse by PRAPAWITY** and the repository is `prapawity/GITVerse-by-PRAPAWITY`. New Electron artifacts use the `GITVerse-by-PRAPAWITY-` prefix; signed Tauri updater artifacts use `GITVerse-by-PRAPAWITY_`. Existing published Electron installers keep their original names and remain supported by the downloader. Application identifiers, the Electron runtime name (`app.setName`), data directories, storage keys, and legacy Keychain migration service names stay unchanged. The packaged macOS bundle name follows the public product/helper name so native startup can find its helper apps.

Older installed builds that reject GitHub redirects may no longer complete update checks after the repository rename. Install the new build manually from the renamed repository's Releases page in that case.

- A Tauri release app checks the signed updater feed during the animated launch screen. Settings > Application / About supports manual checks. Development builds disable update controls.
- Semantic versions are compared, ignoring draft/prerelease releases and build metadata.
- Requests have a timeout; failures are visible and do not prevent app use. GitHub API limits can affect unauthenticated checks.
- A newer release triggers a confirmation dialog with download progress. **Update** downloads and verifies the signed bundle, installs it and restarts the app.
- Publish the generated draft release for the updater feed to become available to installed apps.
- Users of an existing Electron release must install the Tauri build manually once; the Electron updater cannot switch runtimes automatically.
- The release picker remains for manually downloading other stable versions; automatic updates only install the latest stable release. Linux updates support AppImage installations.
- All available updates are optional; launch failures offer Retry/Continue. Mandatory minimum-version blocking requires a separately defined, authoritative version-policy API and is not implemented in this optional-update iteration.

See [updater.md](docs/rust-migration/updater.md) for signing and feed details.
