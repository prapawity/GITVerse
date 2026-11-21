import assert from 'node:assert/strict';
import test from 'node:test';
import { consecutiveRange } from '../components/CombinedChanges';
import { entryFor } from './actionHistory';

const rows = ['d', 'c', 'b', 'a'].map((hash, i, all) => ({
  commit: { hash, parents: all[i + 1] ? [all[i + 1]] : [] },
}));

test('combined changes need consecutive first-parent commits', () => {
  assert.deepEqual(consecutiveRange(['b', 'd', 'c'], rows), { newest: 'd', oldest: 'b', count: 3 });
  assert.equal(consecutiveRange(['d', 'b'], rows), null);
  assert.equal(consecutiveRange(['d'], rows), null);
  assert.equal(consecutiveRange(['d', 'zz'], rows), null);
});

test('undo entries only when something moved', () => {
  const at = { head: 'a', branch: 'main' };
  assert.equal(entryFor('Commit', 'commit', at, at), null);
  assert.ok(entryFor('Commit', 'commit', at, { head: 'b', branch: 'main' }));
  assert.equal(entryFor('Reset', 'history', at, { head: 'b', branch: 'other' }), null);
  assert.ok(entryFor('Checkout x', 'checkout', at, { head: 'b', branch: 'x' }));
});

test('gitignore escaping and co-author trailers', async () => {
  const { escapeGitignore } = await import('../components/IgnoreMenu');
  const { coAuthors } = await import('../components/CommitPeople');
  assert.equal(escapeGitignore('foo[1].txt'), 'foo\\[1\\].txt');
  assert.equal(escapeGitignore('#notes'), '\\#notes');
  assert.equal(escapeGitignore('a*b?'), 'a\\*b\\?');
  assert.equal(escapeGitignore('trail  '), 'trail\\ \\ ');
  assert.deepEqual(
    coAuthors(
      'Fix\n\nCo-authored-by: Ann <ann@x.com>\nco-authored-by: Bob <bob@x.com>\nCo-authored-by: Ann <ANN@x.com>',
    ),
    [
      { name: 'Ann', email: 'ann@x.com' },
      { name: 'Bob', email: 'bob@x.com' },
    ],
  );
});

test('gitattributes patterns for the LFS badge', async () => {
  const { attributePattern } = await import('./lfs');
  const psd = attributePattern('*.psd');
  assert.ok(psd.test('art/cover.psd') && psd.test('cover.psd') && !psd.test('cover.psd.txt'));
  const assets = attributePattern('assets/*.bin');
  assert.ok(assets.test('assets/a.bin') && !assets.test('other/assets/a.bin') && !assets.test('assets/x/a.bin'));
  const deep = attributePattern('media/**/*.mp4');
  assert.ok(deep.test('media/a/b/c.mp4'));
});

test('commit composer plans keep every file exactly once', async () => {
  const { parsePlan } = await import('./composer');
  const plan = parsePlan(
    'Here:\n{"commits":[{"message":"feat: a\\n\\nbody","files":["a.ts","ghost.ts"]},{"message":"fix: b","files":["a.ts","b.ts"]}]}',
    ['a.ts', 'b.ts', 'c.ts'],
  );
  assert.deepEqual(
    plan.map((c) => [c.summary, c.body, c.files]),
    [
      ['feat: a', 'body', ['a.ts']],
      ['fix: b', '', ['b.ts']],
      ['Remaining changes', '', ['c.ts']],
    ],
  );
  assert.throws(() => parsePlan('no json', ['a.ts']));
});

test('agent sessions: command, quoting, branch and folder names', async () => {
  const { agentCommand, agentBranchName, agentWorktreePath, shellQuote } = await import('./agentCommands');
  // quoting follows the shell of the platform the app runs on (cmd / PowerShell on Windows)
  const windows = typeof navigator !== 'undefined' && /Win/.test(navigator.platform);
  if (windows) {
    assert.equal(shellQuote('say "hi"'), '"say \\"hi\\""');
    assert.deepEqual(agentCommand('claude', 'Fix it'), { command: 'claude "Fix it"', clipboard: false });
  } else {
    assert.equal(shellQuote("it's done"), `'it'\\''s done'`);
    assert.deepEqual(agentCommand('claude', "Fix the user's login"), {
      command: `claude 'Fix the user'\\''s login'`,
      clipboard: false,
    });
    assert.deepEqual(agentCommand('gemini', 'Add tests'), { command: `gemini -i 'Add tests'`, clipboard: false });
  }

  assert.deepEqual(agentCommand('copilot', 'Add tests'), { command: 'copilot', clipboard: true });
  assert.equal(
    agentBranchName('Add input validation to the login form!', 'claude'),
    'agent/add-input-validation-to-the',
  );
  assert.equal(agentWorktreePath('/Users/me/work/app', 'agent/fix-login'), '/Users/me/work/app.agents/fix-login');
  assert.throws(() => agentCommand('rm', 'x'));
});
