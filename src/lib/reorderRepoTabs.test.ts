import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { reorderRepoTabs } from './reorderRepoTabs';

test('reorders whole groups and individual tabs in both directions', () => {
  const repos = ['a', 'b', 'c', 'd'];
  const groups = { a: 'group', c: 'group' };
  assert.deepEqual(reorderRepoTabs(repos, groups, 'a', 'd'), ['b', 'd', 'a', 'c']);
  assert.deepEqual(reorderRepoTabs(repos, groups, 'd', 'a'), ['d', 'a', 'b', 'c']);
  assert.deepEqual(reorderRepoTabs(repos, groups, 'a', 'c'), repos);
});

test('inserts on the indicated side of a tab or group', () => {
  const repos = ['a', 'b', 'c', 'd'];
  const groups = { b: 'group', c: 'group' };
  assert.deepEqual(reorderRepoTabs(repos, groups, 'a', 'b', false), repos);
  assert.deepEqual(reorderRepoTabs(repos, groups, 'a', 'b', true), ['b', 'c', 'a', 'd']);
  assert.deepEqual(reorderRepoTabs(repos, groups, 'd', 'b', false), ['a', 'd', 'b', 'c']);
  assert.deepEqual(reorderRepoTabs(repos, groups, 'd', 'b', true), repos);
});
