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
dist-electron/         Electron main/preload build output
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

## Development and build

- `npm run dev` starts the Vite/Electron development workflow.
- `npm run build` runs the TypeScript check and Vite production build.
- `npm test` runs release-check and repository-discovery regression tests, including traversal beyond 5,000 folders and five levels.
- `npm run dist` builds host-platform installers using `electron-builder.yml`; GitHub Actions builds all configured targets and creates a draft release. See [RELEASING.md](./RELEASING.md).
- `vite.config.ts` configures the React and Electron plugins with relative renderer asset URLs for packaged `file://` loading; Electron main and preload bundles are emitted separately from the renderer.
