# Releases and updates

Repository: <https://github.com/prapawity/GITVerse>.

## Current distribution model

`electron-builder.yml` defines DMG/ZIP for macOS (arm64 and x64), NSIS for Windows x64, and AppImage for Linux x64. `npm run dist` builds for the current host and puts artifacts in `release/`, which is ignored by Git.

The release workflow builds each target on its native OS/architecture. It uploads only installers and SHA-256 checksum files, then creates a **draft** GitHub Release after all jobs succeed. Nothing is published automatically.

Code signing is deliberately not configured. macOS signing is disabled in this initial configuration. Apple Developer ID signing/notarization and Windows signing require separate credentials and configuration; never put those secrets in source.

## Before the first public push

1. Inspect the files being added. Never include API keys, tokens, private keys, local app state, screenshots with private data, or existing `release/` artifacts.
2. Review licenses for dependencies, bundled assets, and shared skills.
3. Enable private vulnerability reporting in GitHub repository settings.
4. Enable GitHub Actions and allow the release job's `contents: write` permission.
5. Add a dedicated app icon and actual UI screenshots when available.
6. Review `npm audit` results and update/test affected dependencies before public distribution. The initial dependency tree includes known advisories; a successful build does not mean the dependency audit is clean.

No repository initialization, remote changes, tags, or pushes are performed by the setup files themselves.

## Publish a stable release

1. Test the Git workflows on disposable repositories. Run `npm ci`, `npm test`, and `npm run build`.
2. Bump `package.json` and `package-lock.json` together, for example `npm version patch --no-git-tag-version`.
3. Stabilize on `release/<version>` branched from `develop`. Merge the reviewed release into `main`, tag that production merge with the matching version (for example `v0.1.1`), then merge the release back into `develop`. Push the branches and tag. The workflow rejects mismatched tags and prerelease versions.
4. Wait for all four release builds to finish.
5. Download the draft assets and smoke-test each on a clean supported machine: launch, open/clone a repository, check Git availability, terminal behavior, and an update check.
6. Verify downloaded artifacts against the accompanying SHA-256 files. Checksums detect corruption; they do not replace code signing or protect against a compromised release account.
7. Review generated release notes, document known limitations and unsigned status, then publish the draft.

GitHub's latest-release API only sees published releases. Do not mark the release as a prerelease if it should be offered to installed users.

## Current update behavior

- A packaged app checks `https://api.github.com/repos/prapawity/GITVerse/releases/latest` once after its window loads; the Help menu supports manual checks.
- Semantic versions are compared, ignoring draft/prerelease releases and build metadata.
- Requests have a timeout; failures are visible and do not prevent app use. GitHub API limits can affect unauthenticated checks.
- A newer release triggers a confirmation dialog. Confirmation opens the configured repository's release page in the browser, never a server-provided arbitrary URL.
- Users choose the correct OS/architecture artifact, quit the app, and install it themselves. Existing app user-data should be preserved; back up important state before upgrading.
- There is no background installer, binary execution, or in-place replacement.

## Future automatic installation

Use a maintained updater such as `electron-updater` rather than implementing binary replacement manually:

1. Add Developer ID signing and notarization for macOS, and appropriate signing for Windows. Store certificates/passwords in GitHub Actions secrets.
2. Configure electron-builder's GitHub publish provider and generate/upload update metadata plus required artifacts, such as macOS ZIPs and Windows NSIS packages/blockmaps. Keep platform/architecture metadata distinct.
3. Integrate `electron-updater` in the main process with `autoDownload = false`. Ask before downloading, surface progress/errors, and ask before restart/install.
4. Avoid restarting during Git operations, an active terminal session, or unsaved editing. Preserve existing settings and provide recovery instructions.
5. Validate signing, metadata, download failures, upgrades from older versions, and installation on each real target platform.

Linux installation behavior depends on packaging and installation method; AppImage upgrades differ from package-manager-managed installations. Do not promise identical automatic replacement across all platforms before testing.

See the [electron-builder documentation](https://www.electron.build/) for the chosen version's packaging, signing, publishing, and updater requirements.
