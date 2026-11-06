# Contributing

Thank you for helping improve GITVerse.

1. Open an issue describing the problem or proposed change before large changes.
2. Fork the repository and create a `feature/<description>` branch from `develop` for one focused change. Target pull requests at `develop`, not `main`.
3. Use Node.js 22.12+, install with `npm ci`, and run with `npm run dev`.
4. Follow existing React/TypeScript patterns. Keep Git and privileged operations in the main process, not the renderer.
5. Add regression tests for changed logic, then run `npm test` and `npm run build`.
6. For UI changes, include screenshots for relevant themes/window sizes. For Git changes, test on a disposable repository, never valuable uncommitted work.
7. Open a pull request describing behavior, validation, limitations, and related issues.

Do not commit build outputs, installers, local state, credentials, or private repository data. Keep `package-lock.json` in sync with dependency changes.

Contributions are provided under the project's [MIT license](./LICENSE). Only contribute material you have the right to redistribute. Check third-party licenses before adding assets, skills, or copied code.

Report vulnerabilities privately as described in [SECURITY.md](./SECURITY.md), not in public issues.

## Git Flow

- `main` contains the production baseline and finished releases.
- `develop` integrates work for the next release.
- `feature/*` branches start from `develop` and merge back through reviewed pull requests.
- `release/<version>` branches start from `develop` for stabilization, then merge into `main` and back into `develop`. Tag the production merge as `vX.Y.Z`.
- `hotfix/<version>` branches start from `main` for urgent production fixes, then merge into both `main` and `develop`.

The initial `main` baseline contains project documentation only; the application is integrated into `develop` until its first release is ready. Do not tag an unfinished development snapshot.

Local assistant skills under `.claude/` are excluded from this repository; they are not required to build or run the application.
