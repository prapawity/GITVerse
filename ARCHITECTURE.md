# GitVerse architecture

GitVerse is a desktop Git client built with Electron, React, TypeScript, Vite, Tailwind CSS, and Zustand. The renderer owns the UI and application state; privileged operations run in Electron's main process and are exposed through a narrow preload bridge.

## Project layout

```text
electron/
  main.ts             Create the window and register repository, Git, profile, and state IPC handlers
  preload.ts          Expose window.gitApi through contextBridge
  git/
    git.ts            Git operations, executed through the system Git CLI
  ai/
    index.ts          AI IPC, request lifecycle, and provider routing
    claude.ts         Claude provider
    openai.ts         OpenAI provider and sign-in
    copilot.ts        GitHub Copilot provider and sign-in
    common.ts         Shared AI helpers and credential handling
  terminal.ts         Integrated terminal process and IPC
  state.ts            Persistent key/value state in Electron's user-data directory
  updates.ts          Stable GitHub release checks and semantic-version comparison
  updates.test.ts     Release-check regression tests
  repositoryScan.ts   Unlimited iterative folder discovery, progress, and cancellation

src/
  App.tsx             Main application shell and panel coordination
  main.tsx            React entry point
  components/         Repository, graph, diff, merge/conflict, AI, terminal,
                      settings, dialogs, and activity UI
  lib/                Graph layout, diff/conflict helpers, ref trees, and storage
  shared/             Git and AI types, tool definitions, and shared contracts
  store/
    repoStore.ts      Repository data, Git actions, selection, progress, and notifications
    settingsStore.ts  User preferences, profiles, repository groups, and Git Flow config
    aiStore.ts        AI conversation, streaming, and tool-call coordination
  index.css           Global styles and theme tokens

preview/               Browser preview with mock data and its own Vite setup
scripts/               Electron branding helper
release/               Packaged application artifacts
dist/                  Renderer build output
dist-electron/main/    Electron main build output
dist-electron/preload/ Electron preload build output
```

## Runtime and data flow

```text
React component
  -> Zustand store or feature module
  -> window.gitApi (preload)
  -> IPC handler in electron/main.ts or a registered service
  -> Git CLI, terminal process, local state, or AI provider
  -> IPC response/event
  -> renderer state and UI
```

- **Git and repository operations:** `electron/main.ts` registers Git IPC handlers that call `electron/git/git.ts`. The Git wrapper runs the system Git CLI from the main process; the renderer does not execute shell commands directly. Long-running changes are surfaced through store progress state, notifications, and conflict state.
- **Discard:** The renderer confirms file selections or a single diff hunk and passes the displayed diff snapshot through preload. The main process validates current status and snapshots before modifying files. Tracked file discard uses literal-pathspec `git restore --worktree` to retain the index; untracked file removal is repository-confined and nonrecursive. Text hunk discard extracts one hunk from the verified Git diff and reverse-applies a temporary patch after `git apply --check`. Other hunks and the index remain unchanged. Snapshot validation does not make filesystem/Git mutations transactional.
- **Preload boundary:** `electron/preload.ts` exposes the `gitApi` methods and event subscriptions via `contextBridge`. The renderer communicates through this API rather than importing Electron or Node APIs.
- **Startup:** In Electron, the renderer refuses to mount the app if the preload storage bridge is missing, displaying recovery instructions without overwriting remembered repositories. Otherwise `AppLaunch` initializes the dashboard behind a full-bleed `LaunchScreen` and waits for workspace loading, a 2.5-second presentation minimum, and the update result, followed by a 300 ms fade. Optional updates use `UpdateNotice`; network failures offer Retry/Continue. A latched fade prevents background loading from interrupting the final transition. Reduced motion skips animation and the presentation delay.
- **AI:** Provider integrations live in `electron/ai/`. The main process handles provider requests and credentials; the renderer maintains the conversation and coordinates tool calls with the repository store, where user-facing approval and Git actions belong.
- **Terminal:** `electron/terminal.ts` manages terminal processes. It prefers `node-pty`, with platform-specific fallbacks when the native module is unavailable. Terminal data and lifecycle events cross IPC.
- **Persistence:** Zustand settings and remembered repository tabs use `src/lib/storage.ts`. In Electron, storage is bridged to a JSON key/value file in the app's user-data directory; browser preview can fall back to `localStorage`.
- **Updates:** `gitApi.updates` exposes environment, cached startup checks, deduplicated manual checks, and validated release-page opening. The main process performs all GitHub requests and returns typed development/current/optional/error states. Settings uses `ApplicationAbout`; launch and Settings share the optional-update dialog. Only packaged apps query GitHub. Development controls are disabled and IPC still guards against direct calls. Download URLs must resolve to a valid release tag in the configured GitHub repository. There is no automatic binary replacement or minimum-version blocking.
- **Folder discovery:** Repository scans have no folder-count or depth ceiling. Iterative traversal skips hidden, dependency/build, and symlink directories; progress events are throttled and cancellation aborts the active Git child process. Scan sessions belong to their requesting renderer and are cancelled if it is destroyed. Unreadable or invalid folders are counted and surfaced by the UI.

## Main renderer responsibilities

- `repoStore` loads repository history, refs, and working-tree status, and coordinates Git actions, pagination, conflict operations, and activity feedback.
- `settingsStore` contains appearance and behavior preferences, repository-specific Git Flow configuration, identity/push profiles, and repository groups.
- `aiStore` manages the provider-neutral transcript, streamed responses, tool calls, and their results.
- `components/` contains the application surfaces, including the commit graph, repository navigation, working changes, commit details/diffs, stash, merge/conflict tools, AI panel, terminal, and settings.
- Working Changes sorts groups by natural path order or added/deleted-line totals. Count sorting lazily calls `fileChangeCounts` through preload; the main process parses NUL-delimited Git numstat output, preserves rename destinations, and bounds untracked-file queries to eight at a time. Staged/unstaged counts are independent; binary counts are `null` and sort last. Shift selection follows the rendered order. Sign-off remains supported by the Git API but is not requested by the commit form.
- `lib/graphLayout.ts` computes graph lanes independently of the React UI. Other library modules provide shared diff, conflict, ref-tree, and storage behavior.
- History queries and pagination positions use the same local-branch, remote, tag, and HEAD scope. Agent refs are queried separately by namespace and shown as read-only recovery references in `AgentCheckpoints`, outside the commit graph; classification does not depend on commit-message text.
- `refs` includes stash reflog hashes, base parents, author/date, and messages. `withStashes` merges readonly stash nodes into graph input without changing the paginated branch commit list or exposing the stash's index/untracked helper parents. `layoutGraph` tracks stash lanes through intervening rows so their connecting segments can use a dashed style. Stash detail uses stable object hashes; tracked file changes come from the base-to-stash snapshot and untracked files from the third-parent tree. `DetailsPanel` reuses commit metadata and Path/Tree layouts; `StashView` delegates individual files to readonly `DiffView` providers. Renaming a stash stores a new reflog entry with its name, then removes the previous entry; this keeps the stash object and its contents while moving it to the top of the list. Stash nodes do not open branch-action menus.
- The Fetch toolbar selection is persisted in `settingsStore`; it dispatches to fetch-all or one of three Git pull modes. Background fetches and post-push synchronization remain fetch-only.
- Visible-window polling and focus/visibility events refresh status and compare refs/operation state, reloading history only when those change. Silent reloads preserve the loaded history depth. Both push entry points share post-push fetching and local refresh, with distinct warnings if the fetch fails after a successful push.
- The Push dialog keeps normal push as the default; force push uses an inline warning and explicit **Confirm force push** action in that same dialog, without a stacked confirmation modal. `pushInfo` snapshots the target's remote-tracking hash; preload and main forward this fixed lease to `pushBranch`, which validates the hash and supplies `--force-with-lease=refs/heads/<target>:<hash>`. Background fetches cannot silently advance the confirmed lease. A missing hash requires fetching and reopening the dialog.

## Development and build

- ESLint uses `eslint.config.mjs` for JavaScript/TypeScript and React hook-ordering checks; Prettier and EditorConfig define formatting. CI runs lint and format checks alongside tests/builds.
- `npm run security:audit` is a separate CI gate for high/critical dependency advisories. Dependabot targets `develop` with weekly npm and Actions updates.

- `npm run dev` starts the Vite/Electron development workflow.
- `npm run build` runs the TypeScript check and Vite production build.
- `npm test` runs release-check, repository-discovery, history, and repository-store regression tests, including traversal beyond 5,000 folders and five levels, agent checkpoint separation, and post-push graph synchronization.
- `npm run test:electron` builds and launches the real desktop app with a disposable repository and isolated user data. It verifies bridge APIs, folder-dialog IPC, remembered tabs across reload/restart, and missing-bridge feedback. CI runs the smoke script after its existing build.
- `npm run dist` builds host-platform installers using `electron-builder.yml`; GitHub Actions builds all configured targets and creates a draft release. See [RELEASING.md](./RELEASING.md).
- `vite.config.ts` configures relative renderer asset URLs for packaged `file://` loading. Main and preload builds clean only their own output directories, avoiding concurrent development builds deleting each other's files. The package entry is `dist-electron/main/main.js`.
