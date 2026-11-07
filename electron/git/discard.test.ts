import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import { promisify } from 'node:util';
import { discardWorkingFiles, discardWorkingHunk, fileChangeCounts, workingFileDiff } from './git';

const run = promisify(execFile);
const original = Array.from({ length: 40 }, (_, index) => `line ${index + 1}`).join('\n') + '\n';
async function fixture(t: TestContext) {
  const cwd = await mkdtemp(path.join(tmpdir(), 'gitverse-discard-test-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const command = async (...args: string[]) => (await run('git', args, { cwd })).stdout;
  await command('init', '--quiet', '-b', 'main');
  await command('config', 'user.name', 'Test');
  await command('config', 'user.email', 'test@example.com');
  await command('config', 'commit.gpgSign', 'false');
  await command('config', 'core.autocrlf', 'false');
  await writeFile(path.join(cwd, 'one.txt'), original);
  await writeFile(path.join(cwd, 'literal[1].txt'), 'original\n');
  await writeFile(path.join(cwd, 'literal1.txt'), 'untouched\n');
  await command('add', '.');
  await command('commit', '-m', 'Fixture');
  const snapshot = async (file: string, area: 'unstaged' | 'untracked' = 'unstaged') => ({
    path: file,
    area,
    diff: await workingFileDiff(cwd, file, area),
  });
  return { cwd, command, snapshot };
}

test('discard multiple files preserves staged content and unrelated literal-path files', async (t) => {
  const { cwd, command, snapshot } = await fixture(t);
  await writeFile(path.join(cwd, 'one.txt'), 'staged\n');
  await command('add', 'one.txt');
  await writeFile(path.join(cwd, 'one.txt'), 'unstaged\n');
  await writeFile(path.join(cwd, 'literal[1].txt'), 'changed\n');
  await writeFile(path.join(cwd, 'literal1.txt'), 'keep this change\n');
  await writeFile(path.join(cwd, 'new.txt'), 'untracked\n');
  await discardWorkingFiles(cwd, [
    await snapshot('one.txt'),
    await snapshot('literal[1].txt'),
    await snapshot('new.txt', 'untracked'),
  ]);
  assert.equal(await readFile(path.join(cwd, 'one.txt'), 'utf8'), 'staged\n');
  assert.equal(await command('show', ':one.txt'), 'staged\n');
  assert.equal(await readFile(path.join(cwd, 'literal[1].txt'), 'utf8'), 'original\n');
  assert.equal(await readFile(path.join(cwd, 'literal1.txt'), 'utf8'), 'keep this change\n');
  await assert.rejects(readFile(path.join(cwd, 'new.txt')), { code: 'ENOENT' });
});

test('discard a single hunk retains other hunks and the index', async (t) => {
  const { cwd, command } = await fixture(t);
  const changed = original.replace('line 2\n', 'first change\n').replace('line 35\n', 'second change\n');
  await writeFile(path.join(cwd, 'one.txt'), changed);
  const diff = await workingFileDiff(cwd, 'one.txt', 'unstaged');
  assert.equal((diff.match(/^@@ /gm) ?? []).length, 2);
  await discardWorkingHunk(cwd, 'one.txt', diff, 0);
  assert.equal(await readFile(path.join(cwd, 'one.txt'), 'utf8'), original.replace('line 35\n', 'second change\n'));
  assert.equal(await command('show', ':one.txt'), original);
  const remaining = await workingFileDiff(cwd, 'one.txt', 'unstaged');
  await discardWorkingHunk(cwd, 'one.txt', remaining, 0);
  assert.equal(await readFile(path.join(cwd, 'one.txt'), 'utf8'), original);
});

test('stale snapshots and invalid selections do not discard any files', async (t) => {
  const { cwd, snapshot } = await fixture(t);
  await writeFile(path.join(cwd, 'one.txt'), 'first\n');
  await writeFile(path.join(cwd, 'literal[1].txt'), 'second\n');
  const files = [await snapshot('one.txt'), await snapshot('literal[1].txt')];
  await writeFile(path.join(cwd, 'literal[1].txt'), 'newer change\n');
  await assert.rejects(discardWorkingFiles(cwd, files), /changed since confirmation/);
  assert.equal(await readFile(path.join(cwd, 'one.txt'), 'utf8'), 'first\n');
  await assert.rejects(discardWorkingHunk(cwd, 'literal[1].txt', files[1].diff, 0), /changed since confirmation/);
  await assert.rejects(
    discardWorkingFiles(cwd, [{ path: '../outside', area: 'untracked', diff: '' }]),
    /cannot be discarded/,
  );
  await assert.rejects(discardWorkingHunk(cwd, 'one.txt', files[0].diff, -1), /no longer available/);
});

test('hunk discard preserves missing final newlines', async (t) => {
  const { cwd, command } = await fixture(t);
  await writeFile(path.join(cwd, 'one.txt'), 'original without newline');
  await command('add', 'one.txt');
  await writeFile(path.join(cwd, 'one.txt'), 'changed without newline');
  const diff = await workingFileDiff(cwd, 'one.txt', 'unstaged');
  await discardWorkingHunk(cwd, 'one.txt', diff, 0);
  assert.equal(await readFile(path.join(cwd, 'one.txt'), 'utf8'), 'original without newline');
});

test('whole-file discard restores deleted files and deletes empty untracked files', async (t) => {
  const { cwd, snapshot } = await fixture(t);
  await rm(path.join(cwd, 'one.txt'));
  await writeFile(path.join(cwd, 'empty.txt'), '');
  await discardWorkingFiles(cwd, [await snapshot('one.txt'), await snapshot('empty.txt', 'untracked')]);
  assert.equal(await readFile(path.join(cwd, 'one.txt'), 'utf8'), original);
  await assert.rejects(readFile(path.join(cwd, 'empty.txt')), { code: 'ENOENT' });
});

test('discard rejects staged-only selections and changed untracked binary files', async (t) => {
  const { cwd, command, snapshot } = await fixture(t);
  await writeFile(path.join(cwd, 'one.txt'), 'staged only\n');
  await command('add', 'one.txt');
  await assert.rejects(
    discardWorkingFiles(cwd, [{ path: 'one.txt', area: 'unstaged', diff: '' }]),
    /no longer available/,
  );
  assert.equal(await command('show', ':one.txt'), 'staged only\n');
  await writeFile(path.join(cwd, 'binary.bin'), Buffer.from([0, 1, 2, 3]));
  const binary = await snapshot('binary.bin', 'untracked');
  await writeFile(path.join(cwd, 'binary.bin'), Buffer.from([0, 4, 5, 6]));
  await assert.rejects(discardWorkingFiles(cwd, [binary]), /changed since confirmation/);
  assert.deepEqual(await readFile(path.join(cwd, 'binary.bin')), Buffer.from([0, 4, 5, 6]));
});

test('hunk discard rejects file deletion and retains CRLF content', async (t) => {
  const { cwd, command } = await fixture(t);
  await rm(path.join(cwd, 'one.txt'));
  await assert.rejects(
    discardWorkingHunk(cwd, 'one.txt', await workingFileDiff(cwd, 'one.txt', 'unstaged'), 0),
    /whole file/,
  );
  await command('restore', '--worktree', 'one.txt');
  await command('config', 'core.autocrlf', 'false');
  await writeFile(path.join(cwd, 'one.txt'), 'original\r\nsecond\r\n');
  await command('add', 'one.txt');
  await writeFile(path.join(cwd, 'one.txt'), 'changed\r\nsecond\r\n');
  await discardWorkingHunk(cwd, 'one.txt', await workingFileDiff(cwd, 'one.txt', 'unstaged'), 0);
  assert.equal(await readFile(path.join(cwd, 'one.txt'), 'utf8'), 'original\r\nsecond\r\n');
});

test('file change counts separate staged and unstaged lines and handle untracked/binary files', async (t) => {
  const { cwd, command } = await fixture(t);
  await writeFile(path.join(cwd, 'one.txt'), original.replace('line 2\n', 'staged line\n'));
  await command('add', 'one.txt');
  await writeFile(
    path.join(cwd, 'one.txt'),
    original.replace('line 2\n', 'staged line\n').replace('line 35\n', 'new one\nnew two\n'),
  );
  await writeFile(path.join(cwd, 'new.txt'), 'one\ntwo');
  await writeFile(path.join(cwd, 'binary.bin'), Buffer.from([0, 1, 2]));
  await writeFile(path.join(cwd, 'empty.txt'), '');
  const counts = new Map((await fileChangeCounts(cwd)).map((file) => [file.path, file]));
  assert.deepEqual(counts.get('one.txt'), { path: 'one.txt', staged: 2, unstaged: 3 });
  assert.equal(counts.get('new.txt')?.unstaged, 2);
  assert.equal(counts.get('binary.bin')?.unstaged, null);
  assert.equal(counts.get('empty.txt')?.unstaged, 0);
});

test('file change counts use rename destinations and preserve tabs in filenames', async (t) => {
  const { cwd, command } = await fixture(t);
  await command('mv', 'one.txt', 'renamed.txt');
  if (process.platform !== 'win32') await writeFile(path.join(cwd, 'tab\tname.txt'), 'one\ntwo\n');
  const counts = new Map((await fileChangeCounts(cwd)).map((file) => [file.path, file]));
  assert.deepEqual(counts.get('renamed.txt'), { path: 'renamed.txt', staged: 0, unstaged: 0 });
  if (process.platform !== 'win32') assert.equal(counts.get('tab\tname.txt')?.unstaged, 2);
});
