import assert from 'node:assert/strict';
import test from 'node:test';
import { checkRequest, detectHostedRepo, webUrlAllowed } from './pullRequests';
import { parseAiResult } from '../lib/pullRequests';

test('detects the hosting provider from common remote URL forms', () => {
  assert.deepEqual(detectHostedRepo('git@github.com:acme/app.git'), {
    kind: 'github',
    host: 'github.com',
    path: 'acme/app',
  });
  assert.deepEqual(detectHostedRepo('https://github.com/acme/app'), {
    kind: 'github',
    host: 'github.com',
    path: 'acme/app',
  });
  assert.deepEqual(detectHostedRepo('https://gitlab.com/group/sub/app.git'), {
    kind: 'gitlab',
    host: 'gitlab.com',
    path: 'group/sub/app',
  });
  assert.deepEqual(detectHostedRepo('ssh://git@gitlab.acme.io:2222/team/app.git'), {
    kind: 'gitlab',
    host: 'gitlab.acme.io',
    path: 'team/app',
  });
  assert.deepEqual(detectHostedRepo('https://user@bitbucket.org/team/app.git'), {
    kind: 'bitbucket',
    host: 'bitbucket.org',
    path: 'team/app',
  });
  assert.equal(detectHostedRepo('https://git.acme.io/team/app.git'), null);
  assert.deepEqual(detectHostedRepo('https://git.acme.io:8443/team/app.git', 'gitlab'), {
    kind: 'gitlab',
    host: 'git.acme.io:8443',
    path: 'team/app',
  });
  assert.equal(detectHostedRepo('/local/path'), null);
});

test('refuses requests that could leave the provider API', () => {
  const ok = { kind: 'github' as const, host: 'github.com', method: 'GET' as const };
  assert.equal(checkRequest({ ...ok, path: '/repos/a/b/compare/main...feat%2Fx' }), null);
  for (const path of ['repos', '//evil.com', '/a/../b', '/a@evil.com', '/a b'])
    assert.notEqual(checkRequest({ ...ok, path }), null, path);
  assert.notEqual(checkRequest({ ...ok, host: 'evil.com/x', path: '/x' }), null);
  assert.notEqual(checkRequest({ kind: 'bitbucket', host: 'bb.acme.io', method: 'GET', path: '/x' }), null);
  assert.ok(webUrlAllowed('github', 'github.com', 'https://github.com/a/b/pull/1'));
  assert.ok(!webUrlAllowed('github', 'github.com', 'https://evil.com/a'));
  assert.ok(!webUrlAllowed('github', 'github.com', 'http://github.com/a'));
});

test('splits an AI answer into title and description', () => {
  assert.deepEqual(parseAiResult('```markdown\n# Add login\n\n## Summary\n- x\n```'), {
    title: 'Add login',
    body: '## Summary\n- x',
  });
  assert.deepEqual(parseAiResult('Title: Fix crash\n\nBody'), { title: 'Fix crash', body: 'Body' });
});

test('makes a readable title from a branch name', async () => {
  const { titleFromBranch, commitList } = await import('../lib/pullRequests');
  assert.equal(titleFromBranch('feature/ABC-123-add-login'), 'ABC-123 Add login');
  assert.equal(titleFromBranch('fix/handle_null_card'), 'Handle null card');
  assert.equal(titleFromBranch('develop'), 'Develop');
  assert.equal(commitList(['Add x\n\nbody', "Merge branch 'main'", 'Fix y']), '- Add x\n- Fix y');
});

test('issue branch names and issue numbers from branches', async () => {
  const { issueBranchName, issueFromBranch } = await import('../lib/pullRequests');
  assert.equal(
    issueBranchName({ number: 123, title: 'Fix login crash on iOS 18!' }),
    'feature/123-fix-login-crash-on-ios-18',
  );
  assert.equal(issueBranchName({ number: 7, title: 'ทดสอบ' }, 'bugfix/'), 'bugfix/7');
  assert.equal(issueFromBranch('feature/123-fix-login'), 123);
  assert.equal(issueFromBranch('456-quick'), 456);
  assert.equal(issueFromBranch('develop'), null);
  assert.equal(issueFromBranch('release/1.0.4'), null);
});

test('CI status rolls up GitHub checks, the latest GitLab pipeline and Bitbucket statuses', async () => {
  const { ciStatus } = await import('../lib/pullRequests');
  const replies = new Map<string, unknown>();
  const asked: string[] = [];
  const g = globalThis as { window?: unknown };
  const previous = g.window;
  g.window = {
    gitApi: {
      hosting: {
        request: async ({ path }: { path: string }) => {
          asked.push(path);
          return { status: 200, data: replies.get(path.split('?')[0]) ?? {} };
        },
      },
    },
  };
  try {
    const sha = 'a'.repeat(40);
    const github = { kind: 'github' as const, host: 'github.com', path: 'acme/app' };
    replies.set(`/repos/acme/app/commits/${sha}/check-runs`, {
      check_runs: [
        { status: 'completed', conclusion: 'success' },
        { status: 'completed', conclusion: 'skipped' },
        { status: 'in_progress', conclusion: null },
      ],
    });
    replies.set(`/repos/acme/app/commits/${sha}/status`, { statuses: [{ state: 'success' }] });
    assert.deepEqual(await ciStatus(github, sha), {
      state: 'pending',
      passed: 3,
      failed: 0,
      pending: 1,
      url: `https://github.com/acme/app/commit/${sha}/checks`,
    });
    replies.set(`/repos/acme/app/commits/${sha}/status`, { statuses: [{ state: 'error' }] });
    assert.equal((await ciStatus(github, sha)).state, 'failure', 'a failure wins over running checks');

    const gitlab = { kind: 'gitlab' as const, host: 'gitlab.com', path: 'group/app' };
    replies.set('/projects/group%2Fapp/pipelines', [{ status: 'success', web_url: 'https://gitlab.com/p/1' }]);
    assert.equal((await ciStatus(gitlab, sha)).state, 'success');

    const bitbucket = { kind: 'bitbucket' as const, host: 'bitbucket.org', path: 'team/app' };
    replies.set(`/repositories/team/app/commit/${sha}/statuses`, { values: [{ state: 'FAILED', url: 'https://ci' }] });
    assert.deepEqual(await ciStatus(bitbucket, sha), {
      state: 'failure',
      passed: 0,
      failed: 1,
      pending: 0,
      url: undefined,
    });

    // no checks, or not a commit hash: nothing to show and nothing is requested
    replies.clear();
    assert.equal((await ciStatus(github, sha)).state, 'none');
    const before = asked.length;
    assert.equal((await ciStatus(github, 'main; rm')).state, 'none');
    assert.equal(asked.length, before);
  } finally {
    g.window = previous;
  }
});
