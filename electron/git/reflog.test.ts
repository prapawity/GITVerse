import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { reflog } from './reflog';

const run = promisify(execFile);

test('reads HEAD reflog including unreachable commits without changing repository state', async (t) => {
  const cwd = await mkdtemp(path.join(tmpdir(), 'gitverse-reflog-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const git = async (...args: string[]) => (await run('git', args, { cwd })).stdout.trim();
  await git('init', '--quiet');
  assert.deepEqual(await reflog(cwd), []);
  const commit = async (message: string) =>
    git(
      '-c',
      'user.name=QA',
      '-c',
      'user.email=qa@example.com',
      'commit',
      '--allow-empty',
      '--no-gpg-sign',
      '-m',
      message,
    );
  await commit('First');
  const first = await git('rev-parse', 'HEAD');
  await commit('Second');
  const second = await git('rev-parse', 'HEAD');
  await git('reset', '--hard', first);
  await writeFile(path.join(cwd, 'untracked.txt'), 'keep');
  const before = await git('status', '--porcelain=v2');
  const entries = await reflog(cwd);
  assert.ok(entries.some((entry) => entry.hash === second && entry.message.includes('Second')));
  assert.ok(entries.some((entry) => entry.hash === first && entry.message.includes('reset')));
  assert.match(entries[0].selector, /^HEAD@\{/);
  assert.equal(await git('status', '--porcelain=v2'), before);
  assert.equal(await git('rev-parse', 'HEAD'), first);
});
