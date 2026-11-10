# GITVerse System Design

**Status:** Working design, aligned with the current application source.
**Audience:** Product, UI, desktop, and QA contributors.

## 1. Product purpose

GITVerse is a Windows-first desktop Git client for developers managing repositories, branches, commit history, diffs, stashes, conflicts, and a local terminal. The commit graph is the main workspace. Each action should make its target and its effect on the index, working tree, current branch, and remote visible.

## 2. Design principles

1. **Show repository state before offering the next action.** Keep current branch, upstream divergence, working changes, and in-progress operations visible.
2. **Separate network sync from working-tree updates.** Fetch updates remote-tracking refs; pull integrates those changes into the current branch and may change files.
3. **Protect staged and unstaged work independently.** Partial staging and discard operations use the expected diff snapshot and refuse stale or unsupported changes.
4. **Make recovery discoverable.** Reflog and agent checkpoints are reviewable before any state-changing recovery action.
5. **Keep advanced operations previewable.** Rebase planning validates the selected range and remains read-only until execution and abort flows are complete.
6. **Keep desktop chrome compact.** Preserve independent resizable panes, keyboard navigation, visible focus, clear loading and error states, and the existing theme tokens.

## 3. Application structure

```text
Electron main process
  Git operations, repository inspection, terminal PTY, AI providers, persistence
       │ validated IPC through preload
React renderer
  App shell, graph, repository sidebar, details, changes, conflicts, settings
       │
Zustand stores
  Repository state, asynchronous refresh, operation feedback, user settings
```

The renderer never invokes shell commands directly. Git work runs in the main process through `electron/git`; only named APIs are exposed by `electron/preload.ts`. Long-running operations refresh repository state after completion and report failures through the feedback system.

## 4. Primary workspace

- **Top navigation:** repository and branch selectors, fetch/pull, push, branch, stash, recovery, workspace inspection, rebase preview, terminal, AI, and commit search.
- **Left sidebar:** local branches, remote branches, stashes, tags, and filtering.
- **Center graph:** branch relationships, commit selection, keyboard navigation, and context actions.
- **Right detail pane:** commit details, changed files, stash details, working changes, conflict resolution, recovery, or workspace inspection.
- **Settings:** identity, appearance, terminal, AI providers, and application preferences.

Use existing semantic tokens in `src/index.css` and `design-system/gitverse/MASTER.md`. Keep Git content readable above glass effects: glass is chrome, not a texture behind paths, hashes, diffs, or conflict text.

## 5. Git workflow contracts

### Fetch and pull

Fetch downloads objects and updates remote-tracking refs. Pull fetches and then integrates the selected upstream. The toolbar label follows the selected mode. If a pull cannot check out a Windows-incompatible path, keep local state intact, show the offending path, and explain that fetch and pull have different effects.

### Branch checkout

Checking out a remote ref selects or creates a local tracking branch. If an existing local branch is behind, fast-forward it to the fetched remote tip in the same action. Refuse when local changes exist, when local commits are ahead or diverged, or when Windows cannot represent paths in the target tree. Never reset local commits to force the branches together. Confirm after refresh that both branch tips match before reporting success.

### Partial staging

Stage and unstage supported text hunks against the diff snapshot the user inspected. Reject stale snapshots, binary files, path additions/deletions, renames, and mode changes where the implementation cannot safely preserve unrelated index state. Line-level selection is a later extension.

### Stashes and conflicts

Apply, pop, and drop target the selected stash object by hash. Pop removes it only after successful application. Conflicts keep the stash and bring conflict guidance forward. Resolve and continue actions should state progress and retain an abort path.

### Recovery

Reflog and checkpoint entries are a review surface. Copying a hash and navigating reachable commits are safe; reset, branch creation, or cherry-pick recovery require a separate explicit action and confirmation.

## 6. Safety and data boundaries

- Never run mutation tests against the user's repository. Create a temporary repository and local bare remote for Git fixtures.
- Do not silently stage, discard, commit, reset, merge, rebase, push, drop a stash, or delete a branch.
- Revalidate the active repository before applying delayed UI results or completing an asynchronous action.
- Treat remote URLs as secrets: hide URL credentials, query strings, and fragments in inspection UI and logs.
- Keep terminal input in the terminal process. If PTY startup fails, clearly label the reduced fallback behavior.
- Never claim that Fetch updated the checked-out branch or that a branch checkout synchronized its commit history.

## 7. Accessibility and interaction

- Every icon-only button has an accessible name; all actions support keyboard use and visible focus.
- Graph rows support arrow/Home/End navigation, Enter for details, and Shift+F10 for actions.
- Dialogs identify their title, support Escape, return focus to the opener, and keep destructive confirmation explicit.
- Status is not conveyed by color alone. Preserve readable branch names, commit hashes, and error text in every theme.
- Respect reduced motion and keep pane scrolling independent.

## 8. Delivery priorities

See [git-gui-roadmap.md](git-gui-roadmap.md) for implementation status. The highest remaining workflow gaps are line-level staging, packaged terminal smoke coverage, applying the rebase preview, and safe mutation flows for remotes/worktrees. LFS, submodules, and hosting-specific integrations need product requirements before implementation.

## 9. QA acceptance

Use `.agents/skills/gitverse-qa/SKILL.md`. Identify whether a check targets source, development Electron, packaged Electron, or the installed app. Verify relevant Git state before and after fixture mutations, stale operations, conflicts, keyboard access, errors, and cancellation. Report skips and environment limits separately from passes.
