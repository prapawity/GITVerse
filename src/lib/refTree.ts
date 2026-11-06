/** Build a folder tree from slash-separated ref names ("origin/feature/x" -> origin > feature > x). */
export interface RefLeaf { full: string; current?: boolean }
export interface TreeNode {
  name: string; // this segment
  path: string; // segments up to and including this one, joined with "/"
  children: TreeNode[];
  leaf?: RefLeaf; // set when a ref ends exactly here
  count: number; // refs at or below this node
}

export function buildTree(items: RefLeaf[]): TreeNode[] {
  const root: TreeNode = { name: '', path: '', children: [], count: 0 };
  for (const it of items) {
    let node = root;
    const parts = it.full.split('/');
    parts.forEach((part, i) => {
      let next = node.children.find((c) => c.name === part);
      if (!next) {
        next = { name: part, path: parts.slice(0, i + 1).join('/'), children: [], count: 0 };
        node.children.push(next);
      }
      next.count++;
      node = next;
    });
    node.leaf = it;
  }
  const sort = (n: TreeNode) => {
    n.children.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base', numeric: true }));
    n.children.forEach(sort);
  };
  sort(root);
  return root.children;
}

export interface Row { node: TreeNode; depth: number; isFolder: boolean }

/** Flatten to the rows that are currently visible. `forceOpen` expands everything (used while filtering). */
export function visibleRows(nodes: TreeNode[], isOpen: (path: string) => boolean, forceOpen = false, depth = 0, out: Row[] = []): Row[] {
  for (const node of nodes) {
    const isFolder = node.children.length > 0;
    out.push({ node, depth, isFolder });
    if (isFolder && (forceOpen || isOpen(node.path))) visibleRows(node.children, isOpen, forceOpen, depth + 1, out);
  }
  return out;
}

/** Folders on the way to a ref, e.g. "feature/workspace/x" -> ["feature", "feature/workspace"]. */
export const ancestors = (full: string) => {
  const parts = full.split('/');
  return parts.slice(0, -1).map((_, i) => parts.slice(0, i + 1).join('/'));
};
