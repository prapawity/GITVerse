/** LFS, submodules, worktree remove/lock, patches, range diffs and maintenance against real repositories. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import * as git from './git';

const run = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'commit.gpgsign=false', '-c', 'protocol.file.allow=always', ...args], {
    cwd,
    encoding: 'utf8',
  }).trim();

function repo(name = 'gitverse-extras-') {
  const dir = mkdtempSync(path.join(tmpdir(), name));
  run(dir, 'init', '-q', '-b', 'main');
  run(dir, 'config', 'user.name', 'Test');
  run(dir, 'config', 'user.email', 'test@example.com');
  run(dir, 'config', 'commit.gpgsign', 'false');
  return dir;
}
const commit = (dir: string, file: string, text: string, message: string) => {
  writeFileSync(path.join(dir, file), text);
  run(dir, 'add', '.');
  run(dir, 'commit', '-q', '-m', message);
  return run(dir, 'rev-parse', 'HEAD');
};

test('combined diff of a range and patch round-trip', async () => {
  const dir = repo();
  const first = commit(dir, 'a.txt', 'one\n', 'first');
  commit(dir, 'a.txt', 'one\ntwo\n', 'second');
  const third = commit(dir, 'b.txt', 'b\n', 'third');
  const files = await git.rangeFiles(dir, first, third);
  assert.deepEqual(files.map((f) => `${f.status} ${f.path}`).sort(), ['A a.txt', 'A b.txt']);
  const second = run(dir, 'rev-parse', 'HEAD~1');
  const diff = await git.rangeFileDiff(dir, second, third, 'a.txt');
  assert.match(diff, /\+two/);
  const patch = await git.rangePatch(dir, second, third);
  run(dir, 'reset', '-q', '--hard', first);
  await git.applyPatch(dir, patch, 'check');
  await git.applyPatch(dir, patch, 'apply');
  assert.match(run(dir, 'status', '--porcelain'), /a\.txt/);
  await assert.rejects(git.applyPatch(dir, 'not a patch', 'check'));
});

test('git am keeps commits from a format-patch file', async () => {
  const dir = repo();
  const base = commit(dir, 'a.txt', 'one\n', 'first');
  commit(dir, 'a.txt', 'one\ntwo\n', 'add two');
  const mail = run(dir, 'format-patch', '-1', '--stdout', 'HEAD');
  run(dir, 'reset', '-q', '--hard', base);
  await git.applyPatch(dir, `${mail}\n`, 'am');
  assert.equal(run(dir, 'log', '-1', '--format=%s'), 'add two');
});

test('worktree lock, unlock and remove with branch', async () => {
  const dir = repo();
  commit(dir, 'a.txt', 'a\n', 'first');
  const wt = path.join(mkdtempSync(path.join(tmpdir(), 'gitverse-wt-')), 'side');
  run(dir, 'worktree', 'add', '-q', '-b', 'side', wt);
  const listed = run(dir, 'worktree', 'list', '--porcelain')
    .split('\n')
    .filter((l) => l.startsWith('worktree '))
    .map((l) => l.slice(9))[1];
  await git.worktreeLock(dir, listed, true);
  assert.match(run(dir, 'worktree', 'list', '--porcelain'), /locked/);
  await git.worktreeLock(dir, listed, false);
  await git.worktreeRemove(dir, listed, false, 'side');
  assert.ok(!existsSync(wt));
  assert.doesNotMatch(run(dir, 'branch'), /side/);
  await assert.rejects(git.worktreeRemove(dir, '/not/a/worktree'));
});

test('submodules are listed and updated', async () => {
  const lib = repo('gitverse-lib-');
  commit(lib, 'lib.txt', 'lib\n', 'lib');
  const dir = repo();
  commit(dir, 'a.txt', 'a\n', 'first');
  run(dir, 'submodule', 'add', '-q', lib, 'libs/lib');
  run(dir, 'commit', '-q', '-m', 'add submodule');
  run(dir, 'submodule', 'deinit', '-q', '-f', 'libs/lib');
  assert.equal((await git.submodules(dir))[0]?.state, 'uninitialized');
  process.env.GIT_CONFIG_COUNT = '1';
  process.env.GIT_CONFIG_KEY_0 = 'protocol.file.allow';
  process.env.GIT_CONFIG_VALUE_0 = 'always';
  try {
    await git.submoduleUpdate(dir, null);
  } finally {
    delete process.env.GIT_CONFIG_COUNT;
    delete process.env.GIT_CONFIG_KEY_0;
    delete process.env.GIT_CONFIG_VALUE_0;
  }
  assert.equal((await git.submodules(dir))[0]?.state, 'ok');
});

test('maintenance reports sizes; external tool needs a configured tool', async () => {
  const dir = repo();
  commit(dir, 'a.txt', 'a\n', 'first');
  const result = await git.maintenance(dir);
  assert.equal(typeof result.beforeKiB, 'number');
  run(dir, 'config', 'diff.tool', '');
  await assert.rejects(git.externalTool(dir, 'diff', 'a.txt'), /No external diff tool/);
  await assert.rejects(git.setExternalToolConfig(dir, { diff: 'rm -rf', merge: '' }));
});

test('git lfs status (skipped when git-lfs is not installed)', async (t) => {
  const dir = repo();
  commit(dir, 'a.txt', 'a\n', 'first');
  const status = await git.lfsStatus(dir);
  if (!status.installed) return t.skip('git-lfs not installed');
  await git.lfsAction(dir, 'install');
  await git.lfsAction(dir, 'track', '*.bin');
  assert.ok((await git.lfsStatus(dir)).patterns.includes('*.bin'));
  await assert.rejects(git.lfsAction(dir, 'track', '--evil'));
});

test('a failing git am is aborted, not left half-applied', async () => {
  const dir = repo();
  const base = commit(dir, 'a.txt', 'one\n', 'first');
  commit(dir, 'a.txt', 'one\ntwo\n', 'add two');
  const mail = run(dir, 'format-patch', '-1', '--stdout', 'HEAD');
  run(dir, 'reset', '-q', '--hard', base);
  commit(dir, 'a.txt', 'completely different\n', 'conflict');
  await assert.rejects(git.applyPatch(dir, `${mail}\n`, 'am'), /Nothing was applied/);
  assert.ok(!existsSync(path.join(dir, '.git', 'rebase-apply')));
});

test('AI material: branch diff and working diff', async () => {
  const dir = repo();
  commit(dir, 'a.txt', 'one\n', 'first');
  run(dir, 'checkout', '-q', '-b', 'topic');
  commit(dir, 'b.txt', 'b\n', 'add b');
  const branch = await git.branchDiff(dir, 'main', 'topic');
  assert.match(branch.commits, /- add b/);
  assert.match(branch.diff, /\+b/);
  await assert.rejects(git.branchDiff(dir, '--evil', 'topic'));
  writeFileSync(path.join(dir, 'a.txt'), 'one\ntwo\n');
  writeFileSync(path.join(dir, 'new.txt'), 'n\n');
  const working = await git.workingDiff(dir);
  assert.match(working.diff, /\+two/);
  assert.deepEqual(working.untracked, ['new.txt']);
});
