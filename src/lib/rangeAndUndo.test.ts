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
