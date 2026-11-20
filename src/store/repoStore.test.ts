import assert from 'node:assert/strict';
import test, { beforeEach } from 'node:test';
import { useRepo } from './repoStore';
import { useSettings } from './settingsStore';
import type { Commit } from '../shared/types';

const refs = (hash: string) => ({
  local: [{ name: 'main', current: true, hash }],
  remote: [],
  tags: [],
  stashes: [],
  headHash: hash,
});
const commit = (hash: string): Commit => ({
  hash,
  parents: [],
  refs: [],
  subject: hash,
  author: 'Test',
  email: 'test@example.com',
  date: new Date().toISOString(),
});
let calls: string[];
let backend: Record<string, (...args: unknown[]) => Promise<unknown>>;

beforeEach(() => {
  calls = [];
  backend = {
    status: async () => [],
    refs: async () => refs('new'),
    opState: async () => null,
    log: async () => {
      calls.push('log');
      return [commit('new')];
    },
    fetch: async () => {
      calls.push('fetch');
    },
    push: async () => {
      calls.push('push');
    },
    indexUndoState: async () => ({ undo: false, redo: false }),
  };
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { gitApi: backend } });
  useRepo.setState({
    repoPath: '/repo',
    commits: [commit('old')],
    status: [],
    commitDrafts: {},
    refs: refs('old'),
    operation: null,
    working: null,
    loading: false,
    toasts: [],
    activity: [],
    recentRepos: [],
    syncingGroups: [],
  });
});

test('group sync adds only new discoveries without switching repositories or reopening closed entries', async () => {
  const previous = useSettings.getState();
  try {
    useSettings.setState({
      repoGroupRoots: { Projects: '/projects' },
      repoGroups: { '/projects/known': 'Projects', '/projects/closed': 'Projects', '/projects/moved': 'Other' },
    });
    useRepo.setState({ recentRepos: ['/projects/known', '/projects/open'] });
    backend.findRepositories = async () => ({
      root: '/projects',
      group: 'projects',
      skipped: 0,
      cancelled: false,
      repos: [
        '/projects/known',
        '/projects/closed',
        '/projects/moved',
        '/projects/open',
        '/projects/new',
        '/projects/new',
      ],
    });
    await useRepo.getState().syncRepoGroup('Projects');
    assert.deepEqual(useRepo.getState().recentRepos, ['/projects/known', '/projects/open', '/projects/new']);
    assert.equal(useRepo.getState().repoPath, '/repo');
    assert.equal(useSettings.getState().repoGroups['/projects/new'], 'Projects');
    assert.equal(useSettings.getState().repoGroups['/projects/moved'], 'Other');
    assert.deepEqual(useRepo.getState().syncingGroups, []);
  } finally {
    useSettings.setState(previous);
  }
});

test('group sync ignores duplicate requests and results for a deleted group', async () => {
  const previous = useSettings.getState();
  try {
    useSettings.setState({ repoGroupRoots: { Projects: '/projects' }, repoGroups: {} });
    let finish!: (value: unknown) => void;
    let scans = 0;
    backend.findRepositories = async () => {
      scans++;
      return new Promise((resolve) => {
        finish = resolve;
      });
    };
    const pending = useRepo.getState().syncRepoGroup('Projects', false);
    await useRepo.getState().syncRepoGroup('Projects');
    assert.equal(scans, 1);
    assert.deepEqual(useRepo.getState().syncingGroups, ['Projects']);
    useSettings.getState().deleteRepoGroup('Projects');
    finish({ repos: ['/projects/new'], skipped: 0, cancelled: false });
    await pending;
    assert.deepEqual(useRepo.getState().recentRepos, []);
    assert.deepEqual(useSettings.getState().repoGroups, {});
    assert.deepEqual(useRepo.getState().syncingGroups, []);
  } finally {
    useSettings.setState(previous);
  }
});

test('group sync keeps existing entries on cancellation or scan failure and reports manual failures', async () => {
  const previous = useSettings.getState();
  try {
    useSettings.setState({ repoGroupRoots: { Projects: '/projects' }, repoGroups: { '/projects/known': 'Projects' } });
    useRepo.setState({ recentRepos: ['/projects/known'] });
    backend.findRepositories = async () => ({ repos: ['/projects/new'], skipped: 0, cancelled: true });
    await useRepo.getState().syncRepoGroup('Projects');
    assert.deepEqual(useRepo.getState().recentRepos, ['/projects/known']);
    backend.findRepositories = async () => {
      throw new Error('Folder is unavailable');
    };
    await useRepo.getState().syncRepoGroup('Projects');
    assert.equal(useRepo.getState().toasts.at(-1)?.kind, 'error');
    assert.deepEqual(useRepo.getState().recentRepos, ['/projects/known']);
    assert.deepEqual(useRepo.getState().syncingGroups, []);
  } finally {
    useSettings.setState(previous);
  }
});

test('automatic group sync is silent when unchanged or failing; manual partial scans never claim up to date', async () => {
  const previous = useSettings.getState();
  try {
    useSettings.setState({ repoGroupRoots: { Projects: '/projects' }, repoGroups: {} });
    backend.findRepositories = async () => ({ repos: [], skipped: 0, cancelled: false });
    await useRepo.getState().syncRepoGroup('Projects', false);
    assert.deepEqual(useRepo.getState().toasts, []);
    await useRepo.getState().syncRepoGroup('Projects');
    assert.equal(useRepo.getState().toasts.at(-1)?.title, 'Projects is up to date');
    useRepo.setState({ toasts: [] });
    backend.findRepositories = async () => ({ repos: [], skipped: 2, cancelled: false });
    await useRepo.getState().syncRepoGroup('Projects');
    assert.deepEqual(
      useRepo.getState().toasts.map((toast) => toast.kind),
      ['warning'],
    );
    useRepo.setState({ toasts: [] });
    backend.findRepositories = async () => {
      throw new Error('Permission denied');
    };
    await useRepo.getState().syncRepoGroup('Projects', false);
    assert.deepEqual(useRepo.getState().toasts, []);
    assert.equal(useRepo.getState().activity[0].kind, 'error');
  } finally {
    useSettings.setState(previous);
  }
});

test('group sync requires a saved root and ignores results after the root changes', async () => {
  const previous = useSettings.getState();
  try {
    useSettings.setState({ repoGroupRoots: {}, repoGroups: {} });
    let scans = 0;
    backend.findRepositories = async () => {
      scans++;
      useSettings.getState().setRepoGroupRoot('Projects', '/other');
      return { repos: ['/projects/new'], skipped: 0, cancelled: false };
    };
    await useRepo.getState().syncRepoGroup('Projects');
    assert.equal(scans, 0);
    useSettings.getState().setRepoGroupRoot('Projects', '/projects');
    await useRepo.getState().syncRepoGroup('Projects');
    assert.equal(scans, 1);
    assert.deepEqual(useRepo.getState().recentRepos, []);
    assert.deepEqual(useSettings.getState().repoGroups, {});
  } finally {
    useSettings.setState(previous);
  }
});

test('amend prefills the HEAD summary and multiline description while retaining signoff', async () => {
  useRepo.getState().setCommitDraft('/repo', { summary: '', description: '', amend: false, signoff: true });
  backend.commitDetail = async (repo, hash) => {
    assert.equal(repo, '/repo');
    assert.equal(hash, 'HEAD');
    return { body: 'Previous summary\r\n\r\nFirst paragraph\r\n\r\nSecond paragraph' };
  };
  await useRepo.getState().prefillAmendDraft('/repo');
  assert.deepEqual(useRepo.getState().commitDrafts['/repo'], {
    summary: 'Previous summary',
    description: 'First paragraph\n\nSecond paragraph',
    amend: true,
    signoff: true,
  });
});

test('amend prefills a summary-only commit without a description', async () => {
  backend.commitDetail = async () => ({ body: 'Summary only' });
  await useRepo.getState().prefillAmendDraft('/repo');
  assert.deepEqual(useRepo.getState().commitDrafts['/repo'], {
    summary: 'Summary only',
    description: '',
    amend: true,
    signoff: false,
  });
});

test('amend discards responses when the repository, draft, or HEAD changes during loading', async () => {
  for (const change of [
    () => useRepo.setState({ repoPath: '/other' }),
    () =>
      useRepo
        .getState()
        .setCommitDraft('/repo', { summary: 'New draft', description: '', amend: false, signoff: false }),
    () => useRepo.setState({ refs: refs('new') }),
  ]) {
    useRepo.setState({ repoPath: '/repo', commitDrafts: {}, refs: refs('old') });
    backend.commitDetail = async () => {
      change();
      return { body: 'Previous summary\n\nPrevious description' };
    };
    await useRepo.getState().prefillAmendDraft('/repo');
    assert.notEqual(useRepo.getState().commitDrafts['/repo']?.summary, 'Previous summary');
  }
});

test('amend preserves the draft and remains off if reading HEAD fails', async () => {
  const draft = { summary: 'Draft', description: '', amend: false, signoff: false };
  useRepo.getState().setCommitDraft('/repo', draft);
  backend.commitDetail = async () => {
    throw new Error('HEAD does not exist');
  };
  await assert.rejects(useRepo.getState().prefillAmendDraft('/repo'), /HEAD does not exist/);
  assert.equal(useRepo.getState().commitDrafts['/repo'], draft);
});

test('stash metadata is merged into graph without altering branch pagination and disappears after removal', async () => {
  const stash = {
    id: 'stash@{0}',
    hash: 'stash-hash',
    baseHash: 'new',
    message: 'Saved work',
    author: 'Test',
    date: new Date().toISOString(),
  };
  backend.refs = async () => ({ ...refs('new'), stashes: [stash] });
  await useRepo.getState().refresh();
  assert.deepEqual(
    useRepo.getState().commits.map((entry) => entry.hash),
    ['new'],
  );
  assert.equal(useRepo.getState().graph.rows.find((row) => row.commit.hash === stash.hash)?.commit.stashId, stash.id);
  assert.equal(await useRepo.getState().ensureCommitVisible(stash.hash), true);
  backend.refs = async () => refs('new');
  await useRepo.getState().refreshStatus();
  assert.equal(
    useRepo.getState().graph.rows.some((row) => row.commit.stashId),
    false,
  );
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
  backend.fetch = async () => {
    calls.push('fetch');
    throw new Error('Offline');
  };
  await useRepo.getState().syncAfterPush('/repo');
  assert.deepEqual(calls, ['fetch', 'log']);
  assert.ok(
    useRepo.getState().toasts.some((toast) => toast.kind === 'warning' && toast.title.includes('Push succeeded')),
  );
});

test('pull failures from Windows-incompatible paths explain why local history stayed behind', async () => {
  backend.pull = async () => {
    throw new Error("error: invalid path 'assets/kit:bathroommirror.png'");
  };
  await useRepo.getState().action('fetch', 'ff-only');
  const toast = useRepo.getState().toasts.find((item) => item.kind === 'error');
  assert.equal(toast?.title, 'Pull stopped: Windows cannot check out these file names');
  assert.match(toast?.detail ?? '', /kit:bathroommirror\.png/);
  assert.match(toast?.detail ?? '', /rename these files/);
});

test('remote checkout does not report success if the refreshed branch still differs from the remote', async () => {
  backend.checkoutRemote = async () => 'main';
  backend.refs = async () => ({
    ...refs('local'),
    local: [{ name: 'main', current: true, hash: 'local', upstream: 'origin/main', behind: 3, ahead: 0 }],
    remote: [{ name: 'origin/main', hash: 'remote' }],
  });
  await useRepo.getState().checkoutRemote('origin/main');
  assert.ok(
    useRepo
      .getState()
      .toasts.some((toast) => toast.kind === 'error' && /still does not match origin\/main/.test(toast.detail ?? '')),
  );
  assert.ok(!useRepo.getState().toasts.some((toast) => toast.kind === 'success'));
});

test('poll results are ignored when the repository changes', async () => {
  backend.status = async () => {
    useRepo.setState({ repoPath: '/another' });
    return [];
  };
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
  backend.log = async () => {
    throw new Error('Cannot read history');
  };
  await useRepo.getState().refreshStatus();
  assert.ok(!useRepo.getState().toasts.some((toast) => toast.kind === 'info'));
});
