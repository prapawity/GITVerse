import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { log, refs, stashAction, stashDetail, stashFileAt, stashFileDiff, stashRename } from './git';
import { layoutGraph, withStashes } from '../../src/lib/graphLayout';

const run = promisify(execFile);
test('stash actions target the selected saved entry after reflog renumbering', async (t) => {
  const cwd = await mkdtemp(path.join(tmpdir(), 'gitverse-stash-action-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const command = async (...args: string[]) => (await run('git', args, { cwd })).stdout.trim();
  await command('init', '--quiet', '-b', 'main');
  await command('config', 'user.name', 'Stash Test');
  await command('config', 'user.email', 'stash@example.com');
  await command('config', 'core.autocrlf', 'false');
  await writeFile(path.join(cwd, 'file.txt'), 'base\n');
  await command('add', '.');
  await command('commit', '-m', 'Base');
  await writeFile(path.join(cwd, 'file.txt'), 'older\n');
  await command('stash', 'push', '-m', 'Older');
  const older = (await refs(cwd)).stashes[0].hash!;
  await writeFile(path.join(cwd, 'file.txt'), 'newer\n');
  await command('stash', 'push', '-m', 'Newer');
  const newer = (await refs(cwd)).stashes[0].hash!;
  await stashAction(cwd, older, 'apply');
  assert.equal((await refs(cwd)).stashes.length, 2);
  assert.match(await command('diff'), /\+older/);
  await command('restore', 'file.txt');
  await stashAction(cwd, older, 'pop');
  assert.deepEqual(
    (await refs(cwd)).stashes.map((s) => s.hash),
    [newer],
  );
  assert.match(await command('diff'), /\+older/);
  await stashAction(cwd, newer, 'drop');
  assert.equal((await refs(cwd)).stashes.length, 0);
  await assert.rejects(stashAction(cwd, newer, 'drop'), /changed or is ambiguous/);
  await assert.rejects(stashAction(cwd, 'HEAD', 'apply'), /Invalid stash identity/);
});
test('conflicting stash pop keeps the saved entry', async (t) => {
  const cwd = await mkdtemp(path.join(tmpdir(), 'gitverse-stash-conflict-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const command = async (...args: string[]) => (await run('git', args, { cwd })).stdout.trim();
  await command('init', '--quiet', '-b', 'main');
  await command('config', 'user.name', 'Stash Test');
  await command('config', 'user.email', 'stash@example.com');
  await command('config', 'core.autocrlf', 'false');
  await writeFile(path.join(cwd, 'file.txt'), 'base\n');
  await command('add', '.');
  await command('commit', '-m', 'Base');
  await writeFile(path.join(cwd, 'file.txt'), 'stash change\n');
  await command('stash', 'push', '-m', 'Saved');
  const saved = (await refs(cwd)).stashes[0].hash!;
  await writeFile(path.join(cwd, 'file.txt'), 'committed change\n');
  await command('commit', '-am', 'Other');
  await assert.rejects(stashAction(cwd, saved, 'pop'));
  assert.equal((await refs(cwd)).stashes[0].hash, saved);
  assert.match(await command('status', '--porcelain'), /^UU file\.txt/m);
});
test('stash connection stays dashed through other commits until its base', () => {
  const commit = (hash: string, parents: string[], stashId?: string) => ({
    hash,
    parents,
    stashId,
    refs: [],
    author: 'Test',
    email: '',
    date: '',
    subject: hash,
  });
  const graph = layoutGraph([commit('stash', ['base'], 'stash@{0}'), commit('other', ['base']), commit('base', [])]);
  const stashLane = graph.rows[0].col;
  assert.ok(graph.rows[0].segments.some((segment) => segment.half === 'bottom' && segment.stash));
  assert.equal(graph.rows[1].segments.filter((segment) => segment.x1 === stashLane && segment.stash).length, 2);
  assert.ok(graph.rows[1].segments.some((segment) => segment.x1 !== stashLane && !segment.stash));
  assert.ok(
    graph.rows[2].segments.some((segment) => segment.x1 === stashLane && segment.half === 'top' && segment.stash),
  );
});

test('renaming a stash updates its name and moves it to the top without changing its object', async (t) => {
  const cwd = await mkdtemp(path.join(tmpdir(), 'gitverse-stash-rename-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const command = async (...args: string[]) => (await run('git', args, { cwd })).stdout.trim();
  await command('init', '--quiet', '-b', 'main');
  await command('config', 'user.name', 'Stash Test');
  await command('config', 'user.email', 'stash@example.com');
  await writeFile(path.join(cwd, 'file.txt'), 'base\n');
  await command('add', '.');
  await command('commit', '-m', 'Base');
  await writeFile(path.join(cwd, 'file.txt'), 'saved\n');
  await command('stash', 'push', '-m', 'Old name');
  const old = (await refs(cwd)).stashes[0];
  await writeFile(path.join(cwd, 'file.txt'), 'another change\n');
  await command('stash', 'push', '-m', 'Newer stash');
  await stashRename(cwd, old.hash!, 'Renamed stash');
  const entries = (await refs(cwd)).stashes;
  assert.equal(entries[0].hash, old.hash);
  assert.equal(entries[0].message, 'Renamed stash');
  assert.equal(entries[1].message, 'Newer stash');
  assert.equal(await stashFileAt(cwd, old.hash!, 'file.txt'), 'saved\n');
});

test('all stash reflog entries appear as graph nodes with only their base parent', async (t) => {
  const cwd = await mkdtemp(path.join(tmpdir(), 'gitverse-stash-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const command = async (...args: string[]) => (await run('git', args, { cwd })).stdout.trim();
  await command('init', '--quiet', '-b', 'main');
  await command('config', 'user.name', 'Stash Test');
  await command('config', 'user.email', 'stash@example.com');
  await command('config', 'commit.gpgSign', 'false');
  await command('config', 'core.autocrlf', 'false');
  await writeFile(path.join(cwd, 'file.txt'), 'base\n');
  await command('add', '.');
  await command('commit', '-m', 'Base');
  const base = await command('rev-parse', 'HEAD');
  await writeFile(path.join(cwd, 'file.txt'), 'first\n');
  await writeFile(path.join(cwd, 'new.txt'), 'untracked\n');
  await command('stash', 'push', '-u', '-m', 'First stash');
  await writeFile(path.join(cwd, 'file.txt'), 'second\n');
  await command('stash', 'push', '-m', 'Second stash');
  const references = await refs(cwd);
  assert.equal(references.stashes.length, 2);
  assert.equal(references.stashes[0].author, 'Stash Test');
  assert.equal(references.stashes[0].baseHash, base);
  assert.match(references.stashes[1].message, /First stash/);
  const first = await stashDetail(cwd, references.stashes[1].hash!);
  assert.equal(first.id, 'stash@{1}');
  assert.equal(first.baseHash, base);
  assert.deepEqual(first.files.map((file) => file.path).sort(), ['file.txt', 'new.txt']);
  assert.equal(first.files.find((file) => file.path === 'new.txt')?.untracked, true);
  assert.equal(await stashFileAt(cwd, first.hash, 'file.txt'), 'first\n');
  assert.equal(await stashFileAt(cwd, first.hash, 'new.txt'), 'untracked\n');
  assert.match(await stashFileDiff(cwd, first.hash, 'file.txt'), /^\+first$/m);
  assert.match(await stashFileDiff(cwd, first.hash, 'new.txt'), /^\+untracked$/m);
  await assert.rejects(stashFileDiff(cwd, first.hash, '../outside'), /not in the selected stash/);
  await assert.rejects(stashDetail(cwd, 'HEAD'), /Invalid stash/);
  const branches = await log(cwd);
  assert.deepEqual(
    branches.map((commit) => commit.hash),
    [base],
  );
  const combined = withStashes(branches, references.stashes);
  assert.equal(combined.length, 3);
  for (const stash of references.stashes) {
    const row = combined.find((commit) => commit.hash === stash.hash)!;
    assert.equal(row.stashId, stash.id);
    assert.deepEqual(row.parents, [base]);
    assert.ok(combined.indexOf(row) < combined.findIndex((commit) => commit.hash === base));
  }
  assert.equal(layoutGraph(combined).rows.length, 3);
  assert.equal(withStashes(combined, references.stashes).length, 3);
  assert.equal(await command('status', '--porcelain'), '');
});

test('stash file snapshots survive renumbering and cover renames, deletion, additions, and binary files', async (t) => {
  const cwd = await mkdtemp(path.join(tmpdir(), 'gitverse-stash-files-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const command = async (...args: string[]) => (await run('git', args, { cwd })).stdout.trim();
  await command('init', '--quiet', '-b', 'main');
  await command('config', 'user.name', 'Stash Test');
  await command('config', 'user.email', 'stash@example.com');
  await command('config', 'commit.gpgSign', 'false');
  await command('config', 'core.autocrlf', 'false');
  await writeFile(path.join(cwd, 'file.txt'), 'base\n');
  await writeFile(path.join(cwd, 'deleted.txt'), 'delete me\n');
  await command('add', '.');
  await command('commit', '-m', 'Base');
  await mkdir(path.join(cwd, 'folder'));
  await command('mv', 'file.txt', 'folder/renamed.txt');
  await command('rm', 'deleted.txt');
  await writeFile(path.join(cwd, 'added[1].txt'), 'added\n');
  await command('add', '--', 'added[1].txt');
  await writeFile(path.join(cwd, 'binary.bin'), Buffer.from([0, 1, 2, 3]));
  await command('stash', 'push', '-u', '-m', 'Saved changes');
  const hash = (await refs(cwd)).stashes[0].hash!;
  await writeFile(path.join(cwd, 'file.txt'), 'next stash\n');
  await command('stash', 'push', '-m', 'Newer stash');
  const before = await command('status', '--porcelain');
  const detail = await stashDetail(cwd, hash);
  assert.equal(detail.id, 'stash@{1}');
  assert.equal(detail.files.find((file) => file.path === 'folder/renamed.txt')?.oldPath, 'file.txt');
  assert.equal(detail.files.find((file) => file.path === 'deleted.txt')?.status, 'D');
  assert.equal(await stashFileAt(cwd, hash, 'folder/renamed.txt'), 'base\n');
  assert.equal(await stashFileAt(cwd, hash, 'added[1].txt'), 'added\n');
  assert.match(await stashFileDiff(cwd, hash, 'deleted.txt'), /^-delete me$/m);
  assert.match(await stashFileDiff(cwd, hash, 'binary.bin'), /Binary files/);
  await assert.rejects(stashFileAt(cwd, hash, 'deleted.txt'), /not available/);
  assert.equal(await command('status', '--porcelain'), before);
  await command('stash', 'drop', 'stash@{1}');
  await assert.rejects(stashDetail(cwd, hash), /no longer available/);
});
