# Security

GITVerse is experimental. Use the latest published release; no older release line currently receives security backports.

## Reporting a vulnerability

Do not post exploit details, credentials, or private repository data in public issues.

Use the repository's [private vulnerability reporting page](https://github.com/prapawity/GITVerse/security/advisories/new) when enabled. The maintainer must enable private vulnerability reporting in GitHub repository settings before public launch. If the private form is unavailable, open a public issue requesting a private contact channel without disclosing vulnerability details.

Include affected versions, operating system, impact, and minimal reproduction steps using a disposable repository. Remove secrets and personal information.

## Trust boundaries

The CI dependency-security job runs `npm run security:audit` against the public npm registry and fails on high/critical advisories, including build tools; this check is not marked as allowed-to-fail. The current lockfile passes a clean-install audit after upgrading Electron/Vite and overriding vulnerable nested Zod/minimatch versions. Review and remove overrides when upstream ranges include the fixes. Dependabot proposes weekly dependency and GitHub Actions updates against `develop`. These checks detect known dependency advisories, not all source vulnerabilities or leaked secrets; a clean result can change as new advisories are published.

- Git operations and the integrated terminal execute with the user's OS permissions. Only open repositories you trust; Git hooks and local configuration can execute programs.
- Force push requires explicit confirmation and uses a target-specific `--force-with-lease` with the remote-tracking hash captured when the Push dialog opened, never unconditional `--force`. A changed remote rejects the push; this protects against concurrent updates but does not prevent intentionally replacing remote-only commits already covered by the confirmed lease. Fetch and review remote history before retrying a stale lease. Server-side branch protections are not bypassed.
- AI features can send code and repository metadata to the selected external provider.
- Initial installers are unsigned; release checks only notify and open the configured GitHub release page. They do not authenticate or install binaries.
- Never store secrets in source or commit application user-data files.
