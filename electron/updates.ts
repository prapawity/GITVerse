import { gt, prerelease, valid } from 'semver';
import { z } from 'zod';

export const RELEASES_URL = 'https://github.com/prapawity/GITVerse/releases';
const RELEASE_API = 'https://api.github.com/repos/prapawity/GITVerse/releases/latest';
const releaseSchema = z.object({
  tag_name: z.string(),
  draft: z.boolean(),
  prerelease: z.boolean(),
});

export interface ReleaseUpdate {
  version: string;
  url: string;
}

export function newerRelease(payload: unknown, current: string): ReleaseUpdate | null {
  const release = releaseSchema.parse(payload);
  const currentVersion = valid(current);
  const version = valid(release.tag_name);
  if (!currentVersion || !version) throw new Error('Invalid application or release version.');
  if (release.draft || release.prerelease || prerelease(version) || !gt(version, currentVersion)) return null;
  return { version, url: `${RELEASES_URL}/tag/${encodeURIComponent(release.tag_name)}` };
}

export async function checkForRelease(current: string, fetchRelease: typeof fetch = fetch): Promise<ReleaseUpdate | null> {
  const response = await fetchRelease(RELEASE_API, {
    headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'GITVerse', 'X-GitHub-Api-Version': '2022-11-28' },
    signal: AbortSignal.timeout(10_000),
    redirect: 'error',
  });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`GitHub release check failed (HTTP ${response.status}).`);
  return newerRelease(await response.json(), current);
}
