import type { Commit, GraphLayout, GraphRow, Segment, StashRef } from '../shared/types';

export function withStashes(commits: Commit[], stashes: StashRef[]): Commit[] {
  const rows = [...commits];
  const seen = new Set<string>();
  for (const stash of [...stashes].sort((left, right) => (right.date ?? '').localeCompare(left.date ?? ''))) {
    if (!stash.hash || seen.has(stash.hash)) continue;
    seen.add(stash.hash);
    const commit: Commit = {
      hash: stash.hash,
      parents: stash.baseHash ? [stash.baseHash] : [],
      refs: [],
      author: stash.author ?? 'Unknown',
      email: stash.email ?? '',
      date: stash.date ?? '',
      subject: stash.message,
      body: stash.body?.split('\n').slice(1).join(' ').trim() || undefined,
      stashId: stash.id,
    };
    const existing = rows.findIndex((row) => row.hash === stash.hash);
    if (existing >= 0) {
      rows[existing] = { ...commit, refs: rows[existing].refs };
      continue;
    }
    const base = rows.findIndex((row) => row.hash === stash.baseHash);
    const older = rows.findIndex((row) => row.date < commit.date);
    const index = Math.min(base < 0 ? rows.length : base, older < 0 ? rows.length : older);
    rows.splice(index, 0, commit);
  }
  return rows;
}

/**
 * Lane assignment for a topologically ordered commit list (children before parents,
 * i.e. `git log --topo-order`). Each lane tracks the hash it is waiting for.
 * Every row emits segments for its top half (lines arriving) and bottom half (lines leaving).
 */
export function layoutGraph(commits: Commit[]): GraphLayout {
  const lanes: (string | null)[] = [];
  const stashLanes: boolean[] = [];
  const colors: number[] = [];
  let nextColor = 0;
  let maxLanes = 0;
  const rows: GraphRow[] = [];

  const freeSlot = () => {
    const i = lanes.indexOf(null);
    return i === -1 ? lanes.length : i;
  };

  for (const commit of commits) {
    const before = lanes.slice();
    const beforeStash = stashLanes.slice();
    const matches: number[] = [];
    before.forEach((h, k) => h === commit.hash && matches.push(k));

    let col: number;
    if (matches.length) col = matches[0];
    else {
      col = freeSlot();
      colors[col] = nextColor++;
    }
    const color = colors[col];
    const segments: Segment[] = [];

    // top half: everything that was already running down into this row
    before.forEach((h, k) => {
      if (h)
        segments.push({
          x1: k,
          x2: h === commit.hash ? col : k,
          color: colors[k],
          half: 'top',
          ...(beforeStash[k] ? { stash: true } : {}),
        });
    });

    for (const m of matches) lanes[m] = null;

    // bottom half: pass-through lanes
    before.forEach((h, k) => {
      if (h && h !== commit.hash)
        segments.push({ x1: k, x2: k, color: colors[k], half: 'bottom', ...(beforeStash[k] ? { stash: true } : {}) });
    });

    // bottom half: lines to parents
    commit.parents.forEach((p, i) => {
      const existing = lanes.indexOf(p);
      // First parent: always keep running straight down our own lane, even if that parent
      // is already tracked in another lane. The two lanes converge on the parent's own row
      // (its top half), so there is no sideways curl beside this commit.
      if (existing !== -1 && i > 0) {
        segments.push({
          x1: col,
          x2: existing,
          color: i === 0 ? color : colors[existing],
          half: 'bottom',
          ...(commit.stashId ? { stash: true } : {}),
        });
      } else if (i === 0) {
        lanes[col] = p;
        stashLanes[col] = !!commit.stashId;
        colors[col] = color;
        segments.push({ x1: col, x2: col, color, half: 'bottom', ...(commit.stashId ? { stash: true } : {}) });
      } else {
        const s = freeSlot();
        lanes[s] = p;
        stashLanes[s] = !!commit.stashId;
        colors[s] = nextColor++;
        segments.push({
          x1: col,
          x2: s,
          color: colors[s],
          half: 'bottom',
          ...(commit.stashId ? { stash: true } : {}),
        });
      }
    });

    while (lanes.length && lanes[lanes.length - 1] === null) lanes.pop();
    maxLanes = Math.max(maxLanes, lanes.length, col + 1, before.length);
    rows.push({ commit, col, color, segments });
  }

  return { rows, maxLanes };
}
