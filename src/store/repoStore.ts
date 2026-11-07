import { create } from 'zustand';
import { layoutGraph, withStashes } from '../lib/graphLayout';
import type { Commit, FileStatus, GraphLayout, StashRef } from '../shared/types';
import { useSettings } from './settingsStore';

const api = () => (window as any).gitApi;
// page size follows the user's settings: "show all" means one unbounded page, otherwise the initial-commits value
const pageSize = () => {
  const s = useSettings.getState();
  return s.showAll ? 1_000_000_000 : s.initialCommits;
};

interface RepoState {
  repoPath: string | null;
  recentRepos: string[];
  commits: Commit[];
  hasMore: boolean;
  loadingMore: boolean;
  loadMore: () => Promise<void>;
  ensureCommitVisible: (hash: string) => Promise<boolean>;
  graph: GraphLayout;
  status: FileStatus[];
  commitDrafts: Record<string, { summary: string; description: string; amend: boolean; signoff: boolean }>;
  setCommitDraft: (
    repo: string,
    draft: { summary: string; description: string; amend: boolean; signoff: boolean } | null,
  ) => void;
  prefillAmendDraft: (repo: string) => Promise<void>;
  selectedHash: string | null;
  search: string;
  error: string | null;
  refs: {
    local: { name: string; current: boolean; hash?: string }[];
    remote: { name: string; hash?: string }[];
    tags: { name: string }[];
    stashes: StashRef[];
    headHash?: string | null;
  };
  detail: { hash: string; body: string; files: { status: string; path: string; oldPath?: string }[] } | null;
  busy: string | null;
  operation: {
    kind: 'rebase' | 'merge' | 'cherry-pick' | 'revert';
    step?: string;
    files: string[];
    resolved: { status: string; path: string }[];
    head: string;
    onto: string;
    message: string;
  } | null;
  conflictView: boolean; // right panel shows the conflict workflow instead of commit details
  conflictFile: string | null; // file open in the merge tool
  showConflicts: () => void;
  openConflict: (path: string | null) => void;
  working: string | null; // label of the long-running operation in flight, e.g. 'Pushing…'
  loading: boolean; // repo data (history/status/refs) is being fetched
  track: (label: string, fn: () => Promise<void>, meta?: Meta) => Promise<void>;
  blocking: boolean; // the running operation changes HEAD / the working tree: a full-screen overlay covers the app
  errorTitle: string | null;
  toasts: Toast[];
  activity: Activity[];
  recordActivity: (kind: Toast['kind'], title: string, detail?: string, repo?: string | null) => void;
  clearActivity: () => void;
  indexUndo: boolean;
  indexRedo: boolean;
  refreshIndexHistory: () => Promise<void>;
  moveIndexHistory: (direction: 'undo' | 'redo') => Promise<void>;
  notify: (kind: Toast['kind'], title: string, detail?: string) => number;
  dismissToast: (id: number) => void;
  toast: (msg: string) => void; // shorthand for a success toast
  closeRepo: (path: string) => void;
  action: (name: 'fetch' | 'pull' | 'push' | 'stash' | 'stashPop', ...args: unknown[]) => Promise<void>;
  createBranch: (name: string) => Promise<void>;
  exec: (name: string, ...args: unknown[]) => Promise<void>;

  openRepo: (path?: string) => Promise<void>;
  refresh: (silent?: boolean) => Promise<void>;
  refreshStatus: () => Promise<void>;
  syncAfterPush: (cwd: string) => Promise<void>;
  autoFetch: () => Promise<void>;
  select: (hash: string | null) => void;
  setSearch: (q: string) => void;
  checkout: (ref: string) => Promise<void>;
  checkoutRemote: (ref: string) => Promise<void>;
  commit: (summary: string, description?: string, opts?: { amend?: boolean; signoff?: boolean }) => Promise<void>;
}

export interface Toast {
  id: number;
  kind: 'success' | 'error' | 'warning' | 'info';
  title: string;
  detail?: string;
}
export interface Activity extends Toast {
  time: number;
  repo: string | null;
}
type Meta = { blocking?: boolean; fail?: string; done?: string | (() => string | null) };

export const useRepo = create<RepoState>((set, get) => {
  let toastSeq = 0;
  let checkingStatus = false;
  let statusErrorReported = false;
  // Electron prefixes IPC failures with "Error invoking remote method 'x': Error: " — noise for the user
  const clean = (m: unknown) => String(m).replace(/^Error invoking remote method '[^']*': (Error: )?/, '');

  /** Runs fn with progress state, then tells the user how it went: a success toast, or an error toast that stays until dismissed. */
  const guard = async (fn: () => Promise<void>, label?: string, meta: Meta = {}) => {
    let ok = false;
    try {
      set(label ? { error: null, working: label, blocking: !!meta.blocking } : { error: null });
      await fn();
      ok = true;
    } catch (e: any) {
      get().notify(
        'error',
        meta.fail ?? (label ? label.replace(/…$/, '') + ' failed' : 'Something went wrong'),
        clean(e?.message ?? e),
      );
    } finally {
      if (label) set((s) => (s.working === label ? { working: null, blocking: false } : {}));
    }
    if (ok && meta.done) {
      const msg = typeof meta.done === 'function' ? meta.done() : meta.done;
      if (msg) get().notify('success', msg);
    }
  };
  // Run a git command. If it fails *because it stopped on conflicts*, that is not an error to scold the
  // user about: refresh so the conflict banner appears and tell them what to do next.
  const attempt = async (fn: () => Promise<unknown>): Promise<boolean> => {
    const before = get().operation;
    try {
      await fn();
      return false;
    } catch (e) {
      await get().refresh();
      if (!before && get().operation) {
        get().notify('warning', 'Stopped on conflicts', 'Resolve every conflicted file, then continue.');
        return true; // stopped, not failed: the caller must not report success
      }
      throw e;
    }
  };
  // per git action: progress label, failure headline, and whether it blocks the whole UI while it runs
  const OPS: Record<string, { label: string; fail: string; blocking?: boolean }> = {
    fetch: { label: 'Fetching…', fail: 'Fetch failed' },
    pull: { label: 'Pulling…', fail: 'Pull failed', blocking: true },
    push: { label: 'Pushing…', fail: 'Push failed' },
    stash: { label: 'Stashing changes…', fail: 'Stash failed', blocking: true },
    stashPop: { label: 'Applying stash…', fail: 'Could not apply stash', blocking: true },
    reset: { label: 'Resetting…', fail: 'Reset failed', blocking: true },
    squashCommits: { label: 'Squashing commits…', fail: 'Squash failed', blocking: true },
    cherryPick: { label: 'Cherry-picking…', fail: 'Cherry-pick failed', blocking: true },
    cherryPickMany: { label: 'Cherry-picking commits…', fail: 'Cherry-pick failed', blocking: true },
    revert: { label: 'Reverting…', fail: 'Revert failed', blocking: true },
    rebaseOnto: { label: 'Rebasing…', fail: 'Rebase failed', blocking: true },
    opContinue: { label: 'Continuing…', fail: 'Could not continue', blocking: true },
    opAbort: { label: 'Aborting…', fail: 'Could not abort', blocking: true },
    opSkip: { label: 'Skipping commit…', fail: 'Could not skip', blocking: true },
    resolveFile: { label: 'Resolving…', fail: 'Could not resolve file' },
    merge: { label: 'Merging…', fail: 'Merge failed', blocking: true },
    deleteBranch: { label: 'Deleting branch…', fail: 'Could not delete the branch' },
    createTag: { label: 'Creating tag…', fail: 'Could not create tag' },
    createAnnotatedTag: { label: 'Creating tag…', fail: 'Could not create tag' },
    branchAt: { label: 'Creating branch…', fail: 'Could not create branch', blocking: true },
    worktreeAdd: { label: 'Creating worktree…', fail: 'Could not create worktree' },
  };
  const short = (h: unknown) => String(h).slice(0, 7);
  const KIND = { rebase: 'Rebase', merge: 'Merge', 'cherry-pick': 'Cherry-pick', revert: 'Revert' } as const;
  /** Success message for a finished action (null = say nothing). Read after the refresh, so it can look at fresh state. */
  const doneMsg = (name: string, args: unknown[], before: RepoState['operation']): string | null => {
    const op = get().operation;
    switch (name) {
      case 'fetch':
        return args[0] === 'all' ? 'Fetched from all remotes' : 'Pulled from remote';
      case 'pull':
        return 'Pulled the latest changes';
      case 'push':
        return 'Pushed to remote';
      case 'stash':
        return 'Changes stashed';
      case 'stashPop':
        return 'Stash applied';
      case 'reset':
        return `Reset (${args[1]}) to ${short(args[0])}`;
      case 'squashCommits':
        return 'Commits squashed';
      case 'cherryPick':
        return `Cherry-picked ${short(args[0])}`;
      case 'cherryPickMany':
        return 'Cherry-picked selected commits';
      case 'revert':
        return `Reverted ${short(args[0])}`;
      case 'rebaseOnto':
        return `Rebased onto ${short(args[0])}`;
      case 'merge':
        return `Merged ${args[0]}`;
      case 'deleteBranch':
        return `Deleted branch “${args[0]}”`;
      case 'createTag':
      case 'createAnnotatedTag':
        return `Tag “${args[0]}” created`;
      case 'branchAt':
        return `Branch “${args[0]}” created and checked out`;
      case 'worktreeAdd':
        return 'Worktree created';
      case 'opContinue':
        return !op && before ? `${KIND[before.kind]} completed` : 'Continued — more conflicts to resolve';
      case 'opAbort':
        return before ? `${KIND[before.kind]} aborted` : 'Aborted';
      case 'opSkip':
        return 'Commit skipped';
      default:
        return null;
    }
  };

  return {
    repoPath: null,
    recentRepos: [],
    commits: [],
    hasMore: false,
    loadingMore: false,
    graph: { rows: [], maxLanes: 0 },
    status: [],
    commitDrafts: {},
    setCommitDraft: (repo, draft) =>
      set((s) => {
        const commitDrafts = { ...s.commitDrafts };
        if (draft) commitDrafts[repo] = draft;
        else delete commitDrafts[repo];
        return { commitDrafts };
      }),
    prefillAmendDraft: async (repo) => {
      if (get().repoPath !== repo) return;
      const original = get().commitDrafts[repo];
      const head = get().refs.headHash;
      const detail: { body: string } = await api().commitDetail(repo, 'HEAD');
      const latest = get();
      if (latest.repoPath !== repo || latest.commitDrafts[repo] !== original || latest.refs.headHash !== head) return;
      const [summary, ...description] = detail.body.split(/\r?\n/);
      get().setCommitDraft(repo, {
        summary,
        description: description.join('\n').trim(),
        amend: true,
        signoff: original?.signoff ?? false,
      });
    },
    selectedHash: null,
    search: '',
    error: null,
    refs: { local: [], remote: [], tags: [], stashes: [] },
    detail: null,
    busy: null,
    operation: null,
    conflictView: false,
    conflictFile: null,
    showConflicts: () => set({ conflictView: true }),
    openConflict: (path) => set({ conflictFile: path, conflictView: path ? true : get().conflictView }),
    working: null,
    loading: false,
    track: (label, fn, meta) => guard(fn, label, meta),
    blocking: false,
    errorTitle: null,
    toasts: [],
    activity: [],
    indexUndo: false,
    indexRedo: false,
    refreshIndexHistory: async () => {
      const cwd = get().repoPath;
      if (!cwd) {
        set({ indexUndo: false, indexRedo: false });
        return;
      }
      try {
        const result = await api().indexUndoState(cwd);
        if (get().repoPath === cwd) set({ indexUndo: result.undo, indexRedo: result.redo });
      } catch {
        if (get().repoPath === cwd) set({ indexUndo: false, indexRedo: false });
      }
    },
    moveIndexHistory: async (direction) => {
      const cwd = get().repoPath;
      if (!cwd || get().working) return;
      await guard(
        async () => {
          await api().moveIndexHistory(cwd, direction);
          if (get().repoPath === cwd) {
            await get().refreshStatus();
          }
        },
        direction === 'undo' ? 'Undoing staging…' : 'Redoing staging…',
        {
          fail: `${direction === 'undo' ? 'Undo' : 'Redo'} failed`,
          done: direction === 'undo' ? 'Staging action undone' : 'Staging action redone',
        },
      );
      if (get().repoPath === cwd) await get().refreshIndexHistory();
    },
    recordActivity: (kind, title, detail, repo) =>
      set((s) => ({
        activity: [
          { id: ++toastSeq, kind, title, detail, time: Date.now(), repo: repo === undefined ? s.repoPath : repo },
          ...s.activity,
        ].slice(0, 200),
      })),
    clearActivity: () => set({ activity: [] }),
    notify: (kind, title, detail) => {
      const id = ++toastSeq;
      set((s) => ({
        toasts: [...s.toasts.slice(-3), { id, kind, title, detail }],
        activity: [{ id, kind, title, detail, time: Date.now(), repo: s.repoPath }, ...s.activity].slice(0, 200),
      })); // keep at most 4 on screen
      return id;
    },
    dismissToast: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
    toast: (msg) => {
      get().notify('success', msg);
    },

    closeRepo: (path) => {
      const rest = get().recentRepos.filter((r) => r !== path);
      set({ recentRepos: rest });
      if (get().repoPath === path) {
        if (rest[0]) get().openRepo(rest[0]);
        else
          set({
            repoPath: null,
            commits: [],
            graph: { rows: [], maxLanes: 0 },
            status: [],
            detail: null,
            selectedHash: null,
            refs: { local: [], remote: [], tags: [], stashes: [] },
            operation: null,
            conflictView: false,
            conflictFile: null,
            hasMore: false,
            loadingMore: false,
            loading: false,
            indexUndo: false,
            indexRedo: false,
          });
      }
    },

    action: (name, ...args) => {
      let stopped = false;
      const before = get().operation;
      const actionArgs = name === 'fetch' && !args.length ? [useSettings.getState().fetchMode] : args;
      return guard(
        async () => {
          set({ busy: name });
          const cwd = get().repoPath;
          try {
            stopped = await attempt(() =>
              name === 'fetch'
                ? actionArgs[0] === 'all'
                  ? api().fetch(cwd, useSettings.getState().autoPrune)
                  : api().pull(cwd, actionArgs[0])
                : name === 'stash'
                  ? api().stash(cwd, actionArgs[0])
                  : api()[name](cwd),
            );
            if (name === 'push' && cwd) await get().syncAfterPush(cwd);
            else if (get().repoPath === cwd) await get().refresh();
          } finally {
            set({ busy: null });
          }
        },
        OPS[name].label,
        {
          blocking: OPS[name].blocking,
          fail: OPS[name].fail,
          done: () => (stopped ? null : doneMsg(name, actionArgs, before)),
        },
      );
    },

    exec: (name, ...args) => {
      let stopped = false;
      const before = get().operation;
      const op = OPS[name] ?? { label: 'Working…', fail: 'Action failed' };
      return guard(
        async () => {
          stopped = await attempt(() => api()[name](get().repoPath, ...args));
          await get().refresh();
        },
        op.label,
        { blocking: op.blocking, fail: op.fail, done: () => (stopped ? null : doneMsg(name, args, before)) },
      );
    },

    createBranch: (name) =>
      guard(
        async () => {
          await api().createBranch(get().repoPath, name);
          await get().refresh();
        },
        'Creating branch…',
        { blocking: true, fail: 'Could not create branch', done: `Branch “${name}” created and checked out` },
      ),

    openRepo: (p) =>
      guard(
        async () => {
          const path = p ?? (await api().openRepoDialog());
          if (!path) return;
          // switching repos: drop the previous repo's data so the skeleton shows instead of stale history
          const switching = path !== get().repoPath;
          set((s) => ({
            repoPath: path,
            recentRepos: s.recentRepos.includes(path) ? s.recentRepos : [...s.recentRepos, path],
            ...(switching
              ? {
                  commits: [],
                  graph: { rows: [], maxLanes: 0 },
                  status: [],
                  detail: null,
                  selectedHash: null,
                  hasMore: false,
                  refs: { local: [], remote: [], tags: [], stashes: [] },
                }
              : {}),
          }));
          await get().refresh();
          await get().refreshIndexHistory();
        },
        'Opening repository…',
        { fail: 'Could not open the repository' },
      ),

    refreshStatus: async () => {
      const cwd = get().repoPath;
      if (!cwd || checkingStatus) return;
      checkingStatus = true;
      const before = get();
      try {
        const [status, refs, operation] = await Promise.all([api().status(cwd), api().refs(cwd), api().opState(cwd)]);
        if (get().repoPath !== cwd || get().commits !== before.commits) return;
        const historyChanged =
          JSON.stringify(refs) !== JSON.stringify(before.refs) ||
          JSON.stringify(operation) !== JSON.stringify(before.operation);
        set({ status });
        if (historyChanged) {
          await get().refresh(true);
          if (get().repoPath === cwd && JSON.stringify(get().refs) === JSON.stringify(refs)) {
            get().notify(
              'info',
              'Repository changed outside GITVerse',
              'Reloaded history, branch references and working changes.',
            );
          }
        } else await get().refreshIndexHistory();
        statusErrorReported = false;
      } catch (error) {
        if (get().repoPath === cwd && !statusErrorReported) {
          get().notify(
            'warning',
            'Could not refresh repository',
            clean(error instanceof Error ? error.message : error),
          );
          statusErrorReported = true;
        }
      } finally {
        checkingStatus = false;
      }
    },

    syncAfterPush: async (cwd) => {
      try {
        await api().fetch(cwd, useSettings.getState().autoPrune);
      } catch (error) {
        get().notify(
          'warning',
          'Push succeeded, but fetching remote updates failed',
          clean(error instanceof Error ? error.message : error),
        );
      }
      if (get().repoPath === cwd) await get().refresh(true);
    },

    // background fetch: never shows a spinner or an error banner (being offline is normal)
    autoFetch: async () => {
      const { repoPath: cwd, operation, working, loading } = get();
      if (!cwd || operation || working || loading) return;
      try {
        await api().fetch(cwd, useSettings.getState().autoPrune);
        if (get().repoPath === cwd && !get().working) await get().refresh(true);
      } catch {
        /* ignore */
      }
    },

    refresh: (silent) =>
      guard(
        async () => {
          const cwd = get().repoPath;
          if (!cwd) return;
          if (!silent) set({ loading: true });
          try {
            const limit = Math.max(pageSize(), silent ? get().commits.length : 0);
            const [commits, status, refs, operation] = await Promise.all([
              api().log(cwd, limit, 0),
              api().status(cwd),
              api().refs(cwd),
              api().opState(cwd),
            ]);
            if (get().repoPath !== cwd) return; // switched repos while waiting
            const was = get().operation;
            // entering a conflicted state brings the conflict workflow forward; leaving it tidies up
            const extra =
              operation && !was
                ? { conflictView: true }
                : !operation
                  ? { conflictView: false, conflictFile: null }
                  : {};
            if (operation && get().conflictFile && !operation.files.includes(get().conflictFile!))
              Object.assign(extra, { conflictFile: null });
            set({
              ...extra,
              commits,
              status,
              refs,
              operation,
              graph: layoutGraph(withStashes(commits, refs.stashes)),
              hasMore: useSettings.getState().lazyLoad && !useSettings.getState().showAll && commits.length === limit,
              loadingMore: false,
            });
            await get().refreshIndexHistory();
          } finally {
            set({ loading: false });
          }
        },
        undefined,
        { fail: 'Could not read the repository' },
      ),

    // Fetch the next page of history on demand instead of loading the whole repo up front.
    loadMore: async () => {
      const { repoPath: cwd, hasMore, loadingMore, commits } = get();
      if (!cwd || !hasMore || loadingMore) return;
      set({ loadingMore: true });
      try {
        const next: Commit[] = await api().log(cwd, pageSize(), commits.length);
        // ignore the result if the repo was switched or refreshed while we were waiting
        if (get().repoPath !== cwd || get().commits.length !== commits.length) return;
        const all = [...commits, ...next];
        set({
          commits: all,
          graph: layoutGraph(withStashes(all, get().refs.stashes)),
          hasMore: next.length === pageSize(),
        });
      } catch (e: any) {
        get().notify('error', 'Could not load more commits', clean(e.message));
        set({ hasMore: false });
      } finally {
        set({ loadingMore: false });
      }
    },

    ensureCommitVisible: async (hash) => {
      const { repoPath: cwd, commits, loadingMore, hasMore } = get();
      if (!cwd) return false;
      if (commits.some((c) => c.hash === hash) || get().refs.stashes.some((stash) => stash.hash === hash)) return true;
      if (loadingMore) {
        get().notify('info', 'History is loading', 'Try navigating again when loading completes.');
        return false;
      }
      set({ loadingMore: true });
      try {
        const index: number = await api().historyPosition(cwd, hash);
        const loaded: Commit[] = await api().log(cwd, Math.max(index + 1, commits.length), 0);
        if (get().repoPath !== cwd) return false;
        if (get().commits !== commits) {
          if (get().commits.some((c) => c.hash === hash)) return true;
          throw new Error('History changed while loading. Try again.');
        }
        if (!loaded.some((c) => c.hash === hash))
          throw new Error('The branch moved while loading. Refresh and try again.');
        set({ commits: loaded, graph: layoutGraph(withStashes(loaded, get().refs.stashes)), hasMore });
        return true;
      } catch (e: any) {
        if (get().repoPath === cwd) get().notify('error', 'Could not locate commit', clean(e.message));
        return false;
      } finally {
        if (get().repoPath === cwd) set({ loadingMore: false });
      }
    },

    select: (hash) => {
      set({ selectedHash: hash, detail: null, conflictView: false, conflictFile: null });
      const cwd = get().repoPath;
      if (hash && cwd)
        api()
          .commitDetail(cwd, hash)
          .then((d: any) => {
            if (get().selectedHash === hash && get().repoPath === cwd) set({ detail: { hash, ...d } });
          })
          .catch((e: Error) => {
            // settle the spinner with an empty result so the panel never loads forever
            if (get().selectedHash === hash && get().repoPath === cwd) {
              get().notify('error', 'Could not load commit details', clean(e.message));
              set({ detail: { hash, body: '', files: [] } });
            }
          });
    },
    setSearch: (search) => set({ search }),

    checkout: (ref) =>
      guard(
        async () => {
          await api().checkout(get().repoPath, ref);
          await get().refresh();
        },
        'Checking out…',
        { blocking: true, fail: 'Checkout failed', done: `Checked out “${ref}”` },
      ),

    checkoutRemote: (ref) =>
      guard(
        async () => {
          await api().checkoutRemote(get().repoPath, ref);
          await get().refresh();
        },
        'Checking out…',
        { blocking: true, fail: 'Checkout failed', done: `Checked out “${ref}” in detached HEAD mode` },
      ),

    commit: (summary, description, opts) =>
      guard(
        async () => {
          await api().commit(get().repoPath, summary, description, opts);
          await get().refresh();
        },
        'Committing…',
        { blocking: true, fail: 'Commit failed', done: 'Commit created' },
      ),
  };
});
