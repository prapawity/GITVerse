/**
 * Undo / redo for Git actions done in the app (commit, checkout, reset, merge, rebase, cherry-pick,
 * revert, squash, branch rename). An entry is recorded only when the action really moved HEAD or the
 * branch. Undo checks first that the repository is still exactly where the action left it, so it
 * never resets over somebody else's work; staging has its own undo in the backend.
 */
import { create } from 'zustand';
import { desktopApi } from '../platform/api';

export interface Snapshot {
  head: string | null;
  branch: string | null;
}
type Kind = 'commit' | 'checkout' | 'history' | 'rename';
export interface ActionEntry {
  label: string;
  kind: Kind;
  before: Snapshot;
  after: Snapshot;
  at: number;
}
type Stacks = { undo: ActionEntry[]; redo: ActionEntry[] };

const LIMIT = 50;
let replaying = false;
export const isReplaying = () => replaying;

export const useActionHistory = create<{
  stacks: Record<string, Stacks>;
  lastStagingAt: number;
  markStaging: () => void;
  record: (repo: string, entry: Omit<ActionEntry, 'at'>) => void;
}>((set) => ({
  stacks: {},
  lastStagingAt: 0,
  markStaging: () => set({ lastStagingAt: Date.now() }),
  record: (repo, entry) =>
    set((s) => {
      if (replaying) return s;
      const current = s.stacks[repo] ?? { undo: [], redo: [] };
      return {
        stacks: {
          ...s.stacks,
          [repo]: { undo: [...current.undo, { ...entry, at: Date.now() }].slice(-LIMIT), redo: [] },
        },
      };
    }),
}));

export function snapshot(refs: { local: { name: string; current?: boolean }[]; headHash?: string | null }): Snapshot {
  return { head: refs.headHash ?? null, branch: refs.local.find((b) => b.current)?.name ?? null };
}

const same = (a: Snapshot, b: Snapshot) => a.head === b.head && a.branch === b.branch;

/** Classify an action that changed the repository; null when nothing moved. */
export function entryFor(label: string, kind: Kind, before: Snapshot, after: Snapshot): Omit<ActionEntry, 'at'> | null {
  if (same(before, after)) return null;
  if (kind === 'history' && before.branch !== after.branch) return null; // not a plain branch move
  return { label, kind, before, after };
}

export const peekUndo = (repo: string | null) =>
  repo ? (useActionHistory.getState().stacks[repo]?.undo.at(-1) ?? null) : null;
export const peekRedo = (repo: string | null) =>
  repo ? (useActionHistory.getState().stacks[repo]?.redo.at(-1) ?? null) : null;

/**
 * Undo (or redo) the latest entry. `current` and `dirty` describe the repository right now.
 * Returns the label of what was undone, or throws a readable error.
 */
export async function replay(
  repo: string,
  direction: 'undo' | 'redo',
  current: Snapshot,
  dirty: boolean,
): Promise<string> {
  const stacks = useActionHistory.getState().stacks[repo];
  const entry = direction === 'undo' ? stacks?.undo.at(-1) : stacks?.redo.at(-1);
  if (!entry) throw new Error(`Nothing to ${direction}.`);
  const from = direction === 'undo' ? entry.after : entry.before;
  const to = direction === 'undo' ? entry.before : entry.after;
  if (!same(current, from))
    throw new Error(
      `The repository changed after “${entry.label}”, so it cannot be ${direction === 'undo' ? 'undone' : 'redone'} safely. Use Recovery to go back further.`,
    );
  const api = desktopApi();
  replaying = true;
  try {
    if (entry.kind === 'checkout') {
      await api.checkout(repo, to.branch ?? to.head);
    } else if (entry.kind === 'rename') {
      await api.renameBranch(repo, from.branch, to.branch);
    } else {
      if (!to.head) throw new Error('There is no earlier commit to return to.');
      // commit: soft reset keeps the committed changes staged; other moves need a clean working tree
      if (entry.kind !== 'commit' && dirty)
        throw new Error('Commit or stash your changes first: undoing this resets the working tree.');
      await api.reset(repo, to.head, entry.kind === 'commit' ? 'soft' : 'hard');
    }
  } finally {
    replaying = false;
  }
  useActionHistory.setState((s) => {
    const st = s.stacks[repo] ?? { undo: [], redo: [] };
    return {
      stacks: {
        ...s.stacks,
        [repo]:
          direction === 'undo'
            ? { undo: st.undo.slice(0, -1), redo: [...st.redo, entry] }
            : { undo: [...st.undo, entry], redo: st.redo.slice(0, -1) },
      },
    };
  });
  return entry.label;
}
