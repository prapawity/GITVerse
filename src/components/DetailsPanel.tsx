import { useMemo, useState } from 'react';
import { FileMinus, FilePen, FilePlus, FileSymlink, Folder, List, ListTree } from 'lucide-react';
import { useRepo } from '../store/repoStore';
import { DetailsSkeleton, Skeleton } from './Loading';

export type ChangedFile = { status: string; path: string; oldPath?: string };
type F = ChangedFile;

const icon = (s: string) => {
  const p = { size: 15, 'aria-hidden': true } as const;
  if (s === 'A') return <FilePlus {...p} className="shrink-0 text-[#a6e3a1]" />;
  if (s === 'D') return <FileMinus {...p} className="shrink-0 text-[#f38ba8]" />;
  if (s === 'R' || s === 'C') return <FileSymlink {...p} className="shrink-0 text-[#cba6f7]" />;
  return <FilePen {...p} className="shrink-0 text-[#fab387]" />;
};
const LABEL: Record<string, string> = { M: 'modified', A: 'added', D: 'deleted', R: 'renamed', C: 'copied' };

function summary(files: F[]) {
  const c: Record<string, number> = {};
  files.forEach((f) => (c[f.status] = (c[f.status] ?? 0) + 1));
  return Object.entries(c).map(([k, n]) => `${n} ${LABEL[k] ?? k}`).join(', ') || 'no changes';
}

function FileRow({ f, tree, selected, onSelect }: { f: F; tree?: boolean; selected: boolean; onSelect: (file: F) => void }) {
  const i = f.path.lastIndexOf('/');
  return (
    <button onClick={() => onSelect(f)} aria-pressed={selected} className={`flex min-h-[36px] w-full items-center gap-2 px-4 text-left hover:bg-surface/40 focus-visible:bg-surface ${selected ? 'bg-[#4cc2ff]/20' : ''}`} title={f.path}>
      {icon(f.status)}
      <span className="truncate">
        {!tree && <span className="text-sub">{f.path.slice(0, i + 1)}</span>}
        <span className="font-medium">{f.path.slice(i + 1)}</span>
      </span>
    </button>
  );
}

export function DetailsPanel({ file, onSelectFile }: { file: ChangedFile | null; onSelectFile: (file: ChangedFile) => void }) {
  const { graph, selectedHash, detail, status } = useRepo();
  const [view, setView] = useState<'path' | 'tree'>('path');
  const c = graph.rows.find((r) => r.commit.hash === selectedHash)?.commit;

  const groups = useMemo(() => {
    const m = new Map<string, F[]>();
    (detail?.files ?? []).forEach((f) => {
      const d = f.path.includes('/') ? f.path.slice(0, f.path.lastIndexOf('/')) : '';
      m.set(d, [...(m.get(d) ?? []), f]);
    });
    return [...m];
  }, [detail]);

  if (!c && selectedHash) return <DetailsSkeleton />;
  if (!c) return <div className="p-5 text-sub">{status.length} changed file(s) in working tree. Select a commit to see its details.</div>;
  const [title, ...rest] = (detail?.body ?? c.subject).split('\n');
  const initials = c.author.split(/\s+/).slice(0, 2).map((w) => w[0]).join('').toUpperCase();
  const seg = (v: 'path' | 'tree', label: string, I: typeof List) => (
    <button
      aria-pressed={view === v}
      onClick={() => setView(v)}
      className={`flex min-h-[32px] items-center gap-1.5 px-3 text-[13px] ${view === v ? 'bg-[#4cc2ff]/20 text-[#4cc2ff]' : 'text-sub hover:text-text'}`}
    >
      <I size={14} aria-hidden /> {label}
    </button>
  );

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <div className="flex items-center justify-between border-b border-surface px-4 py-3 text-sub">
        <span>commit: <span className="font-mono text-[15px] font-semibold text-text">{c.hash.slice(0, 6)}</span></span>
        <span>parent: <span className="font-mono">{c.parents.map((p) => p.slice(0, 6)).join(', ') || '—'}</span></span>
      </div>

      <div className="m-4 max-h-[38%] overflow-auto rounded-lg border border-surface bg-crust p-4">
        <div className="text-[17px] font-semibold leading-snug">{title}</div>
        {rest.join('\n').trim() && <pre className="mt-3 whitespace-pre-wrap font-sans text-[13px] leading-relaxed text-sub">{rest.join('\n').trim()}</pre>}
      </div>

      <div className="flex items-center gap-3 px-4 pb-3">
        <div aria-hidden className="flex h-11 w-11 shrink-0 items-center justify-center rounded-md bg-[#cba6f7] text-[15px] font-bold text-crust">{initials}</div>
        <div className="min-w-0">
          <div className="truncate text-[15px] font-medium">{c.author}</div>
          {c.email && <div className="break-all text-[13px] text-sub">{c.email}</div>}
          <div className="text-[13px] text-sub">authored {new Date(c.date).toLocaleString()}</div>
        </div>
      </div>

      <div className="flex items-center gap-2 border-t border-surface px-4 pt-3 text-[#fab387]">
        <FilePen size={15} aria-hidden />
        <span aria-live="polite">{detail ? summary(detail.files) : <Skeleton className="inline-block h-4 w-32 align-middle" />}</span>
      </div>
      <div className="flex items-center justify-between px-4 py-3">
        <div role="group" aria-label="File list layout" className="flex overflow-hidden rounded-md border border-surface">
          {seg('path', 'Path', List)}
          {seg('tree', 'Tree', ListTree)}
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-auto pb-3" aria-busy={!detail}>
        {!detail && (
          <div role="status" aria-label="Loading files" className="space-y-3 px-4 pt-1">
            {[70, 55, 85, 60].map((w, i) => <div key={i} className="flex items-center gap-2"><Skeleton className="h-4 w-4" /><Skeleton className="h-3.5" style={{ width: `${w}%` }} /></div>)}
          </div>
        )}
        {view === 'path' && detail?.files.map((f) => <FileRow key={f.path} f={f} selected={file?.path === f.path} onSelect={onSelectFile} />)}
        {view === 'tree' &&
          groups.map(([dir, fs]) => (
            <div key={dir}>
              {dir && (
                <div className="flex items-center gap-2 px-4 py-1.5 text-[13px] text-sub">
                  <Folder size={14} aria-hidden /> <span className="truncate">{dir}</span>
                </div>
              )}
              <div className={dir ? 'pl-5' : ''}>{fs.map((f) => <FileRow key={f.path} f={f} tree selected={file?.path === f.path} onSelect={onSelectFile} />)}</div>
            </div>
          ))}
      </div>
    </div>
  );
}
