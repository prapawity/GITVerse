import { useEffect, useState } from 'react';
import { Copy, RefreshCw, X } from 'lucide-react';

type Entry = { hash: string; selector: string; message: string };

/** Read-only HEAD reflog. Navigation may fail for commits no longer reachable from visible history. */
export function RecoveryPanel({
  repoPath,
  onClose,
  onNavigate,
}: {
  repoPath: string;
  onClose: () => void;
  onNavigate: (hash: string) => Promise<boolean>;
}) {
  const [entries, setEntries] = useState<Entry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [revision, setRevision] = useState(0);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setEntries([]);
    setError('');
    setMessage('');
    const api = (window as any).gitApi;
    if (!api?.reflog) {
      setError('Recovery history is available in the desktop app.');
      setLoading(false);
      return;
    }
    api
      .reflog(repoPath)
      .then(
        (value: Entry[]) => {
          if (active) setEntries(value);
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
    <section aria-label="Recovery history" className="glass-panel flex h-full min-h-0 flex-col">
      <header className="glass-detail-header flex items-center gap-2 border-b border-surface px-4 py-3">
        <div className="min-w-0 flex-1">
          <h2 className="text-sm font-semibold">Recovery history</h2>
          <p className="text-xs text-sub">Recent HEAD positions in this worktree</p>
        </div>
        <button
          type="button"
          aria-label="Refresh recovery history"
          title="Refresh"
          onClick={() => setRevision((v) => v + 1)}
          className="rounded-md p-2 hover:bg-surface/60"
        >
          <RefreshCw size={16} aria-hidden />
        </button>
        <button
          type="button"
          aria-label="Close recovery history"
          title="Close"
          onClick={onClose}
          className="rounded-md p-2 hover:bg-surface/60"
        >
          <X size={16} aria-hidden />
        </button>
      </header>
      <p className="border-b border-surface px-4 py-3 text-xs leading-relaxed text-sub">
        This list is read-only. Copy a commit ID to inspect a previous position. Entries may expire, and some commits
        may no longer appear in the graph.
      </p>
      {error && (
        <p role="alert" className="px-4 py-3 text-sm text-[#f38ba8]">
          {error}
        </p>
      )}
      {message && (
        <p role="status" className="px-4 py-2 text-xs text-sub">
          {message}
        </p>
      )}
      <div className="min-h-0 flex-1 overflow-y-auto" aria-busy={loading}>
        {loading ? (
          <p role="status" className="p-4 text-sm text-sub">
            Loading recovery history…
          </p>
        ) : !error && !entries.length ? (
          <p className="p-4 text-sm text-sub">No HEAD history is available for this worktree.</p>
        ) : (
          entries.map((entry, index) => (
            <article key={`${entry.hash}-${entry.selector}-${index}`} className="border-b border-surface/60 px-4 py-3">
              <p className="break-words text-sm font-medium">{entry.message || 'HEAD updated'}</p>
              <p className="mt-1 break-all font-mono text-xs text-sub">{entry.selector}</p>
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  title={entry.hash}
                  onClick={async () => {
                    try {
                      await navigator.clipboard.writeText(entry.hash);
                      setMessage(`Copied ${entry.hash.slice(0, 7)}`);
                    } catch {
                      setMessage('Could not copy the commit ID.');
                    }
                  }}
                  className="flex min-h-[32px] items-center gap-1.5 rounded-md border border-surface px-2 font-mono text-xs hover:bg-surface/60"
                >
                  <Copy size={13} aria-hidden /> {entry.hash.slice(0, 7)}
                </button>
                <button
                  type="button"
                  onClick={async () => {
                    const found = await onNavigate(entry.hash);
                    if (!found)
                      setMessage('This commit is not in the available graph history. Copy its ID to inspect it.');
                  }}
                  className="min-h-[32px] rounded-md border border-surface px-2 text-xs hover:bg-surface/60"
                >
                  Show in graph
                </button>
              </div>
            </article>
          ))
        )}
      </div>
    </section>
  );
}
