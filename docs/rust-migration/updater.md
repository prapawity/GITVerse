# In-app updates (Tauri build)

The Tauri build updates itself with the Tauri updater plugin. Every update bundle is signed with a
private key that only the release workflow holds; the app has the matching public key built in and
refuses any bundle whose signature does not match (and, with `requireSignedVersion`, any bundle
signed for a different version than the feed announces).

Until the key is configured, installers are still built, but without in-app updates: the app reports
updates like a development build and the Settings page offers the release list instead.

## One-time setup

1. Generate the key pair on your own machine (not in the repository). Choose a password when asked:

   ```sh
   npx tauri signer generate -w ~/.tauri/gitverse-updater.key
   ```

   This writes `gitverse-updater.key` (private, keep it safe and backed up) and
   `gitverse-updater.key.pub` (public).

   If the private key is lost, installed apps can no longer be updated in place: a new key needs a
   new public key in the app, so users must reinstall once.

2. In GitHub, open the repository → Settings → Secrets and variables → Actions:
   - **Secrets** → New repository secret:
     - `TAURI_SIGNING_PRIVATE_KEY`: the full contents of `gitverse-updater.key`
     - `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`: the password from step 1
   - **Variables** → New repository variable:
     - `GITVERSE_UPDATER_PUBKEY`: the full contents of `gitverse-updater.key.pub`
       (a repository secret with this name works too)

That is all: the next run of **Release** builds signed bundles.

## How a release reaches users

1. Push a `vX.Y.Z` tag that matches `package.json`.
2. **Release** builds the installers, signs the update bundles and creates a draft release with
   `latest.json` plus `GITVerse_X.Y.Z_<platform>.*`.
3. Publish the draft. Installed apps read
   `https://github.com/prapawity/GITVerse/releases/latest/download/latest.json`, find the new
   version, download and verify the bundle, install it and restart.

## Pieces

| File                                                   | Role                                                                                    |
| ------------------------------------------------------ | --------------------------------------------------------------------------------------- |
| `src-tauri/tauri.conf.json` → `plugins.updater`        | feed URL, `requireSignedVersion`; `pubkey` is empty here                                |
| `src-tauri/src/update_commands.rs`                     | `updates:*` commands; the public key comes from `GITVERSE_UPDATER_PUBKEY` at build time |
| `src-tauri/tauri.updater.conf.json`                    | `createUpdaterArtifacts`, added only when the key is configured                         |
| `scripts/updater-collect.mjs` / `updater-manifest.mjs` | per-platform bundle + signature → `latest.json`                                         |
| `.github/workflows/release-tauri.yml`                  | signed build, `updater-feed` job on tags                                                |
