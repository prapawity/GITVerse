import { useEffect, useState } from 'react';
import { RefreshCw, X } from 'lucide-react';

type Inspection = {
  remotes: { name: string; fetch: string[]; push: string[] }[];
  worktrees: { path: string; head: string; branch?: string; detached: boolean; bare: boolean; locked: boolean; prunable: boolean }[];
};

export function WorkspaceInspectionPanel({ repoPath, onClose }: { repoPath: string; onClose: () => void }) {
  const [result, setResult] = useState<Inspection | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    let active = true;
    setLoading(true);
    setResult(null);
    setError('');
    const api = (window as any).gitApi;
    if (!api?.inspectWorkspace) {
      setError('Workspace inspection is available in the desktop app.');
      setLoading(false);
      return;
    }
    api.inspectWorkspace(repoPath).then(
      (value: Inspection) => { if (active) setResult(value); },
      (reason: unknown) => { if (active) setError(String((reason as Error)?.message ?? reason).replace(/^Error invoking remote method '[^']*': (Error: )?/, '')); },
    ).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [repoPath, revision]);

  return (
    <section aria-label="Remotes and worktrees" className="glass-panel flex h-full min-h-0 flex-col">
      <header className="glass-detail-header flex items-center gap-2 border-b border-surface px-4 py-3">
        <div className="min-w-0 flex-1"><h2 className="text-sm font-semibold">Remotes and worktrees</h2><p className="text-xs text-sub">Repository connections and checkouts</p></div>
        <button type="button" aria-label="Refresh remotes and worktrees" title="Refresh" onClick={() => setRevision((v) => v + 1)} className="rounded-md p-2 hover:bg-surface/60"><RefreshCw size={16} aria-hidden /></button>
        <button type="button" aria-label="Close remotes and worktrees" title="Close" onClick={onClose} className="rounded-md p-2 hover:bg-surface/60"><X size={16} aria-hidden /></button>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto" aria-busy={loading}>
        {loading && <p role="status" className="p-4 text-sm text-sub">Loading workspace…</p>}
        {error && <p role="alert" className="p-4 text-sm text-[#f38ba8]">{error}</p>}
        {result && <>
          <section aria-labelledby="remote-list-heading" className="border-b border-surface px-4 py-4">
            <h3 id="remote-list-heading" className="text-sm font-semibold">Remotes <span className="font-normal text-sub">({result.remotes.length})</span></h3>
            <p className="mt-1 text-xs text-sub">Credentials and URL parameters are hidden.</p>
            {result.remotes.length ? result.remotes.map((remote) => <article key={remote.name} className="glass-detail-card mt-3 rounded-lg border border-surface p-3">
              <h4 className="break-all text-sm font-medium">{remote.name}</h4>
              {remote.fetch.map((url, index) => <p key={`fetch-${index}`} className="mt-1 break-all text-xs text-sub"><span className="font-medium text-text">Fetch: </span>{url}</p>)}
              {remote.push.map((url, index) => <p key={`push-${index}`} className="mt-1 break-all text-xs text-sub"><span className="font-medium text-text">Push: </span>{url}</p>)}
              {!remote.push.length && remote.fetch.length > 0 && <p className="mt-1 text-xs text-sub">Push uses the fetch URL.</p>}
            </article>) : <p className="mt-3 text-sm text-sub">No remotes are configured.</p>}
          </section>
          <section aria-labelledby="worktree-list-heading" className="px-4 py-4">
            <h3 id="worktree-list-heading" className="text-sm font-semibold">Worktrees <span className="font-normal text-sub">({result.worktrees.length})</span></h3>
            {result.worktrees.length ? result.worktrees.map((worktree) => <article key={worktree.path} className="glass-detail-card mt-3 rounded-lg border border-surface p-3">
              <h4 className="break-all text-sm font-medium">{worktree.path}</h4>
              <p className="mt-1 break-all text-xs text-sub">{worktree.bare ? 'Bare repository' : worktree.detached ? 'Detached HEAD' : worktree.branch ? `Branch: ${worktree.branch}` : 'No branch'}{worktree.head ? ` · ${worktree.head.slice(0, 7)}` : ''}</p>
              {(worktree.locked || worktree.prunable) && <p className="mt-1 text-xs text-[#fab387]">{[worktree.locked && 'Locked', worktree.prunable && 'Prunable'].filter(Boolean).join(' · ')}</p>}
            </article>) : <p className="mt-3 text-sm text-sub">No worktrees found.</p>}
          </section>
        </>}
      </div>
    </section>
  );
}
