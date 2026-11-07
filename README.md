# GITVerse

<img src="./src/assets/gitverse-logo.svg" alt="GITVerse Orbital Graph logo" width="360" />

A desktop Git client built with Electron and React, with commit graphs, working-tree diffs, conflict tools, and optional AI assistance.

**Status: experimental.** Back up important work before using operations that change history or the working tree. Cross-platform packaging is configured but every platform must be smoke-tested before publication.

The **Orbital Graph** identity separates a solid cyan/teal Git graph from a thinner violet/lilac orbit. The large wordmark adds violet-magenta nebula ribbons and gently twinkling stars; reduced-motion preferences disable the animation. The small symbol stays static and uncluttered. Vector sources: [symbol](./src/assets/gitverse-mark.svg) and [wordmark](./src/assets/gitverse-logo.svg). Open the standalone [brand preview](./preview/brand.html) to inspect light/dark backgrounds and 16-64 px sizes. The symbol is used in the app header and browser favicon; packaged OS icons are unchanged.

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

The commit graph follows local branches, remotes, tags, and HEAD, with readonly stash nodes merged into the layout. All stash reflog entries are shown with amber stash badges and connected to their base commit using a dashed line; internal index/untracked stash commits are not added as separate graph nodes. Select a stash from the sidebar or graph to see its hash, base parent, message, author/date, and Path/Tree file list while keeping the graph visible. Stash names can be set when creating a stash and edited from its detail field; renaming moves that stash to the top of the stash list. Selecting a file opens its readonly unified/split diff or file snapshot, including saved untracked files. Stash selection uses the object hash so reflog renumbering cannot switch the displayed content; a removed stash closes the selection on refresh. Stash nodes are excluded from branch context actions, and branch-history pagination is unchanged. Agent recovery refs under `refs/agents/` appear in a separate, collapsible **Agent checkpoints** panel, not as actionable branch commits. They are still Git objects used by the coding agent for recovery; GITVerse does not delete them. Normal branch pushes do not publish stash objects or agent refs.

The Fetch toolbar menu remembers one of four actions for its main button: **Fetch All**, **Pull (fast-forward if possible)**, **Pull (fast-forward only)**, or **Pull (rebase)**. Fetch pruning follows the Auto-Prune setting. While the app is visible, repository status, refs, and operation state are checked every five seconds and when returning to the app. Changes made in a terminal or another Git client reload history with a notification. In-app pushes fetch remote refs afterward; a failed follow-up fetch is reported separately from a successful push. The WIP row shows changed and staged file counts with a cyan neon highlight; committing consumes staged changes, creates a history entry, and leaves any remaining changes in WIP.

Working Changes provides red trash buttons for one file or the selected files; with no selection, the top trash button discards all unstaged/untracked files. Click blank list space to clear the selection. Sort each group by **A-Z**, **Z-A**, **Most changes**, or **Fewest changes**; change counts are added plus deleted lines, counted separately for staged and unstaged content, with binary files last in count-based sorts. Shift-click selects a range in the displayed order; Ctrl/Cmd-click toggles individual files. The list refreshes automatically without a dedicated Refresh button. Discard requires confirmation, restores tracked files from the index, and permanently deletes selected untracked files without affecting staged content. Unstage staged-only changes before discarding them. In an unstaged text diff, **Discard hunk** removes only that change group and refreshes the detail view; added/deleted files, binary files, renames, and mode changes use whole-file discard instead. Discard rejects changed snapshots, conflicts, active Git operations, and whole-submodule/directory deletion. There is no app undo for discard; batches are not transactional if a Git/filesystem failure occurs during execution, so review the refreshed changes after an error.

Open the sort icon in the Working Changes header to choose a sorting mode from a compact menu. The current mode is checked and shown in the icon tooltip; selecting a mode, clicking outside, or pressing Escape closes the menu. Arrow keys navigate the choices without adding a permanent toolbar row.

The commit form does not offer sign-off or append `Signed-off-by` automatically; repositories requiring that trailer can include it in the description. Sign-off is a contributor certification, not a cryptographic signature. The footer shows the repository directory on the left and **Activity log** followed by an orange slanted app-version badge on the right, with the activity popup opening above the right edge. The badge reads the version from package metadata and updates with the app build.

Select **Amend previous commit** to update the latest commit instead of creating a new one. Its summary and description immediately replace the current draft with the latest commit message for editing, without a confirmation dialog. Leave both message fields blank to keep its existing summary and description, or enter a summary and optional description to replace the message. Amend can run without staged files. It rewrites the commit; if already pushed, updating the remote may require a force push.

The Push dialog offers **Force push (--force-with-lease)** for intentionally rewritten history. Selecting it shows a warning in the same dialog; **Confirm force push** sends the push without opening another modal. A non-fast-forward rejection also shows this option instead of retrying automatically. The lease uses the remote-tracking hash captured when the dialog opened: if the remote changes, the push is rejected, even if a background fetch updates local refs. If the remote hash is unavailable or the lease is stale, fetch and review the remote branch, then reopen the dialog. Force push may remove remote-only commits; server-side branch protections still apply.

## Download

Download the latest published installer from [GitHub Releases](https://github.com/prapawity/GITVerse/releases/latest). Choose the file for your OS and CPU below; draft releases are not downloadable from the latest-release page.

| Platform            | Package                                   |
| ------------------- | ----------------------------------------- |
| macOS Apple Silicon | `mac-arm64.dmg` or `mac-arm64.zip` suffix |
| macOS Intel         | `mac-x64.dmg` or `mac-x64.zip` suffix     |
| Windows x64         | `win-x64.exe` suffix                      |
| Linux x64           | `linux-x86_64.AppImage` suffix            |

On macOS, open the DMG and drag GITVerse to Applications (or unzip the ZIP). On Windows, run the EXE installer. On Linux, make the AppImage executable (`chmod +x GITVerse-*.AppImage`) and launch it; AppImage support may require FUSE or extraction on your distribution.

Initial releases are unsigned and not notarized. macOS Gatekeeper and Windows SmartScreen may warn or block installation. Only install artifacts you trust; do not disable system-wide security protections.

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

Startup displays the **GitVerse Universe** launch scene: a local nebula image, twinkling stars, a pulsing Git graph, and a cosmic ring that completes a clockwise turn during the 2.8-second sequence. It remains visible until the initial update check and workspace loading finish, then fades into the app. Reduced-motion preferences disable the animation and minimum presentation delay.

The standalone animation preview at `preview/launch.html` uses the preview Vite server and loops the scene without any update requests; it is not the application readiness flow.

Packaged release apps check the latest stable GitHub Release through the main process during launch, caching the startup result for that app session. **Settings > Application / About > Check for Update** provides a loading indicator, optional-update dialog with **Update/Later**, or a latest-version message; **Help > Check for Updates** also supports manual checks. Development/unpackaged builds never send update-check requests, automatically or manually; both update controls are disabled there.

When a newer semantic version is found, the app asks before opening its GitHub download page. It **does not download, run installers, or replace files automatically**. A failed launch check offers **Retry/Continue** so offline use remains possible. Draft releases and prereleases are not offered. This version supports optional updates only: minimum-version blocking is not enabled because no authoritative version-policy API has been configured.

Launch imagery: the [Orion Nebula Hubble mosaic](https://commons.wikimedia.org/wiki/File:Orion_Nebula_-_Hubble_2006_mosaic_18000.jpg), credited to NASA, ESA, M. Robberto (STScI/ESA), and the Hubble Space Telescope Orion Treasury Project Team. The 2006 image is available under the source page's public-domain terms; the bundled 1920-pixel derivative is color-treated in CSS. The original metadata also references [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/). No external image request is made during launch.

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
