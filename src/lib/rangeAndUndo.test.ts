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
