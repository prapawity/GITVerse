import type { Commit, GraphLayout, GraphRow, Segment } from '../shared/types';

/**
 * Lane assignment for a topologically ordered commit list (children before parents,
 * i.e. `git log --topo-order`). Each lane tracks the hash it is waiting for.
 * Every row emits segments for its top half (lines arriving) and bottom half (lines leaving).
 */
export function layoutGraph(commits: Commit[]): GraphLayout {
  const lanes: (string | null)[] = [];
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
      if (h) segments.push({ x1: k, x2: h === commit.hash ? col : k, color: colors[k], half: 'top' });
    });

    for (const m of matches) lanes[m] = null;

    // bottom half: pass-through lanes
    before.forEach((h, k) => {
      if (h && h !== commit.hash) segments.push({ x1: k, x2: k, color: colors[k], half: 'bottom' });
    });

    // bottom half: lines to parents
    commit.parents.forEach((p, i) => {
      const existing = lanes.indexOf(p);
      // First parent: always keep running straight down our own lane, even if that parent
      // is already tracked in another lane. The two lanes converge on the parent's own row
      // (its top half), so there is no sideways curl beside this commit.
      if (existing !== -1 && i > 0) {
        segments.push({ x1: col, x2: existing, color: i === 0 ? color : colors[existing], half: 'bottom' });
      } else if (i === 0) {
        lanes[col] = p;
        colors[col] = color;
        segments.push({ x1: col, x2: col, color, half: 'bottom' });
      } else {
        const s = freeSlot();
        lanes[s] = p;
        colors[s] = nextColor++;
        segments.push({ x1: col, x2: s, color: colors[s], half: 'bottom' });
      }
    });

    while (lanes.length && lanes[lanes.length - 1] === null) lanes.pop();
    maxLanes = Math.max(maxLanes, lanes.length, col + 1, before.length);
    rows.push({ commit, col, color, segments });
  }

  return { rows, maxLanes };
}
