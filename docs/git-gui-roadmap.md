# GITVerse Git workflow roadmap

Priorities are based on protecting repository state, frequency of use, and dependencies between workflows. “Done” means the workflow exists in the source tree and its relevant automated check passed; packaged-app behavior remains separate.

1. **Done — Partial staging:** stage and unstage individual text hunks; reject stale diffs and mode changes. Line selection remains a follow-up.
2. **Done — Status and conflict guidance:** explain upstream divergence, local changes, operation progress, and the next safe action; label pull separately from fetch.
3. **Done — Recovery:** inspect reflog entries and checkpoints, copy hashes, and navigate reachable commits without performing a reset.
4. **Implemented; package check pending — Windows terminal:** use a real PTY and verify shell input, output, and resize in Electron. The installed package still needs a build smoke check.
5. **Done — Stash lifecycle:** apply, pop, and drop a selected stash by hash, with confirmation and conflict handling.
6. **Done — Keyboard graph access:** navigate and select commits, locate HEAD, and open actions with visible focus and an accessible description.
7. **Done for inspection — Remotes and worktrees:** review sanitized remote URLs and existing worktrees. Mutation and remote-management flows remain future work.
8. **Preview only — History editing:** review and reorder a validated linear rebase plan. Applying, rewording, abort, and conflict recovery are not implemented.
9. **Backlog — Advanced repository support:** assess Git LFS, submodules, and hosting integration against actual product requirements before implementation.

Keep Liquid Glass on application chrome and preserve clear diff text and meaningful status labels. QA uses `.agents/skills/gitverse-qa/SKILL.md`; tests must never modify the user's working repository.
