---
name: gitverse-qa
description: Verify GITVerse desktop Git workflows and report reproducible defects. Use when asked to QA or regression-check GITVerse, including Git state, Electron integration, and interface behavior.
---

# GITVerse QA

Verify the requested behavior in the current checkout and identify the exact build being exercised. Read the relevant implementation and existing tests first; distinguish a source change from an installed or packaged build. Do not claim a workflow passed just because the app compiled or a button was visible.

## Protect repository state

Use a newly created temporary Git repository for any operation that changes branches, commits, the index, files, remotes, stashes, or worktrees. Set fixture identity locally and use a temporary local bare remote where a remote is needed. Never stage, discard, commit, reset, merge, push, or otherwise mutate a user's repository as a test. Confirm fixture paths before cleanup; preserve unrelated working-tree changes and existing release artifacts.

## Choose checks by risk

- Run relevant existing checks from `package.json`. `npm test` exercises Git backend and store behavior; `npm run test:electron` builds and exercises the Electron bridge, folder picker, repository restore, and existing UI smoke coverage. Run lint and build when applicable. State skips, failures, and environmental limitations.
- For Git mutations, assert the actual Git state before and after, including `git status --porcelain=v2`, index contents, working-tree contents, HEAD, and refs as relevant. Include stale snapshots, conflicts, filenames with spaces or special characters, and unrelated changes where they bear on the change. For destructive operations test cancellation and recovery in fixtures.
- For remote checkout, verify an existing behind tracking branch fast-forwards to the fetched remote tip; verify dirty worktrees, ahead/diverged local commits, and Windows-incompatible target paths are refused without moving HEAD or losing local data.
- For UI changes, inspect the running app in the relevant state, not only source markup. Check selection and action targets, disabled/loading/error states, keyboard access and focus, visible labels, contrast in supported themes, and a narrow desktop window when affected. Exercise dialog cancellation and return paths. Use fixture data for operations.
- For packaging or terminal changes, exercise the packaged build and actual target platform when feasible; identify fallback behavior and any untested interactive, authentication, or native-module cases. Avoid network or remote writes unless the request authorizes them.
- For asynchronous refresh or multi-repository flows, check that stale results and delayed actions cannot mutate or display the wrong repository. Verify both success and error paths.

## Report

Provide findings first, ordered by user impact, with reproducible steps, expected and observed behavior, and exact code locations when known. Separate confirmed behavior from inference. Include commands or build identity used, what passed, what was not exercised, and any remaining risk. If no defects are found, say so without implying broader coverage than performed. Fixes are a separate task unless the user requested them.
