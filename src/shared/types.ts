export interface RefLabel {
  name: string;
  kind: 'head' | 'local' | 'remote' | 'tag';
  current?: boolean;
}

export interface Commit {
  hash: string;
  parents: string[];
  refs: RefLabel[];
  author: string;
  email: string;
  date: string; // ISO
  subject: string;
  body?: string; // first non-empty line of the body
}

export interface Segment {
  x1: number; // lane index at start of half-row
  x2: number; // lane index at end
  color: number;
  half: 'top' | 'bottom';
}

export interface GraphRow {
  commit: Commit;
  col: number;
  color: number;
  segments: Segment[];
}

export interface GraphLayout {
  rows: GraphRow[];
  maxLanes: number;
}

export interface FileStatus {
  path: string;
  index: string; // X of porcelain XY
  worktree: string; // Y
  oldPath?: string;
}
