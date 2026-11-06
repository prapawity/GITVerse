# Contributing

Thank you for helping improve GITVerse.

1. Open an issue describing the problem or proposed change before large changes.
2. Fork the repository and create a `feature/<description>` branch from `develop` for one focused change. Target pull requests at `develop`, not `main`.
3. Use Node.js 22.12+, install with `npm ci`, and run with `npm run dev`.
4. Follow existing React/TypeScript patterns. Keep Git and privileged operations in the main process, not the renderer.
5. Add regression tests for changed logic, then run `npm test` and `npm run build`.
6. For UI changes, include screenshots for relevant themes/window sizes. For Git changes, test on a disposable repository, never valuable uncommitted work.
7. Complete the documentation checkpoint below before every push or pull request. Open a pull request describing behavior, documentation, validation, limitations, and related issues.

Do not commit build outputs, installers, local state, credentials, or private repository data. Keep `package-lock.json` in sync with dependency changes.

Contributions are provided under the project's [MIT license](./LICENSE). Only contribute material you have the right to redistribute. Check third-party licenses before adding assets, skills, or copied code.

Report vulnerabilities privately as described in [SECURITY.md](./SECURITY.md), not in public issues.

## Mandatory documentation checkpoint

Before every push and before opening or updating a pull request, review the complete outgoing diff and check all related documentation against the implementation. Update missing, stale, or misleading documentation in the same branch before proceeding.

Review [README.md](./README.md) for features, UI behavior, setup, and commands; [ARCHITECTURE.md](./ARCHITECTURE.md) for modules and data flow; [RELEASING.md](./RELEASING.md) for packaging and updates; and [SECURITY.md](./SECURITY.md) for security/privacy guidance, as applicable. Update other directly related documentation when needed.

If existing documentation remains accurate, do not add cosmetic edits: state which documents were reviewed and why no update was necessary. Every PR and push handoff must summarize this check alongside validation results. Use the repository's [PR template](./.github/pull_request_template.md).

This checkpoint is a contributor and agent workflow rule, not an automated Git hook or CI enforcement.

## Git Flow

- `main` contains the production baseline and finished releases.
- `develop` integrates work for the next release.
- `feature/*` branches start from `develop` and merge back through reviewed pull requests.
- `release/<version>` branches start from `develop` for stabilization, then merge into `main` and back into `develop`. Tag the production merge as `vX.Y.Z`.
- `hotfix/<version>` branches start from `main` for urgent production fixes, then merge into both `main` and `develop`.

The initial `main` baseline contains project documentation only; the application is integrated into `develop` until its first release is ready. Do not tag an unfinished development snapshot.

Local assistant skills under `.claude/` are excluded from this repository; they are not required to build or run the application.
