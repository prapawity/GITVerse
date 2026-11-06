import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { agentCheckpoints, historyPosition, log } from './git';

const run = promisify(execFile);

test('separates agent checkpoint refs from branch history without matching commit messages', async (t) => {
  const cwd = await mkdtemp(path.join(tmpdir(), 'gitverse-history-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const command = async (...args: string[]) => (await run('git', args, { cwd })).stdout.trim();
  await command('init', '--quiet');
  await command('-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '--allow-empty', '--no-gpg-sign', '-m', 'Agent host session legitimate branch commit');
  const head = await command('rev-parse', 'HEAD');
  await command('checkout', '--orphan', 'temporary-agent');
  await command('-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '--allow-empty', '--no-gpg-sign', '-m', 'Recovery snapshot');
  const checkpoint = await command('rev-parse', 'HEAD');
  const ref = 'refs/agents/example/checkpoints/turn/0';
  await command('update-ref', ref, checkpoint);
  await command('checkout', '--detach', head);
  await command('branch', '-D', 'temporary-agent');
  assert.deepEqual((await log(cwd)).map((commit) => commit.hash), [head]);
  assert.equal(await historyPosition(cwd, head), 0);
  await assert.rejects(historyPosition(cwd, checkpoint), /no longer in the repository history/);
  const checkpoints = await agentCheckpoints(cwd);
  assert.equal(checkpoints.length, 1);
  assert.equal(checkpoints[0].ref, ref);
  assert.equal(checkpoints[0].subject, 'Recovery snapshot');
  assert.equal(await command('rev-parse', ref), checkpoint);
});
