import { useEffect, useState } from 'react';
import { Lock, LockOpen, Plus, RefreshCw, Trash2, X } from 'lucide-react';
import { platformApi } from '../platform/api';
import { useRepo } from '../store/repoStore';
import { askConfirm } from './Dialogs';
import { RepoTools } from './RepoTools';

type Inspection = {
  remotes: { name: string; fetch: string[]; push: string[] }[];
  worktrees: {
    path: string;
    head: string;
    branch?: string;
    detached: boolean;
    bare: boolean;
    locked: boolean;
    prunable: boolean;
  }[];
};

/** git prints worktree paths with forward slashes; show them the way the OS writes them. */
const displayPath = (p: string) =>
  /^[A-Za-z]:\//.test(p) && /Win/.test(navigator.platform) ? p.replace(/\//g, '\\') : p;

export function WorkspaceInspectionPanel({ repoPath, onClose }: { repoPath: string; onClose: () => void }) {
  const [result, setResult] = useState<Inspection | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [revision, setRevision] = useState(0);
  const [remoteName, setRemoteName] = useState('');
  const [remoteUrl, setRemoteUrl] = useState('');
  const [remoteBusy, setRemoteBusy] = useState(false);
  const addRemote = async () => {
    setRemoteBusy(true);
    setError('');
    try {
      await useRepo.getState().exec('addRemote', remoteName.trim(), remoteUrl.trim());
      setRemoteName('');
      setRemoteUrl('');
      setRevision((value) => value + 1);
    } finally {
      setRemoteBusy(false);
    }
  };
  const exec = useRepo((state) => state.exec);
  const runWorktree = async (fn: () => Promise<void>) => {
    await fn();
    setRevision((value) => value + 1);
  };
  const removeWorktree = async (path: string, force: boolean, branch?: string) => {
    if (
      !(await askConfirm(
        'Remove worktree',
        `Remove the worktree at ${displayPath(path)}?${branch ? ` The branch ${branch} is deleted too (only if it is merged).` : ''} Uncommitted changes there would block this.`,
        { label: 'Remove', danger: true },
      ))
    )
      return;
    await runWorktree(() => exec('worktreeRemove', path, force, branch ?? null));
  };
  const removeRemote = async (name: string) => {
    if (
      !(await askConfirm(
        'Remove remote',
        `Remove the remote "${name}"? Its remote-tracking branches are removed too. Nothing is deleted on the server.`,
        { label: 'Remove', danger: true },
      ))
    )
      return;
    await useRepo.getState().exec('removeRemote', name);
    setRevision((value) => value + 1);
  };
  useEffect(() => {
    let active = true;
    setLoading(true);
    setResult(null);
    setError('');
    const api = platformApi();
    if (!api?.inspectWorkspace) {
      setError('Workspace inspection is available in the desktop app.');
      setLoading(false);
      return;
    }
    api
      .inspectWorkspace(repoPath)
      .then(
        (value: Inspection) => {
          if (active) setResult(value);
        },
        (reason: unknown) => {
          if (active)
            setError(
              String((reason as Error)?.message ?? reason).replace(
                /^Error invoking remote method '[^']*': (Error: )?/,
                '',
              ),
            );
        },
      )
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [repoPath, revision]);

  return (
    <section aria-label="Remotes and worktrees" className="glass-panel flex h-full min-h-0 flex-col">
      <header className="glass-detail-header flex items-center gap-2 border-b border-surface px-4 py-3">
        <div className="min-w-0 flex-1">
          <h2 className="text-sm font-semibold">Workspace</h2>
          <p className="text-xs text-sub">Repository connections and checkouts</p>
        </div>
        <button
          type="button"
          aria-label="Refresh remotes and worktrees"
          title="Refresh"
          onClick={() => setRevision((v) => v + 1)}
          className="rounded-md p-2 hover:bg-surface/60"
        >
          <RefreshCw size={16} aria-hidden />
        </button>
        <button
          type="button"
          aria-label="Close remotes and worktrees"
          title="Close"
          onClick={onClose}
          className="btn-ghost p-2"
        >
          <X size={16} aria-hidden />
        </button>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto" aria-busy={loading}>
        {loading && (
          <p role="status" className="p-4 text-sm text-sub">
            Loading workspace…
          </p>
        )}
        {error && (
          <p role="alert" className="p-4 text-sm text-danger">
            {error}
          </p>
        )}
        {result && (
          <>
            <section aria-labelledby="remote-list-heading" className="border-b border-surface px-4 py-4">
              <h3 id="remote-list-heading" className="text-sm font-semibold">
                Remotes <span className="font-normal text-sub">({result.remotes.length})</span>
              </h3>
              <p className="mt-1 text-xs text-sub">Credentials and URL parameters are hidden.</p>
              {result.remotes.length ? (
                result.remotes.map((remote) => (
                  <article key={remote.name} className="glass-detail-card mt-3 rounded-lg border border-surface p-3">
                    <div className="flex items-start gap-2">
                      <h4 className="flex-1 break-all text-sm font-medium">{remote.name}</h4>
                      <button
                        type="button"
                        onClick={() => void removeRemote(remote.name)}
                        aria-label={`Remove remote ${remote.name}`}
                        title={`Remove remote ${remote.name}`}
                        className="rounded p-1 text-sub hover:bg-danger/15 hover:text-danger"
                      >
                        <Trash2 size={14} />
                      </button>
                    </div>
                    {remote.fetch.map((url, index) => (
                      <p key={`fetch-${index}`} className="mt-1 break-all text-xs text-sub">
                        <span className="font-medium text-text">Fetch: </span>
                        {url}
                      </p>
                    ))}
                    {remote.push.map((url, index) => (
                      <p key={`push-${index}`} className="mt-1 break-all text-xs text-sub">
                        <span className="font-medium text-text">Push: </span>
                        {url}
                      </p>
                    ))}
                    {!remote.push.length && remote.fetch.length > 0 && (
                      <p className="mt-1 text-xs text-sub">Push uses the fetch URL.</p>
                    )}
                  </article>
                ))
              ) : (
                <p className="mt-3 text-sm text-sub">No remotes are configured.</p>
              )}
              <form
                className="mt-3 space-y-2 rounded-lg border border-dashed border-surface p-3"
                onSubmit={(event) => {
                  event.preventDefault();
                  void addRemote();
                }}
              >
                <p className="text-xs font-medium">Add remote</p>
                <div className="flex gap-2">
                  <input
                    value={remoteName}
                    onChange={(e) => setRemoteName(e.target.value)}
                    placeholder="Name (e.g. upstream)"
                    aria-label="Remote name"
                    className="w-1/3 rounded-md border border-surface bg-crust px-2 py-1.5 text-sm outline-none focus:border-accent"
                  />
                  <input
                    value={remoteUrl}
                    onChange={(e) => setRemoteUrl(e.target.value)}
                    placeholder="URL"
                    aria-label="Remote URL"
                    className="min-w-0 flex-1 rounded-md border border-surface bg-crust px-2 py-1.5 text-sm outline-none focus:border-accent"
                  />
                  <button
                    type="submit"
                    disabled={!remoteName.trim() || !remoteUrl.trim() || remoteBusy}
                    aria-label="Add remote"
                    className="btn-secondary flex shrink-0 items-center px-2"
                  >
                    <Plus size={15} />
                  </button>
                </div>
              </form>
            </section>
            <section aria-labelledby="worktree-list-heading" className="px-4 py-4">
              <h3 id="worktree-list-heading" className="text-sm font-semibold">
                Worktrees <span className="font-normal text-sub">({result.worktrees.length})</span>
              </h3>
              {result.worktrees.length ? (
                result.worktrees.map((worktree, index) => (
                  <article key={worktree.path} className="glass-detail-card mt-3 rounded-lg border border-surface p-3">
                    <h4 className="text-sm font-medium [overflow-wrap:anywhere]" title={displayPath(worktree.path)}>
                      {displayPath(worktree.path)
                        .split(/(?<=[\\/])/)
                        .map((part, index) => (
                          <span key={index}>
                            {part}
                            <wbr />
                          </span>
                        ))}
                    </h4>
                    <p className="mt-1 break-all text-xs text-sub">
                      {worktree.bare
                        ? 'Bare repository'
                        : worktree.detached
                          ? 'Detached HEAD'
                          : worktree.branch
                            ? `Branch: ${worktree.branch}`
                            : 'No branch'}
                      {worktree.head ? ` · ${worktree.head.slice(0, 7)}` : ''}
                    </p>
                    {(worktree.locked || worktree.prunable) && (
                      <p className="mt-1 text-xs text-[#fab387]">
                        {[worktree.locked && 'Locked', worktree.prunable && 'Prunable'].filter(Boolean).join(' · ')}
                      </p>
                    )}
                    {index > 0 && !worktree.bare && (
                      <div className="mt-2 flex flex-wrap gap-1.5">
                        <button
                          type="button"
                          onClick={() => void runWorktree(() => exec('worktreeLock', worktree.path, !worktree.locked))}
                          className="btn-secondary flex items-center gap-1 px-2 py-1 text-xs"
                        >
                          {worktree.locked ? <LockOpen size={12} /> : <Lock size={12} />}
                          {worktree.locked ? 'Unlock' : 'Lock'}
                        </button>
                        <button
                          type="button"
                          disabled={worktree.locked}
                          title={worktree.locked ? 'Unlock it first' : undefined}
                          onClick={() => void removeWorktree(worktree.path, false)}
                          className="rounded border border-danger/40 px-2 py-1 text-xs text-danger hover:bg-danger/10 disabled:opacity-40"
                        >
                          Remove
                        </button>
                        {worktree.branch && (
                          <button
                            type="button"
                            disabled={worktree.locked}
                            onClick={() =>
                              void removeWorktree(worktree.path, false, worktree.branch!.replace(/^refs\/heads\//, ''))
                            }
                            className="rounded border border-danger/40 px-2 py-1 text-xs text-danger hover:bg-danger/10 disabled:opacity-40"
                          >
                            Remove and delete branch
                          </button>
                        )}
                      </div>
                    )}
                  </article>
                ))
              ) : (
                <p className="mt-3 text-sm text-sub">No worktrees found.</p>
              )}
            </section>
            <RepoTools repoPath={repoPath} />
          </>
        )}
      </div>
    </section>
  );
}
