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
- **Preload boundary:** `electron/preload.ts` exposes the `gitApi` methods and event subscriptions via `contextBridge`. The renderer communicates through this API rather than importing Electron or Node APIs.
- **Startup:** In Electron, the renderer refuses to mount the app if the preload storage bridge is missing, displaying recovery instructions without overwriting remembered repositories.
- **AI:** Provider integrations live in `electron/ai/`. The main process handles provider requests and credentials; the renderer maintains the conversation and coordinates tool calls with the repository store, where user-facing approval and Git actions belong.
- **Terminal:** `electron/terminal.ts` manages terminal processes. It prefers `node-pty`, with platform-specific fallbacks when the native module is unavailable. Terminal data and lifecycle events cross IPC.
- **Persistence:** Zustand settings and remembered repository tabs use `src/lib/storage.ts`. In Electron, storage is bridged to a JSON key/value file in the app's user-data directory; browser preview can fall back to `localStorage`.
- **Updates:** The main process checks the configured public GitHub repository once after a packaged window loads. A native dialog asks before opening the release page for manual download/installation; the Help menu supports retrying. No renderer IPC or automatic binary replacement is involved.
- **Folder discovery:** Repository scans have no folder-count or depth ceiling. Iterative traversal skips hidden, dependency/build, and symlink directories; progress events are throttled and cancellation aborts the active Git child process. Scan sessions belong to their requesting renderer and are cancelled if it is destroyed. Unreadable or invalid folders are counted and surfaced by the UI.

## Main renderer responsibilities

- `repoStore` loads repository history, refs, and working-tree status, and coordinates Git actions, pagination, conflict operations, and activity feedback.
- `settingsStore` contains appearance and behavior preferences, repository-specific Git Flow configuration, identity/push profiles, and repository groups.
- `aiStore` manages the provider-neutral transcript, streamed responses, tool calls, and their results.
- `components/` contains the application surfaces, including the commit graph, repository navigation, working changes, commit details/diffs, stash, merge/conflict tools, AI panel, terminal, and settings.
- `lib/graphLayout.ts` computes graph lanes independently of the React UI. Other library modules provide shared diff, conflict, ref-tree, and storage behavior.
- History queries and pagination positions use the same local-branch, remote, tag, and HEAD scope. Agent refs are queried separately by namespace and shown as read-only recovery references in `AgentCheckpoints`, outside the commit graph; classification does not depend on commit-message text.
- Visible-window polling and focus/visibility events refresh status and compare refs/operation state, reloading history only when those change. Silent reloads preserve the loaded history depth. Both push entry points share post-push fetching and local refresh, with distinct warnings if the fetch fails after a successful push.
- The Push dialog keeps normal push as the default and requires separate confirmation for force push. `pushInfo` snapshots the target's remote-tracking hash; preload and main forward this fixed lease to `pushBranch`, which validates the hash and supplies `--force-with-lease=refs/heads/<target>:<hash>`. Background fetches cannot silently advance the confirmed lease. A missing hash requires fetching and reopening the dialog.

## Development and build

- ESLint uses `eslint.config.mjs` for JavaScript/TypeScript and React hook-ordering checks; Prettier and EditorConfig define formatting. CI runs lint and format checks alongside tests/builds.
- `npm run security:audit` is a separate CI gate for high/critical dependency advisories. Dependabot targets `develop` with weekly npm and Actions updates.

- `npm run dev` starts the Vite/Electron development workflow.
- `npm run build` runs the TypeScript check and Vite production build.
- `npm test` runs release-check, repository-discovery, history, and repository-store regression tests, including traversal beyond 5,000 folders and five levels, agent checkpoint separation, and post-push graph synchronization.
- `npm run test:electron` builds and launches the real desktop app with a disposable repository and isolated user data. It verifies bridge APIs, folder-dialog IPC, remembered tabs across reload/restart, and missing-bridge feedback. CI runs the smoke script after its existing build.
- `npm run dist` builds host-platform installers using `electron-builder.yml`; GitHub Actions builds all configured targets and creates a draft release. See [RELEASING.md](./RELEASING.md).
- `vite.config.ts` configures relative renderer asset URLs for packaged `file://` loading. Main and preload builds clean only their own output directories, avoiding concurrent development builds deleting each other's files. The package entry is `dist-electron/main/main.js`.
