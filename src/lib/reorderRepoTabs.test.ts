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
