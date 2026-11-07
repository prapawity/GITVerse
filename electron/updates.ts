import { gt, prerelease, rcompare, valid } from 'semver';
import { z } from 'zod';
import type { AppUpdateCheck, ReleaseUpdate } from '../src/shared/updates';

export const RELEASES_URL = 'https://github.com/prapawity/GITVerse/releases';
const RELEASE_API = 'https://api.github.com/repos/prapawity/GITVerse/releases/latest';
const releaseSchema = z.object({
  tag_name: z.string(),
  draft: z.boolean(),
  prerelease: z.boolean(),
});

export async function listReleases(fetchRelease: typeof fetch = fetch): Promise<ReleaseUpdate[]> {
  const releases: ReleaseUpdate[] = [];
  for (let page = 1; page <= 10; page++) {
    const response = await fetchRelease(
      `https://api.github.com/repos/prapawity/GITVerse/releases?per_page=100&page=${page}`,
      {
        headers: {
          Accept: 'application/vnd.github+json',
          'User-Agent': 'GITVerse',
          'X-GitHub-Api-Version': '2022-11-28',
        },
        signal: AbortSignal.timeout(10_000),
        redirect: 'error',
      },
    );
    if (response.status === 404) break;
    if (!response.ok) throw new Error(`GitHub release list failed (HTTP ${response.status}).`);
    const entries = z.array(releaseSchema).parse(await response.json());
    for (const release of entries) {
      const version = valid(release.tag_name);
      if (version && !release.draft && !release.prerelease && !prerelease(version))
        releases.push({ version, url: `${RELEASES_URL}/tag/${encodeURIComponent(release.tag_name)}` });
    }
    if (entries.length < 100) break;
  }
  return releases.sort((a, b) => rcompare(a.version, b.version));
}

export function isReleaseDownloadUrl(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  try {
    const url = new URL(value);
    const prefix = '/prapawity/GITVerse/releases/tag/';
    return (
      url.origin === 'https://github.com' &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash &&
      url.pathname.startsWith(prefix) &&
      !!valid(decodeURIComponent(url.pathname.slice(prefix.length)))
    );
  } catch {
    return false;
  }
}

export function newerRelease(payload: unknown, current: string): ReleaseUpdate | null {
  const release = releaseSchema.parse(payload);
  const currentVersion = valid(current);
  const version = valid(release.tag_name);
  if (!currentVersion || !version) throw new Error('Invalid application or release version.');
  if (release.draft || release.prerelease || prerelease(version) || !gt(version, currentVersion)) return null;
  return { version, url: `${RELEASES_URL}/tag/${encodeURIComponent(release.tag_name)}` };
}

export async function checkForRelease(
  current: string,
  fetchRelease: typeof fetch = fetch,
): Promise<ReleaseUpdate | null> {
  const response = await fetchRelease(RELEASE_API, {
    headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'GITVerse', 'X-GitHub-Api-Version': '2022-11-28' },
    signal: AbortSignal.timeout(10_000),
    redirect: 'error',
  });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`GitHub release check failed (HTTP ${response.status}).`);
  return newerRelease(await response.json(), current);
}

export async function checkAppUpdate(
  current: string,
  packaged: boolean,
  fetchRelease: typeof fetch = fetch,
): Promise<AppUpdateCheck> {
  if (!packaged) return { kind: 'development', currentVersion: current };
  try {
    const release = await checkForRelease(current, fetchRelease);
    return release
      ? { kind: 'optional', currentVersion: current, ...release }
      : { kind: 'current', currentVersion: current };
  } catch (error) {
    return { kind: 'error', currentVersion: current, message: error instanceof Error ? error.message : String(error) };
  }
}
