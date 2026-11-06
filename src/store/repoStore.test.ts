import assert from 'node:assert/strict';
import test, { beforeEach } from 'node:test';
import { useRepo } from './repoStore';
import type { Commit } from '../shared/types';

const refs = (hash: string) => ({
  local: [{ name: 'main', current: true, hash }], remote: [], tags: [], stashes: [], headHash: hash,
});
const commit = (hash: string): Commit => ({ hash, parents: [], refs: [], subject: hash, author: 'Test', email: 'test@example.com', date: new Date().toISOString() });
let calls: string[];
let backend: Record<string, (...args: unknown[]) => Promise<unknown>>;

beforeEach(() => {
  calls = [];
  backend = {
    status: async () => [],
    refs: async () => refs('new'),
    opState: async () => null,
    log: async () => { calls.push('log'); return [commit('new')]; },
    fetch: async () => { calls.push('fetch'); },
    push: async () => { calls.push('push'); },
    indexUndoState: async () => ({ undo: false, redo: false }),
  };
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { gitApi: backend } });
  useRepo.setState({ repoPath: '/repo', commits: [commit('old')], status: [], refs: refs('old'), operation: null, working: null, loading: false, toasts: [], activity: [] });
});

test('external commits refresh history, references and staged changes with feedback', async () => {
  backend.status = async () => [{ path: 'file.ts', index: 'M', worktree: ' ' }];
  await useRepo.getState().refreshStatus();
  assert.equal(useRepo.getState().commits[0].hash, 'new');
  assert.equal(useRepo.getState().refs.headHash, 'new');
  assert.equal(useRepo.getState().status[0].index, 'M');
  assert.ok(useRepo.getState().toasts.some((toast) => toast.kind === 'info'));
});

test('unchanged references update staging without reloading history', async () => {
  backend.refs = async () => refs('old');
  backend.status = async () => [{ path: 'file.ts', index: 'M', worktree: 'M' }];
  await useRepo.getState().refreshStatus();
  assert.deepEqual(calls, []);
  assert.equal(useRepo.getState().status[0].index, 'M');
});

test('push fetches remote references before reloading the graph', async () => {
  await useRepo.getState().action('push');
  assert.deepEqual(calls, ['push', 'fetch', 'log']);
  assert.equal(useRepo.getState().commits[0].hash, 'new');
});

test('fetch failure after a successful push warns but still refreshes local history', async () => {
  backend.fetch = async () => { calls.push('fetch'); throw new Error('Offline'); };
  await useRepo.getState().syncAfterPush('/repo');
  assert.deepEqual(calls, ['fetch', 'log']);
  assert.ok(useRepo.getState().toasts.some((toast) => toast.kind === 'warning' && toast.title.includes('Push succeeded')));
});

test('poll results are ignored when the repository changes', async () => {
  backend.status = async () => { useRepo.setState({ repoPath: '/another' }); return []; };
  await useRepo.getState().refreshStatus();
  assert.equal(useRepo.getState().commits[0].hash, 'old');
  assert.deepEqual(calls, []);
});

test('external pushes update remote-only ref changes even when HEAD is unchanged', async () => {
  const updated = { ...refs('old'), remote: [{ name: 'origin/main', hash: 'old' }] };
  backend.refs = async () => updated;
  await useRepo.getState().refreshStatus();
  assert.deepEqual(useRepo.getState().refs.remote, updated.remote);
  assert.deepEqual(calls, ['log']);
});

test('silent refresh keeps the loaded history depth', async () => {
  const loaded = Array.from({ length: 600 }, (_, i) => commit(String(i)));
  useRepo.setState({ commits: loaded });
  backend.log = async (_cwd, limit) => {
    assert.equal(limit, 600);
    return loaded;
  };
  await useRepo.getState().refresh(true);
  assert.equal(useRepo.getState().commits.length, 600);
});

test('failed history refresh never reports that external changes were reloaded', async () => {
  backend.log = async () => { throw new Error('Cannot read history'); };
  await useRepo.getState().refreshStatus();
  assert.ok(useRepo.getState().toasts.some((toast) => toast.kind === 'error'));
  assert.ok(!useRepo.getState().toasts.some((toast) => toast.kind === 'info'));
});
