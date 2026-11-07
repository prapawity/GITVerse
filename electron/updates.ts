import { gt, prerelease, rcompare, valid } from 'semver';
import { z } from 'zod';
import { createHash } from 'node:crypto';
import { mkdtemp, open, rm } from 'node:fs/promises';
import path from 'node:path';
import type { AppUpdateCheck, ReleaseUpdate } from '../src/shared/updates';

export const RELEASES_URL = 'https://github.com/prapawity/GITVerse/releases';
const RELEASE_API = 'https://api.github.com/repos/prapawity/GITVerse/releases/latest';
const releaseSchema = z.object({
  tag_name: z.string(),
  draft: z.boolean(),
  prerelease: z.boolean(),
});

export async function downloadMacUpdate(
  version: string,
  arch: string,
  downloads: string,
  progress: (percent: number) => void,
  fetchRelease: typeof fetch = fetch,
): Promise<string> {
  if (valid(version) !== version || prerelease(version) || !['arm64', 'x64'].includes(arch))
    throw new Error('Invalid update version or architecture.');
  const response = await fetchRelease(RELEASE_API, {
    headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'GITVerse', 'X-GitHub-Api-Version': '2022-11-28' },
    signal: AbortSignal.timeout(10_000),
    redirect: 'error',
  });
  if (!response.ok) throw new Error(`GitHub release check failed (HTTP ${response.status}).`);
  const release = releaseSchema
    .extend({
      assets: z.array(z.object({ name: z.string(), size: z.number().int().positive(), digest: z.string().nullable() })),
    })
    .parse(await response.json());
  if (release.draft || release.prerelease || valid(release.tag_name) !== version)
    throw new Error('The latest release has changed. Check for updates again.');
  const name = `GITVerse-${version}-mac-${arch}.dmg`;
  const asset = release.assets.find((item) => item.name === name);
  if (!asset || !asset.digest || !/^sha256:[a-f0-9]{64}$/i.test(asset.digest) || asset.size > 1024 ** 3)
    throw new Error('A verified installer for this Mac is not available.');
  let url = `${RELEASES_URL}/download/${encodeURIComponent(release.tag_name)}/${name}`;
  let download: Response | undefined;
  const signal = AbortSignal.timeout(10 * 60_000);
  for (let redirects = 0; redirects < 5; redirects++) {
    const target = new URL(url);
    if (
      target.protocol !== 'https:' ||
      target.username ||
      target.password ||
      target.port ||
      !['github.com', 'release-assets.githubusercontent.com'].includes(target.hostname)
    )
      throw new Error('Invalid installer download address.');
    download = await fetchRelease(url, { signal, redirect: 'manual' });
    if (![301, 302, 303, 307, 308].includes(download.status)) break;
    const location = download.headers.get('location');
    await download.body?.cancel();
    if (!location) throw new Error('Invalid installer redirect.');
    url = new URL(location, url).href;
    download = undefined;
  }
  if (!download?.ok || !download.body) throw new Error('Could not download the installer.');
  const directory = await mkdtemp(path.join(downloads, 'GITVerse-update-'));
  const file = path.join(directory, name);
  try {
    const handle = await open(file, 'wx');
    const hash = createHash('sha256');
    let received = 0;
    const reader = download.body.getReader();
    try {
      while (true) {
        const { done, value: chunk } = await reader.read();
        if (done) break;
        received += chunk.length;
        if (received > asset.size) throw new Error('Installer size does not match the release.');
        hash.update(chunk);
        await handle.writeFile(chunk);
        progress((received / asset.size) * 100);
      }
    } finally {
      try {
        await reader.cancel();
      } finally {
        await handle.close();
      }
    }
    if (received !== asset.size || `sha256:${hash.digest('hex')}` !== asset.digest.toLowerCase())
      throw new Error('Installer verification failed. Please retry.');
    return file;
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}

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
