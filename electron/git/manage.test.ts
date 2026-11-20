/** Branch rename, tags, remotes, .gitignore, commit template, signing config and hide/solo history. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import * as git from './git';

const run = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8' }).trim();

function repo() {
  const dir = mkdtempSync(path.join(tmpdir(), 'gitverse-manage-'));
  run(dir, 'init', '-q', '-b', 'main');
  run(dir, 'config', 'user.name', 'Test');
  run(dir, 'config', 'user.email', 'test@example.com');
  run(dir, 'config', 'commit.gpgsign', 'false');
  writeFileSync(path.join(dir, 'a.txt'), 'a\n');
  run(dir, 'add', '.');
  run(dir, 'commit', '-q', '-m', 'first');
  return dir;
}

test('rename branch validates names and renames', async () => {
  const dir = repo();
  run(dir, 'branch', 'feature/old');
  await git.renameBranch(dir, 'feature/old', 'feature/new');
  assert.match(run(dir, 'branch', '--list'), /feature\/new/);
  await assert.rejects(git.renameBranch(dir, 'feature/new', 'bad name'));
  await assert.rejects(git.renameBranch(dir, 'missing', 'other'));
});

test('push and delete tags against a bare remote', async () => {
  const dir = repo();
  const bare = mkdtempSync(path.join(tmpdir(), 'gitverse-bare-'));
  run(bare, 'init', '-q', '--bare');
  await git.addRemote(dir, 'origin', bare);
  await assert.rejects(git.addRemote(dir, 'bad name', bare));
  run(dir, 'tag', 'v1');
  run(dir, 'tag', 'v2');
  await git.pushTag(dir, 'origin', 'v1');
  assert.match(run(bare, 'tag'), /v1/);
  await git.pushTag(dir, 'origin', null);
  assert.match(run(bare, 'tag'), /v2/);
  await git.deleteTag(dir, 'v1', 'origin');
  assert.doesNotMatch(run(bare, 'tag'), /v1/);
  assert.doesNotMatch(run(dir, 'tag'), /v1/);
  await assert.rejects(git.pushTag(dir, 'nope', 'v2'));
  await git.removeRemote(dir, 'origin');
  assert.equal(run(dir, 'remote'), '');
});

test('ignorePath appends once and can stop tracking', async () => {
  const dir = repo();
  await git.ignorePath(dir, '/a.txt', 'a.txt');
  await git.ignorePath(dir, '/a.txt');
  assert.equal(readFileSync(path.join(dir, '.gitignore'), 'utf8'), '/a.txt\n');
  assert.match(run(dir, 'status', '--porcelain'), /^D {2}a\.txt/m);
  await assert.rejects(git.ignorePath(dir, 'a\nb'));
});

test('commit template drops comment lines', async () => {
  const dir = repo();
  writeFileSync(path.join(dir, 'tpl.txt'), 'feat: \n\n# comment\nBody\n');
  run(dir, 'config', 'commit.template', 'tpl.txt');
  assert.equal(await git.commitTemplate(dir), 'feat: \n\nBody'.trim());
});

test('signing config round-trips locally', async () => {
  const dir = repo();
  await git.setSigningConfig(dir, { format: 'ssh', key: '~/.ssh/id.pub', commits: true, tags: false }, 'local');
  const config = await git.signingConfig(dir);
  assert.equal(config.format, 'ssh');
  assert.equal(config.commits, true);
  assert.equal(config.scope, 'local');
  await assert.rejects(git.setSigningConfig(dir, { format: 'ssh', key: '-x', commits: true, tags: false }, 'local'));
});

test('history scope hides and solos refs', async () => {
  const dir = repo();
  run(dir, 'checkout', '-q', '-b', 'side');
  writeFileSync(path.join(dir, 'b.txt'), 'b\n');
  run(dir, 'add', '.');
  run(dir, 'commit', '-q', '-m', 'side work');
  run(dir, 'checkout', '-q', 'main');
  const all = await git.log(dir, 50, 0, 'topo');
  assert.ok(all.some((c) => c.subject === 'side work'));
  const hidden = await git.log(dir, 50, 0, 'topo', { hide: { branches: ['side'] } });
  assert.ok(!hidden.some((c) => c.subject === 'side work'));
  const solo = await git.log(dir, 50, 0, 'topo', { solo: ['refs/heads/side'] });
  assert.ok(solo.some((c) => c.subject === 'side work'));
  await assert.rejects(git.log(dir, 50, 0, 'topo', { hide: { branches: ['--all'] } }));
  await assert.rejects(git.log(dir, 50, 0, 'topo', { solo: ['side'] }));
});
