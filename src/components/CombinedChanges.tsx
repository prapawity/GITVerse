import { useEffect, useState } from 'react';
import { FileDown, Layers, Loader2 } from 'lucide-react';
import { desktopApi } from '../platform/api';
import { useRepo } from '../store/repoStore';
import type { ChangedFile } from './DetailsPanel';

const COLOR: Record<string, string> = {
  A: 'text-success',
  D: 'text-danger',
  R: 'text-accent',
  C: 'text-accent',
  M: 'text-[#fab387]',
};

/**
 * Selected commits in a straight line, oldest → newest, or null when they are not one unbroken
 * first-parent chain (GitKraken shows combined changes only for consecutive commits).
 */
export function consecutiveRange(hashes: string[], rows: { commit: { hash: string; parents: string[] } }[]) {
  if (hashes.length < 2) return null;
  const index = new Map(rows.map((row, i) => [row.commit.hash, i]));
  const ordered = [...hashes].filter((h) => index.has(h)).sort((a, b) => index.get(a)! - index.get(b)!);
  if (ordered.length !== hashes.length) return null;
  const byHash = new Map(rows.map((row) => [row.commit.hash, row.commit]));
  for (let i = 0; i < ordered.length - 1; i++) if (byHash.get(ordered[i])!.parents[0] !== ordered[i + 1]) return null;
  return { newest: ordered[0], oldest: ordered[ordered.length - 1], count: ordered.length };
}

export function CombinedChanges({
  oldest,
  newest,
  count,
  file,
  onSelectFile,
}: {
  oldest: string;
  newest: string;
  count: number;
  file: ChangedFile | null;
  onSelectFile: (file: ChangedFile) => void;
}) {
  const repoPath = useRepo((s) => s.repoPath);
  const [files, setFiles] = useState<ChangedFile[] | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    if (!repoPath) return;
    let active = true;
    setFiles(null);
    setError('');
    desktopApi()
      .rangeFiles(repoPath, oldest, newest)
      .then((list: ChangedFile[]) => active && setFiles(list))
      .catch((e: Error) => active && setError(e.message));
    return () => {
      active = false;
    };
  }, [repoPath, oldest, newest]);

  const savePatch = async () => {
    if (!repoPath) return;
    try {
      const text: string = await desktopApi().rangePatch(repoPath, oldest, newest);
      const link = document.createElement('a');
      link.href = URL.createObjectURL(new Blob([text], { type: 'text/x-patch' }));
      link.download = `${oldest.slice(0, 7)}..${newest.slice(0, 7)}.patch`;
      link.click();
      setTimeout(() => URL.revokeObjectURL(link.href), 10_000);
    } catch (e) {
      setError(String((e as Error)?.message ?? e));
    }
  };

  return (
    <section aria-label="Combined changes" className="flex h-full min-h-0 flex-col">
      <header className="border-b border-surface px-4 py-3">
        <h2 className="flex items-center gap-2 font-semibold">
          <Layers size={16} className="text-accent" aria-hidden /> Combined changes of {count} commits
        </h2>
        <p className="mt-1 font-mono text-xs text-sub">
          {oldest.slice(0, 7)} … {newest.slice(0, 7)}
        </p>
        <button
          onClick={() => void savePatch()}
          className="btn-secondary mt-2 flex items-center gap-1.5 px-3 py-1 text-sm"
        >
          <FileDown size={14} aria-hidden /> Save as patch
        </button>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto py-1">
        {error && <p className="px-4 py-2 text-sm text-danger">{error}</p>}
        {!files && !error && (
          <p className="flex items-center gap-2 px-4 py-3 text-sm text-sub">
            <Loader2 size={14} className="animate-spin" aria-hidden /> Loading…
          </p>
        )}
        {files?.length === 0 && <p className="px-4 py-3 text-sm text-sub">These commits cancel each other out.</p>}
        {files?.map((f) => (
          <button
            key={`${f.oldPath ?? ''}>${f.path}`}
            onClick={() => onSelectFile(f)}
            aria-pressed={file?.path === f.path}
            title={f.oldPath ? `${f.oldPath} → ${f.path}` : f.path}
            className={`flex w-full items-center gap-2 px-4 py-1.5 text-left text-sm ${file?.path === f.path ? 'bg-accent/15' : 'hover:bg-surface/50'}`}
          >
            <span
              className={`w-4 shrink-0 text-center font-mono text-xs font-semibold ${COLOR[f.status] ?? 'text-sub'}`}
            >
              {f.status}
            </span>
            <span className="truncate">{f.path}</span>
          </button>
        ))}
      </div>
    </section>
  );
}
