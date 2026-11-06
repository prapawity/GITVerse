# GITVerse

A desktop Git client built with Electron and React, with commit graphs, working-tree diffs, conflict tools, and optional AI assistance.

**Status: experimental.** Back up important work before using operations that change history or the working tree. Cross-platform packaging is configured but every platform must be smoke-tested before publication.

## Features

- Repository tabs, groups, local-folder discovery, and cloning.
- Commit graph, branch/ref navigation, search, and paginated history.
- Working changes, staging, commits, commit details, and diffs.
- Branches, tags, stashes, fetch/pull/push, and Git Flow configuration.
- Merge/conflict workflow and integrated terminal.
- Commit identity profiles and repository-specific push authentication.
- Optional Claude, OpenAI, and GitHub Copilot integrations.
- Stable-release checks against GitHub Releases, with user-confirmed manual installation.

Dropping folders searches for repositories without a folder-count or depth limit. The scan shows live progress and can be cancelled. Hidden folders, dependency/build directories, and directory symlinks are skipped. Unreadable folders or invalid repositories are reported; cancelling discards the interrupted folder's results and keeps already completed dropped folders.

The commit graph follows local branches, remotes, tags, and HEAD. Agent recovery refs under `refs/agents/` appear in a separate, collapsible **Agent checkpoints** panel, not as actionable branch commits. They are still Git objects used by the coding agent for recovery; GITVerse does not delete them. Normal branch pushes do not publish those refs.

While the app is visible, repository status, refs, and operation state are checked every five seconds and when returning to the app. Changes made in a terminal or another Git client reload history with a notification. In-app pushes fetch remote refs afterward; a failed follow-up fetch is reported separately from a successful push. The WIP row shows changed and staged file counts; committing consumes staged changes, creates a history entry, and leaves any remaining changes in WIP.

Select **Amend previous commit** to update the latest commit instead of creating a new one. Its summary and description immediately replace the current draft with the latest commit message for editing, without a confirmation dialog. Leave both message fields blank to keep its existing summary and description, or enter a summary and optional description to replace the message. Amend can run without staged files. It rewrites the commit; if already pushed, updating the remote may require a force push.

The Push dialog offers **Force push (--force-with-lease)** for intentionally rewritten history, with a separate confirmation before sending. A non-fast-forward rejection also shows this option instead of retrying automatically. The lease uses the remote-tracking hash captured when the dialog opened: if the remote changes, the push is rejected, even if a background fetch updates local refs. If the remote hash is unavailable or the lease is stale, fetch and review the remote branch, then reopen the dialog. Force push may remove remote-only commits; server-side branch protections still apply.

## Download

Download a package for your operating system from [GitHub Releases](https://github.com/prapawity/GITVerse/releases). Packages will appear after the first release is published.

| Platform            | Package                                   |
| ------------------- | ----------------------------------------- |
| macOS Apple Silicon | `mac-arm64.dmg` or `mac-arm64.zip` suffix |
| macOS Intel         | `mac-x64.dmg` or `mac-x64.zip` suffix     |
| Windows x64         | `win-x64.exe` suffix                      |
| Linux x64           | `linux-x64.AppImage` suffix               |

Initial releases are unsigned and not notarized. macOS Gatekeeper and Windows SmartScreen may warn or block installation. Only install artifacts you trust; do not disable system-wide security protections. Linux AppImage support may require FUSE or extraction on your distribution.

Git must be installed separately and available to the app through `PATH`. Quit GITVerse before replacing/upgrading an installation.

## Development

Requirements:

- Node.js 22.13 or newer and npm.
- System Git.
- On macOS/Linux, `python3` for the terminal's default PTY bridge.
- Windows runs the integrated terminal with plain pipes when optional `node-pty` is unavailable; full terminal editing/resize behavior is limited.

```bash
git clone https://github.com/prapawity/GITVerse.git
cd GITVerse
npm ci
npm run dev
```

```bash
npm test         # Release checks, repository scanning, history, and store regressions
npm run build    # TypeScript check and production bundles
npm run test:electron  # Build, then test desktop startup, reload, and restored tabs
npm run dist     # Build installers for the current host
```

### Code quality and dependency security

```bash
npm run lint            # ESLint for TypeScript, JavaScript, and React hook ordering
npm run lint:fix        # Apply safe ESLint fixes
npm run format:check    # Verify Prettier formatting
npm run format          # Format source, configs, and documentation
npm run security:audit  # Audit all dependencies, failing on high/critical advisories
```

CI checks lint, formatting, tests, builds, and Electron startup/reload smoke tests. A separate dependency-security job runs the audit without auto-fixing or suppressing advisories. Dependabot proposes weekly npm and GitHub Actions updates against `develop`.

Electron 45 and Vite 7 replace older vulnerable releases. Security overrides use patched Zod 4 for the Copilot SDK and minimatch 11 for affected build/lint dependencies; keep these overrides until upstream dependency ranges include the fixes. A clean install currently passes the audit, but rerun it before releases because advisories change.

If a development reload reports a missing desktop connection, stop and restart `npm run dev`. Main and preload builds use separate output directories so rebuilding main cannot delete preload. The app shows a startup error instead of loading an empty session when the bridge is unavailable; saved repository tabs are not cleared.

ESLint permits existing explicit `any` at legacy IPC boundaries; this is not full type-safety certification. Only the React hook-ordering rule is enabled initially, not the exhaustive-dependency or React compiler rule sets. Dependency audits do not replace code review, secret scanning, or signed releases.

The app's `private` package flag prevents accidental npm publication; it does not prevent publishing source on GitHub under MIT.

## Updates

Packaged apps check the latest stable GitHub Release once after the main window loads. Development mode does not check automatically. Use **Help > Check for Updates** to retry manually.

When a newer semantic version is found, the app asks before opening its GitHub download page. It **does not download, run installers, or replace files automatically**. Network failures are reported without preventing normal app use. Draft releases and prereleases are not offered.

See [Releasing](./RELEASING.md) for the release workflow and a future signed automatic-update path.

## AI and privacy

AI is optional and requires your own account, subscription, or API key. Provider charges and usage limits apply. Requests go to the provider you select when you use AI features:

- Chat can include your messages and repository details returned by tools.
- AI commit-message generation sends staged diff content.
- AI conflict resolution sends conflicted content and surrounding context.

Do not use AI on repositories whose policies prohibit sending that content to an external provider. Credentials are handled in the Electron main process; saved secrets use Electron `safeStorage`. OS secure-storage availability and protection vary by platform.

Update checks contact the public GitHub API and send the usual network request metadata, but no repository files or AI credentials. Settings and remembered tabs are stored locally in the application's user-data directory.

## Project documentation

- [Architecture](./ARCHITECTURE.md)
- [Contributing](./CONTRIBUTING.md)
- [Release process](./RELEASING.md)
- [Security reporting](./SECURITY.md)
- [MIT license](./LICENSE)

## Known limitations

- Experimental software; build success is not a substitute for testing real Git workflows.
- No signed/notarized distribution or automatic installation yet.
- System Git, shell, Python, credential helpers, and provider access are not bundled.
- Platform-specific Git credentials, packaging, terminal behavior, and app launch need testing.
- Screenshots and a dedicated application icon are still to be added; no placeholder screenshots are presented as actual UI.

Issues and feature requests are welcome at [GitHub Issues](https://github.com/prapawity/GITVerse/issues). Do not include private repository content, credentials, or personal account details.
