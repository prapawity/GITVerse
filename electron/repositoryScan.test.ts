import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { scanRepositories } from './repositoryScan';
import type { ScanProgress } from '../src/shared/repositoryScan';

const run = promisify(execFile);
const scan = (root: string) => scanRepositories(root, new AbortController().signal, () => {});

test('finds repositories beyond five levels and 5,000 folders', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'gitverse-scan-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (let start = 0; start < 5005; start += 100) {
    await Promise.all(
      Array.from({ length: Math.min(100, 5005 - start) }, (_, i) => mkdir(path.join(root, `folder-${start + i}`))),
    );
  }
  const deep = path.join(root, 'folder-0', ...Array.from({ length: 8 }, (_, i) => `level-${i}`));
  await mkdir(deep, { recursive: true });
  await run('git', ['init', '--quiet', deep]);
  const progress: ScanProgress[] = [];
  const result = await scanRepositories(root, new AbortController().signal, (value) => progress.push(value));
  assert.deepEqual(result.repos, [deep]);
  assert.equal(result.cancelled, false);
  assert.equal(result.skipped, 0);
  assert.ok(progress.at(-1)!.scanned > 5000);
  assert.equal(progress.at(-1)!.repositories, 1);
});

test('skips hidden/dependency folders, finds worktrees and reports invalid repositories', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'gitverse-scan-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repo = path.join(root, 'repo');
  await run('git', ['init', '--quiet', repo]);
  await run('git', [
    '-C',
    repo,
    '-c',
    'user.name=Test',
    '-c',
    'user.email=test@example.com',
    'commit',
    '--allow-empty',
    '--no-gpg-sign',
    '-m',
    'Initial',
  ]);
  const worktree = path.join(root, 'worktree');
  await run('git', ['-C', repo, 'worktree', 'add', '--quiet', '--detach', worktree]);
  for (const name of ['.hidden', 'node_modules', 'vendor', 'dist', 'build']) {
    await mkdir(path.join(root, name));
    await run('git', ['init', '--quiet', path.join(root, name, 'ignored')]);
  }
  await mkdir(path.join(root, 'invalid'));
  await writeFile(path.join(root, 'invalid', '.git'), 'not a git directory');
  const result = await scan(root);
  assert.deepEqual(result.repos.sort(), [repo, worktree].sort());
  assert.equal(result.skipped, 1);
});

test('does not follow directory symlinks or cycles', { skip: process.platform === 'win32' }, async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'gitverse-scan-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await symlink(root, path.join(root, 'cycle'), 'dir');
  const result = await scan(root);
  assert.deepEqual(result.repos, []);
  assert.equal(result.cancelled, false);
});

test('honors cancellation before traversing folders', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'gitverse-scan-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const controller = new AbortController();
  const result = await scanRepositories(root, controller.signal, () => controller.abort());
  assert.equal(result.cancelled, true);
  assert.deepEqual(result.repos, []);
});

test('rejects invalid input and unreadable roots instead of reporting success', async (t) => {
  await assert.rejects(scan('relative/path'), /Choose a valid folder/);
  const root = await mkdtemp(path.join(tmpdir(), 'gitverse-scan-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await assert.rejects(scan(path.join(root, 'missing')), /Could not read the dropped folder/);
});
