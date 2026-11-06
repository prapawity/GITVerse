import assert from 'node:assert/strict';
import test from 'node:test';
import { checkForRelease, newerRelease, RELEASES_URL } from './updates';

const release = (tag_name: string) => ({ tag_name, draft: false, prerelease: false });

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
