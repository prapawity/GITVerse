# Releases and updates

Repository: <https://github.com/prapawity/GITVerse>.

## Current distribution model

`electron-builder.yml` defines DMG/ZIP for macOS (arm64 and x64), NSIS for Windows x64, and AppImage for Linux x64. `npm run dist` builds for the current host and puts artifacts in `release/`, which is ignored by Git.

The release workflow builds each target on its native OS/architecture. It uploads only installers and SHA-256 checksum files, then creates a **draft** GitHub Release after all jobs succeed. Nothing is published automatically.

Packaging generates `THIRD_PARTY_NOTICES.txt` from the installed packages on each build machine and includes it in the application resources. It includes build dependencies conservatively, because their code may be bundled. Review every missing license text flagged in that file against the corresponding upstream package and check the final application for Electron/Chromium notices and any separately bundled binaries before distribution. The generated inventory is a starting point, not a license clearance.

macOS signing uses the optional `MAC_CERTIFICATE_P12` and `MAC_CERTIFICATE_PASSWORD` GitHub Actions secrets. Without them the build remains unsigned and macOS automatic updates will not work. Notarization and Windows signing are not configured; never put signing secrets in source.

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
2. Bump `package.json` and `package-lock.json` together, for example `npm version patch --no-git-tag-version`.
3. Stabilize on `release/<version>` branched from `develop`. Merge the reviewed release into `main`, tag that production merge with the matching version (for example `v0.1.1`), then merge the release back into `develop`. Push the branches and tag. The workflow rejects mismatched tags and prerelease versions.
4. Wait for the macOS, Windows, and Linux release builds to finish. The macOS job builds both architectures so the updater metadata contains both.
5. Download the draft assets and smoke-test each on a clean supported machine: launch, open/clone a repository, check Git availability, terminal behavior, and an update check.
6. Verify downloaded artifacts against the accompanying SHA-256 files. Checksums detect corruption; they do not replace code signing or protect against a compromised release account.
7. Review generated release notes, document known limitations and unsigned status, then publish the draft.

GitHub's latest-release API only sees published releases. Do not mark the release as a prerelease if it should be offered to installed users.

## Automatic updates

- A packaged release app checks `https://api.github.com/repos/prapawity/GITVerse/releases/latest` during the animated launch screen and caches that startup result. Settings > Application / About and the Help menu support manual checks. Development/unpackaged builds disable update controls and skip all update-check requests.
- Semantic versions are compared, ignoring draft/prerelease releases and build metadata.
- Requests have a timeout; failures are visible and do not prevent app use. GitHub API limits can affect unauthenticated checks.
- A newer release triggers a confirmation dialog with download progress. On macOS, the app downloads the DMG for its architecture, verifies its SHA-256 against GitHub's release asset digest, and opens it for the user to install manually. Windows and Linux AppImage use electron-updater and offer **Restart and Install**.
- The release workflow uploads updater metadata and blockmaps along with installers. Publish the generated draft release for it to become available to installed apps.
- The existing 0.1.3 release predates the in-app download feature. Users must install a later updater-enabled build manually once. macOS does not require the Developer ID signing secrets for DMG downloads; unsigned apps may still prompt Gatekeeper warnings.
- The release picker remains for manually downloading other stable versions; automatic updates only install the latest stable release. Linux updates support AppImage installations.
- All available updates are optional; launch failures offer Retry/Continue. Mandatory minimum-version blocking requires a separately defined, authoritative version-policy API and is not implemented in this optional-update iteration.

See the [electron-builder documentation](https://www.electron.build/) for the chosen version's packaging, signing, publishing, and updater requirements.
