import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import {
  agentCheckpoints,
  checkoutRemote,
  commit,
  deleteRemoteBranch,
  historyPosition,
  log,
  pushBranch,
  pushInfo,
  refs,
} from './git';

const run = promisify(execFile);

test('separates agent checkpoint refs from branch history without matching commit messages', async (t) => {
  const cwd = await mkdtemp(path.join(tmpdir(), 'gitverse-history-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const command = async (...args: string[]) => (await run('git', args, { cwd })).stdout.trim();
  await command('init', '--quiet');
  await command(
    '-c',
    'user.name=Test',
    '-c',
    'user.email=test@example.com',
    'commit',
    '--allow-empty',
    '--no-gpg-sign',
    '-m',
    'Agent host session legitimate branch commit',
  );
  const head = await command('rev-parse', 'HEAD');
  await command('checkout', '--orphan', 'temporary-agent');
  await command(
    '-c',
    'user.name=Test',
    '-c',
    'user.email=test@example.com',
    'commit',
    '--allow-empty',
    '--no-gpg-sign',
    '-m',
    'Recovery snapshot',
  );
  const checkpoint = await command('rev-parse', 'HEAD');
  const ref = 'refs/agents/example/checkpoints/turn/0';
  await command('update-ref', ref, checkpoint);
  await command('checkout', '--detach', head);
  await command('branch', '-D', 'temporary-agent');
  assert.deepEqual(
    (await log(cwd)).map((commit) => commit.hash),
    [head],
  );
  assert.equal(await historyPosition(cwd, head), 0);
  await assert.rejects(historyPosition(cwd, checkpoint), /no longer in the repository history/);
  const checkpoints = await agentCheckpoints(cwd);
  assert.equal(checkpoints.length, 1);
  assert.equal(checkpoints[0].ref, ref);
  assert.equal(checkpoints[0].subject, 'Recovery snapshot');
  assert.equal(await command('rev-parse', ref), checkpoint);
});

test('amend keeps the previous message when blank and supports an explicit replacement', async (t) => {
  const cwd = await mkdtemp(path.join(tmpdir(), 'gitverse-amend-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const command = async (...args: string[]) => (await run('git', args, { cwd })).stdout.trim();
  await command('init', '--quiet');
  await command('config', 'user.name', 'Test');
  await command('config', 'user.email', 'test@example.com');
  await command('config', 'commit.gpgSign', 'false');
  await command('commit', '--allow-empty', '-m', 'Original summary', '-m', 'Original description');
  const original = await command('rev-parse', 'HEAD');
  await writeFile(path.join(cwd, 'change.txt'), 'staged change\n');
  await command('add', 'change.txt');
  await commit(cwd, '', '', { amend: true });
  assert.notEqual(await command('rev-parse', 'HEAD'), original);
  assert.equal(await command('log', '-1', '--format=%B'), 'Original summary\n\nOriginal description');
  assert.equal(await command('show', 'HEAD:change.txt'), 'staged change');
  assert.equal(await command('rev-list', '--count', 'HEAD'), '1');
  await commit(cwd, 'Replacement summary', 'Replacement description', { amend: true });
  assert.equal(await command('log', '-1', '--format=%B'), 'Replacement summary\n\nReplacement description');
  await commit(cwd, '', '', { amend: true });
  assert.equal(await command('log', '-1', '--format=%B'), 'Replacement summary\n\nReplacement description');
  assert.equal(await command('rev-list', '--count', 'HEAD'), '1');
  await assert.rejects(commit(cwd, ''));
});

test('force push updates an amended branch but rejects a stale lease even after fetching', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'gitverse-push-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const cwd = path.join(dir, 'local');
  const remote = path.join(dir, 'remote.git');
  const peer = path.join(dir, 'peer');
  const command = async (repo: string, ...args: string[]) => (await run('git', args, { cwd: repo })).stdout.trim();
  await command(dir, 'init', '--bare', '--initial-branch=main', remote);
  await command(dir, 'init', '--initial-branch=main', cwd);
  await command(cwd, 'config', 'user.name', 'Test');
  await command(cwd, 'config', 'user.email', 'test@example.com');
  await command(cwd, 'config', 'commit.gpgSign', 'false');
  await command(cwd, 'remote', 'add', 'origin', remote);
  await writeFile(path.join(cwd, 'file.txt'), 'original\n');
  await command(cwd, 'add', 'file.txt');
  await command(cwd, 'commit', '-m', 'Original');
  await pushBranch(cwd, 'origin', 'main', 'main');
  const info = await pushInfo(cwd);
  assert.equal(info.remoteHash, await command(cwd, 'rev-parse', 'HEAD'));
  await commit(cwd, 'Amended', '', { amend: true });
  await assert.rejects(pushBranch(cwd, 'origin', 'main', 'main'), /rejected|non-fast-forward/);
  await assert.rejects(
    pushBranch(cwd, 'origin', 'main', 'main', undefined, { forceWithLease: true }),
    /Fetch the remote/,
  );
  await pushBranch(cwd, 'origin', 'main', 'main', undefined, {
    forceWithLease: true,
    expectedRemoteHash: info.remoteHash!,
  });
  const amended = await command(cwd, 'rev-parse', 'HEAD');
  assert.equal(await command(remote, 'rev-parse', 'refs/heads/main'), amended);
  await command(dir, 'clone', remote, peer);
  await command(
    peer,
    '-c',
    'user.name=Peer',
    '-c',
    'user.email=peer@example.com',
    'commit',
    '--allow-empty',
    '--no-gpg-sign',
    '-m',
    'Peer work',
  );
  await command(peer, 'push', 'origin', 'main');
  const peerHead = await command(peer, 'rev-parse', 'HEAD');
  await commit(cwd, 'Another amend', '', { amend: true });
  await command(cwd, 'fetch', 'origin');
  assert.equal((await pushInfo(cwd)).remoteHash, peerHead);
  await assert.rejects(
    pushBranch(cwd, 'origin', 'main', 'main', undefined, {
      forceWithLease: true,
      expectedRemoteHash: amended,
    }),
    /stale info|rejected/,
  );
  assert.equal(await command(remote, 'rev-parse', 'refs/heads/main'), peerHead);
});

test('deletes a remote branch without affecting its local counterpart', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'gitverse-delete-remote-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const cwd = path.join(dir, 'local');
  const remote = path.join(dir, 'remote.git');
  const command = async (repo: string, ...args: string[]) => (await run('git', args, { cwd: repo })).stdout.trim();
  await command(dir, 'init', '--bare', '--initial-branch=main', remote);
  await command(dir, 'init', '--initial-branch=main', cwd);
  await command(cwd, 'config', 'user.name', 'Test');
  await command(cwd, 'config', 'user.email', 'test@example.com');
  await command(cwd, 'commit', '--allow-empty', '-m', 'Initial');
  await command(cwd, 'branch', 'feature');
  await command(cwd, 'remote', 'add', 'origin', remote);
  await command(cwd, 'push', 'origin', 'feature');
  await command(cwd, 'fetch', 'origin');

  await deleteRemoteBranch(cwd, 'origin/feature');

  await assert.rejects(command(remote, 'rev-parse', 'refs/heads/feature'));
  assert.equal(await command(cwd, 'rev-parse', 'refs/heads/feature'), await command(cwd, 'rev-parse', 'main'));
  await assert.rejects(command(cwd, 'rev-parse', 'refs/remotes/origin/feature'));
});

test('hides the remote HEAD alias but keeps and deletes a real nested HEAD branch', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'gitverse-remote-head-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const cwd = path.join(dir, 'local');
  const remote = path.join(dir, 'remote.git');
  const command = async (repo: string, ...args: string[]) => (await run('git', args, { cwd: repo })).stdout.trim();
  await command(dir, 'init', '--bare', '--initial-branch=main', remote);
  await command(dir, 'init', '--initial-branch=main', cwd);
  await command(cwd, 'config', 'user.name', 'Test');
  await command(cwd, 'config', 'user.email', 'test@example.com');
  await command(cwd, 'commit', '--allow-empty', '-m', 'Initial');
  await command(cwd, 'branch', 'team/HEAD');
  await command(cwd, 'remote', 'add', 'origin', remote);
  await command(cwd, 'push', 'origin', 'main', 'team/HEAD');
  await command(cwd, 'fetch', 'origin');
  await command(cwd, 'remote', 'set-head', 'origin', '--auto');

  const graphRefs = (await log(cwd))[0].refs;
  assert.equal(
    graphRefs.some((ref) => ref.name === 'origin/HEAD'),
    false,
  );
  assert.equal(
    graphRefs.some((ref) => ref.name === 'origin/team/HEAD'),
    true,
  );
  const remoteRefs = (await refs(cwd)).remote.map((ref) => ref.name);
  assert.equal(remoteRefs.includes('origin/HEAD'), false);
  assert.equal(remoteRefs.includes('origin/team/HEAD'), true);
  await assert.rejects(deleteRemoteBranch(cwd, 'origin/HEAD'), /default branch/);
  assert.equal(await command(cwd, 'symbolic-ref', 'refs/remotes/origin/HEAD'), 'refs/remotes/origin/main');
  await deleteRemoteBranch(cwd, 'origin/team/HEAD');
  await assert.rejects(command(remote, 'rev-parse', '--verify', 'refs/heads/team/HEAD'));
  assert.ok(await command(remote, 'rev-parse', '--verify', 'refs/heads/main'));
});

test('checking out a remote uses a tracking branch and preserves its local history', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'gitverse-checkout-remote-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const cwd = path.join(dir, 'local');
  const remote = path.join(dir, 'remote.git');
  const peer = path.join(dir, 'peer');
  const command = async (repo: string, ...args: string[]) => (await run('git', args, { cwd: repo })).stdout.trim();
  await command(dir, 'init', '--bare', '--initial-branch=main', remote);
  await command(dir, 'init', '--initial-branch=main', cwd);
  await command(cwd, 'config', 'user.name', 'Test');
  await command(cwd, 'config', 'user.email', 'test@example.com');
  await command(cwd, 'commit', '--allow-empty', '-m', 'Initial');
  await command(cwd, 'remote', 'add', 'origin', remote);
  await command(cwd, 'push', 'origin', 'main');
  await command(cwd, 'push', 'origin', 'main:feature');
  await command(cwd, 'fetch', 'origin');

  assert.equal(await checkoutRemote(cwd, 'origin/feature'), 'feature');
  assert.equal(await command(cwd, 'branch', '--show-current'), 'feature');
  assert.equal(await command(cwd, 'rev-parse', '--abbrev-ref', 'feature@{upstream}'), 'origin/feature');
  const localHead = await command(cwd, 'rev-parse', 'feature');
  await command(cwd, 'switch', 'main');
  await command(dir, 'clone', remote, peer);
  await command(peer, 'switch', 'feature');
  await command(
    peer,
    '-c',
    'user.name=Peer',
    '-c',
    'user.email=peer@example.com',
    'commit',
    '--allow-empty',
    '-m',
    'Remote change',
  );
  await command(peer, 'push');
  await command(cwd, 'fetch', 'origin');
  assert.notEqual(await command(cwd, 'rev-parse', 'origin/feature'), localHead);
  assert.equal(await checkoutRemote(cwd, 'origin/feature'), 'feature');
  assert.equal(await command(cwd, 'rev-parse', 'HEAD'), localHead);
  assert.equal(await command(cwd, 'branch', '--show-current'), 'feature');

  await command(cwd, 'switch', 'main');
  await command(cwd, 'push', 'origin', 'main:conflict');
  await command(cwd, 'fetch', 'origin');
  await command(cwd, 'branch', 'conflict');
  await command(cwd, 'branch', '--set-upstream-to=origin/main', 'conflict');
  await assert.rejects(checkoutRemote(cwd, 'origin/conflict'), /tracks a different remote branch/);
  assert.equal(await command(cwd, 'branch', '--show-current'), 'main');
});
