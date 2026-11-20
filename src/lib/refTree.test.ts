import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { buildTree, visibleRows } from './refTree';

test('hides a single remote root while retaining full branch names and folder paths', () => {
  const tree = buildTree([{ full: 'origin/main' }, { full: 'origin/feature/example' }], true);
  assert.deepEqual(
    tree.map((node) => node.name),
    ['feature', 'main'],
  );
  const rows = visibleRows(tree, () => true);
  assert.equal(rows.find(({ node }) => node.name === 'example')?.node.leaf?.full, 'origin/feature/example');
  assert.equal(tree[0].path, 'origin/feature');
});

test('keeps multiple remote roots distinct', () => {
  const tree = buildTree([{ full: 'origin/main' }, { full: 'upstream/main' }], true);
  assert.deepEqual(
    tree.map((node) => node.name),
    ['origin', 'upstream'],
  );
});
