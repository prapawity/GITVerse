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
  stashId?: string;
}

export interface StashRef {
  id: string;
  message: string;
  hash?: string;
  baseHash?: string;
  author?: string;
  email?: string;
  date?: string;
  body?: string;
}

export interface StashDetail extends StashRef {
  hash: string;
  baseHash: string;
  files: { status: string; path: string; oldPath?: string; untracked?: boolean }[];
}

export interface Segment {
  x1: number; // lane index at start of half-row
  x2: number; // lane index at end
  color: number;
  half: 'top' | 'bottom';
  stash?: boolean;
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

export interface FileChangeCount {
  path: string;
  staged: number | null;
  unstaged: number | null;
}
