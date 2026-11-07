import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  checkAppUpdate,
  checkForRelease,
  downloadMacUpdate,
  isReleaseDownloadUrl,
  listReleases,
  newerRelease,
  RELEASES_URL,
} from './updates';

const release = (tag_name: string) => ({ tag_name, draft: false, prerelease: false });

test('downloads only the matching Mac installer and verifies its contents', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'gitverse-update-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const bytes = Buffer.from('installer');
  const digest = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
  const calls: string[] = [];
  const fetchRelease: typeof fetch = async (url) => {
    calls.push(String(url));
    if (calls.length === 1)
      return Response.json({
        ...release('v2.0.0'),
        assets: [{ name: 'GITVerse-2.0.0-mac-arm64.dmg', size: bytes.length, digest }],
      });
    if (calls.length === 2)
      return new Response(null, {
        status: 302,
        headers: { location: 'https://release-assets.githubusercontent.com/file' },
      });
    return new Response(bytes);
  };
  const percentages: number[] = [];
  const file = await downloadMacUpdate('2.0.0', 'arm64', dir, (percent) => percentages.push(percent), fetchRelease);
  assert.deepEqual(await readFile(file), bytes);
  assert.equal(percentages.at(-1), 100);
  assert.match(calls[1], /GITVerse-2\.0\.0-mac-arm64\.dmg$/);
});

test('rejects a corrupt installer and removes the partial download', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'gitverse-update-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  let calls = 0;
  const fetchRelease: typeof fetch = async () => {
    if (++calls === 1)
      return Response.json({
        ...release('v2.0.0'),
        assets: [{ name: 'GITVerse-2.0.0-mac-x64.dmg', size: 3, digest: `sha256:${'0'.repeat(64)}` }],
      });
    return new Response('bad');
  };
  await assert.rejects(
    downloadMacUpdate('2.0.0', 'x64', dir, () => {}, fetchRelease),
    /verification failed/,
  );
  assert.deepEqual(await readdir(dir), []);
});

test('rejects installer redirects to other hosts', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'gitverse-update-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  let calls = 0;
  const fetchRelease: typeof fetch = async () => {
    if (++calls === 1)
      return Response.json({
        ...release('v2.0.0'),
        assets: [{ name: 'GITVerse-2.0.0-mac-x64.dmg', size: 3, digest: `sha256:${'0'.repeat(64)}` }],
      });
    return new Response(null, { status: 302, headers: { location: 'https://example.com/file' } });
  };
  await assert.rejects(
    downloadMacUpdate('2.0.0', 'x64', dir, () => {}, fetchRelease),
    /Invalid installer download address/,
  );
  assert.equal(calls, 2);
});

test('compares semantic versions rather than strings', () => {
  assert.deepEqual(newerRelease(release('v0.10.0'), '0.9.9'), {
    version: '0.10.0',
    url: `${RELEASES_URL}/tag/v0.10.0`,
  });
  assert.equal(newerRelease(release('v0.9.9'), '0.10.0'), null);
  assert.equal(newerRelease(release('v1.0.0'), '1.0.0'), null);
  assert.equal(newerRelease(release('v1.0.0+build.2'), '1.0.0+build.1'), null);
});

test('ignores drafts and prereleases', () => {
  assert.equal(newerRelease({ ...release('v2.0.0'), draft: true }, '1.0.0'), null);
  assert.equal(newerRelease({ ...release('v2.0.0'), prerelease: true }, '1.0.0'), null);
  assert.equal(newerRelease(release('v2.0.0-beta.1'), '1.0.0'), null);
});

test('rejects invalid versions and malformed responses', () => {
  assert.throws(() => newerRelease(release('latest'), '1.0.0'));
  assert.throws(() => newerRelease(release('v2.0.0'), 'invalid'));
  assert.throws(() => newerRelease({ tag_name: 'v2.0.0' }, '1.0.0'));
  assert.throws(() => newerRelease(null, '1.0.0'));
});

test('does not trust release URLs returned by the API', () => {
  const result = newerRelease({ ...release('v2.0.0'), html_url: 'https://example.com' }, '1.0.0');
  assert.equal(result?.url, `${RELEASES_URL}/tag/v2.0.0`);
});

test('only opens valid release-version URLs for the configured repository', () => {
  assert.equal(isReleaseDownloadUrl(`${RELEASES_URL}/tag/v2.0.0`), true);
  for (const url of [
    'javascript:alert(1)',
    'https://example.com',
    `${RELEASES_URL}/tag/latest`,
    `${RELEASES_URL}/tag/v2.0.0?redirect=1`,
    `${RELEASES_URL}/tag/v2.0.0/extra`,
    'https://user@github.com/prapawity/GITVerse/releases/tag/v2.0.0',
  ])
    assert.equal(isReleaseDownloadUrl(url), false);
});

test('requests only the configured repository with a timeout and no redirects', async () => {
  const mock: typeof fetch = async (url, options) => {
    assert.equal(url, 'https://api.github.com/repos/prapawity/GITVerse/releases/latest');
    assert.equal(options?.redirect, 'error');
    assert.ok(options?.signal);
    return Response.json(release('v2.0.0'));
  };
  assert.equal((await checkForRelease('1.0.0', mock))?.version, '2.0.0');
});

test('handles a repository without releases', async () => {
  assert.equal(await checkForRelease('1.0.0', async () => new Response(null, { status: 404 })), null);
});

test('lists stable versions in order and constructs trusted download links', async () => {
  const versions = await listReleases(async (url, options) => {
    assert.equal(url, 'https://api.github.com/repos/prapawity/GITVerse/releases?per_page=100&page=1');
    assert.equal(options?.redirect, 'error');
    return Response.json([
      { ...release('v1.2.0'), html_url: 'https://example.com' },
      release('v1.10.0'),
      release('v2.0.0-beta.1'),
      { ...release('v3.0.0'), draft: true },
      release('not-a-version'),
    ]);
  });
  assert.deepEqual(versions, [
    { version: '1.10.0', url: `${RELEASES_URL}/tag/v1.10.0` },
    { version: '1.2.0', url: `${RELEASES_URL}/tag/v1.2.0` },
  ]);
});

test('loads older releases from the next page', async () => {
  const requested: string[] = [];
  const versions = await listReleases(async (url) => {
    requested.push(String(url));
    return Response.json(
      requested.length === 1
        ? Array.from({ length: 100 }, (_, index) => release(`v1.0.${index + 1}`))
        : [release('v1.0.0')],
    );
  });
  assert.equal(requested.length, 2);
  assert.match(requested[1], /page=2$/);
  assert.equal(versions.length, 101);
  assert.equal(versions.at(-1)?.version, '1.0.0');
});

test('development update checks never call the network', async () => {
  let requests = 0;
  const result = await checkAppUpdate('1.0.0', false, async () => {
    requests++;
    return Response.json(release('v2.0.0'));
  });
  assert.deepEqual(result, { kind: 'development', currentVersion: '1.0.0' });
  assert.equal(requests, 0);
});

test('packaged checks distinguish optional updates, current versions, and recoverable errors', async () => {
  assert.deepEqual(await checkAppUpdate('1.0.0', true, async () => Response.json(release('v2.0.0'))), {
    kind: 'optional',
    currentVersion: '1.0.0',
    version: '2.0.0',
    url: `${RELEASES_URL}/tag/v2.0.0`,
  });
  assert.deepEqual(await checkAppUpdate('2.0.0', true, async () => Response.json(release('v2.0.0'))), {
    kind: 'current',
    currentVersion: '2.0.0',
  });
  assert.deepEqual(
    await checkAppUpdate('1.0.0', true, async () => {
      throw new Error('Offline');
    }),
    {
      kind: 'error',
      currentVersion: '1.0.0',
      message: 'Offline',
    },
  );
});

test('surfaces HTTP, network, JSON, and timeout failures', async () => {
  await assert.rejects(
    checkForRelease('1.0.0', async () => new Response(null, { status: 403 })),
    /HTTP 403/,
  );
  await assert.rejects(
    checkForRelease('1.0.0', async () => {
      throw new Error('Offline');
    }),
    /Offline/,
  );
  await assert.rejects(checkForRelease('1.0.0', async () => new Response('invalid json')));
  await assert.rejects(
    checkForRelease('1.0.0', async () => {
      throw new DOMException('Timed out', 'TimeoutError');
    }),
    /Timed out/,
  );
});
