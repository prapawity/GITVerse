import { useEffect, useMemo, useState } from 'react';
import { FileMinus, FilePen, FilePlus, FileSymlink, Folder, List, ListTree } from 'lucide-react';
import { useRepo } from '../store/repoStore';
import { DetailsSkeleton, Skeleton } from './Loading';
import type { StashDetail, StashRef } from '../shared/types';
import { askConfirm } from './Dialogs';

export type ChangedFile = { status: string; path: string; oldPath?: string; untracked?: boolean };
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
  return (
    Object.entries(c)
      .map(([k, n]) => `${n} ${LABEL[k] ?? k}`)
      .join(', ') || 'no changes'
  );
}

function FileRow({
  f,
  tree,
  selected,
  onSelect,
}: {
  f: F;
  tree?: boolean;
  selected: boolean;
  onSelect: (file: F) => void;
}) {
  const i = f.path.lastIndexOf('/');
  return (
    <button
      onClick={() => onSelect(f)}
      aria-pressed={selected}
      className={`flex min-h-[44px] w-full items-center gap-2 px-4 text-left hover:bg-surface/40 focus-visible:bg-surface ${selected ? 'border-l-2 border-[#4cc2ff] bg-[#4cc2ff]/15' : 'border-l-2 border-transparent'}`}
      title={f.path}
    >
      {icon(f.status)}
      <span className="min-w-0 flex-1 py-1">
        <span className="block truncate font-medium">{f.path.slice(i + 1)}</span>
        {!tree && i >= 0 && <span className="block truncate text-xs text-sub">{f.path.slice(0, i + 1)}</span>}
      </span>
      <span className="shrink-0 text-[11px] text-sub">{LABEL[f.status] ?? f.status}</span>
      {f.untracked && <span className="shrink-0 text-[11px] text-sub">untracked</span>}
    </button>
  );
}

export function DetailsPanel({
  file,
  onSelectFile,
  stash,
}: {
  file: ChangedFile | null;
  onSelectFile: (file: ChangedFile) => void;
  stash?: StashRef;
}) {
  const state = useRepo();
  const { graph, selectedHash, status, repoPath } = state;
  const [editingStash, setEditingStash] = useState(false);
  const [stashName, setStashName] = useState('');
  const [stashEditError, setStashEditError] = useState('');
  const [savingStashName, setSavingStashName] = useState(false);
  const [stashActionBusy, setStashActionBusy] = useState(false);
  const [stashActionError, setStashActionError] = useState('');
  const stashKey = stash ? `${repoPath}:${stash.hash ?? stash.id}` : '';
  const [snapshot, setSnapshot] = useState<{ key: string; data?: StashDetail; error?: string } | null>(null);
  useEffect(() => {
    if (!stash || !repoPath) return;
    let active = true;
    setSnapshot({ key: stashKey });
    (window as any).gitApi
      .stashDetail(repoPath, stash.hash ?? stash.id)
      .then((data: StashDetail) => {
        if (active) setSnapshot({ key: stashKey, data });
      })
      .catch((error: Error) => {
        if (active)
          setSnapshot({
            key: stashKey,
            error: error.message.replace(/^Error invoking remote method '[^']*': (Error: )?/, ''),
          });
      });
    return () => {
      active = false;
    };
  }, [repoPath, stashKey, stash?.id, stash?.hash]);
  const saved = snapshot?.key === stashKey ? snapshot.data : undefined;
  const detail = stash ? saved : state.detail;
  const [view, setView] = useState<'path' | 'tree'>('path');
  const c = stash
    ? {
        hash: saved?.hash ?? stash.hash ?? '',
        parents: saved?.baseHash ? [saved.baseHash] : stash.baseHash ? [stash.baseHash] : [],
        author: saved?.author ?? stash.author ?? 'Unknown',
        email: saved?.email ?? stash.email ?? '',
        date: saved?.date ?? stash.date ?? '',
        subject: stash.message,
        stashId: saved?.id ?? stash.id,
      }
    : graph.rows.find((r) => r.commit.hash === selectedHash)?.commit;

  const groups = useMemo(() => {
    const m = new Map<string, F[]>();
    (detail?.files ?? []).forEach((f) => {
      const d = f.path.includes('/') ? f.path.slice(0, f.path.lastIndexOf('/')) : '';
      m.set(d, [...(m.get(d) ?? []), f]);
    });
    return [...m];
  }, [detail]);

  if (stash && snapshot?.key === stashKey && snapshot.error)
    return (
      <p role="alert" className="whitespace-pre-wrap p-4 text-[#f38ba8]">
        {snapshot.error}
      </p>
    );
  if (!c && selectedHash) return <DetailsSkeleton />;
  if (!c)
    return (
      <div className="p-5 text-sub">
        {status.length} changed file(s) in working tree. Select a commit to see its details.
      </div>
    );
  const [title, ...rest] = (stash ? stash.message : (detail?.body ?? c.subject)).split('\n');
  const initials = c.author
    .split(/\s+/)
    .slice(0, 2)
    .map((w) => w[0])
    .join('')
    .toUpperCase();
  const seg = (v: 'path' | 'tree', label: string, I: typeof List) => (
    <button
      aria-pressed={view === v}
      onClick={() => setView(v)}
      className={`flex min-h-[32px] items-center gap-1.5 px-3 text-[13px] ${view === v ? 'bg-[#4cc2ff]/20 text-[#4cc2ff]' : 'text-sub hover:text-text'}`}
    >
      <I size={14} aria-hidden /> {label}
    </button>
  );

  const runStashAction = async (action: 'apply' | 'pop' | 'drop') => {
    if (!repoPath || !stash?.hash || stashActionBusy || state.working) return;
    const selectedRepo = repoPath;
    const selectedHash = stash.hash;
    const description =
      action === 'drop'
        ? 'Permanently remove this stash entry. Its saved changes will no longer be listed.'
        : action === 'pop'
          ? 'Apply this stash to the working tree and remove it only if the apply succeeds. Conflicts can require manual resolution.'
          : 'Apply this stash to the working tree and keep the stash. Conflicts can require manual resolution.';
    if (
      !(await askConfirm(`${action[0].toUpperCase()}${action.slice(1)} stash?`, `${stash.message}\n\n${description}`, {
        label: `${action[0].toUpperCase()}${action.slice(1)} stash`,
        danger: action === 'drop',
      }))
    )
      return;
    if (useRepo.getState().repoPath !== selectedRepo) {
      useRepo.getState().notify('warning', 'Stash action cancelled', 'The active repository changed.');
      return;
    }
    setStashActionBusy(true);
    setStashActionError('');
    let failure = '';
    await useRepo.getState().track(`Stash ${action}…`, async () => {
      try {
        await (window as any).gitApi.stashAction(selectedRepo, selectedHash, action);
      } catch (error) {
        failure = String((error as Error).message).replace(/^Error invoking remote method '[^']*': (Error: )?/, '');
      } finally {
        if (useRepo.getState().repoPath === selectedRepo) await useRepo.getState().refresh();
      }
    }, { blocking: true });
    setStashActionBusy(false);
    if (useRepo.getState().repoPath !== selectedRepo) return;
    if (failure) {
      const hasConflicts = useRepo
        .getState()
        .status.some((file) => ['DD', 'AU', 'UD', 'UA', 'DU', 'AA', 'UU'].includes(file.index + file.worktree));
      setStashActionError(
        hasConflicts
          ? `Stash ${action} stopped with conflicts. The stash was kept. Resolve the conflicted files in Working changes.\n${failure}`
          : failure,
      );
      useRepo
        .getState()
        .notify(
          'error',
          `Could not ${action} stash`,
          hasConflicts ? 'Resolve conflicted files in Working changes. The stash was kept.' : failure,
        );
    } else {
      useRepo
        .getState()
        .notify('success', `Stash ${action === 'apply' ? 'applied' : action === 'pop' ? 'popped' : 'dropped'}`);
    }
  };

  return (
    <div
      role="region"
      aria-label={stash ? 'Stash details' : 'Commit details'}
      className="flex h-full flex-col overflow-hidden"
    >
      <div className="glass-detail-header flex flex-wrap items-center justify-between gap-x-3 gap-y-1 border-b border-surface px-4 py-3 text-sub">
        <span>
          {stash ? 'stash' : 'commit'}:{' '}
          <span className="font-mono text-[15px] font-semibold text-text">{c.hash.slice(0, 6)}</span>
          {stash && <span className="ml-2 font-mono text-[#f5a623]">{c.stashId}</span>}
        </span>
        <span>
          {stash ? 'base' : 'parent'}:{' '}
          <span className="font-mono">{c.parents.map((p) => p.slice(0, 6)).join(', ') || '—'}</span>
        </span>
      </div>

      {stash && (
        <div className="border-b border-surface px-4 py-3">
          <div className="flex flex-wrap gap-2" role="group" aria-label="Stash actions">
            {(['apply', 'pop', 'drop'] as const).map((action) => (
              <button
                key={action}
                type="button"
                disabled={stashActionBusy || !!state.working || !!state.operation || !stash.hash}
                onClick={() => void runStashAction(action)}
                className={`min-h-[36px] rounded-md border px-3 text-sm font-medium disabled:opacity-40 ${action === 'drop' ? 'border-[#f38ba8]/40 text-[#f38ba8] hover:bg-[#f38ba8]/10' : 'border-surface hover:bg-surface/60'}`}
              >
                {action[0].toUpperCase() + action.slice(1)}
              </button>
            ))}
          </div>
          {stashActionError && (
            <p role="alert" className="mt-2 whitespace-pre-wrap text-xs text-[#f38ba8]">
              {stashActionError}
            </p>
          )}
        </div>
      )}

      <div className="glass-detail-card m-4 max-h-[38%] overflow-auto rounded-xl border border-surface p-4">
        {stash ? (
          <>
            <input
              aria-label="Stash name"
              maxLength={200}
              value={editingStash ? stashName : stash.message}
              onFocus={() => {
                if (!editingStash) setStashName(stash.message);
                setEditingStash(true);
              }}
              onChange={(event) => {
                setStashName(event.target.value);
                setEditingStash(true);
              }}
              className="w-full rounded border border-surface bg-mantle px-3 py-2 text-[16px] outline-none focus:border-[#4cc2ff]"
            />
            {stashEditError && (
              <p role="alert" className="mt-2 text-sm text-[#f38ba8]">
                {stashEditError}
              </p>
            )}
            {editingStash && (
              <div className="mt-4 flex gap-2">
                <button
                  disabled={savingStashName || !stashName.trim() || stashName.trim() === stash.message}
                  onClick={async () => {
                    setSavingStashName(true);
                    setStashEditError('');
                    try {
                      await (window as any).gitApi.stashRename(repoPath, stash.hash ?? stash.id, stashName.trim());
                      await state.refresh();
                      setEditingStash(false);
                    } catch (error) {
                      setStashEditError(
                        String((error as Error).message).replace(
                          /^Error invoking remote method '[^']*': (Error: )?/,
                          '',
                        ),
                      );
                    } finally {
                      setSavingStashName(false);
                    }
                  }}
                  className="min-h-9 flex-1 rounded border border-[#a6e3a1] bg-[#a6e3a1]/20 px-3 text-sm disabled:opacity-40"
                >
                  Update Message
                </button>
                <button
                  disabled={savingStashName}
                  onClick={() => {
                    setStashName(stash.message);
                    setEditingStash(false);
                    setStashEditError('');
                  }}
                  className="min-h-9 flex-1 rounded border border-[#f38ba8] bg-[#f38ba8]/15 px-3 text-sm disabled:opacity-40"
                >
                  Cancel Amend
                </button>
              </div>
            )}
          </>
        ) : (
          <>
            <div className="text-[17px] font-semibold leading-snug">{title}</div>
          </>
        )}
        {rest.join('\n').trim() && (
          <pre className="mt-3 whitespace-pre-wrap font-sans text-[13px] leading-relaxed text-sub">
            {rest.join('\n').trim()}
          </pre>
        )}
      </div>

      <div className="flex items-center gap-3 px-4 pb-3">
        <div
          aria-hidden
          className="flex h-11 w-11 shrink-0 items-center justify-center rounded-md bg-[#cba6f7] text-[15px] font-bold text-crust"
        >
          {initials}
        </div>
        <div className="min-w-0">
          <div className="truncate text-[15px] font-medium">{c.author}</div>
          {c.email && <div className="break-all text-[13px] text-sub">{c.email}</div>}
          <div className="text-[13px] text-sub">
            {c.date ? `authored ${new Date(c.date).toLocaleString()}` : 'Loading metadata...'}
          </div>
        </div>
      </div>

      <div className="flex items-center gap-2 border-t border-surface px-4 pt-3 text-text">
        <FilePen size={15} aria-hidden />
        <span className="text-sm font-semibold" aria-live="polite">
          {detail ? summary(detail.files) : <Skeleton className="inline-block h-4 w-32 align-middle" />}
        </span>
      </div>
      <div className="flex items-center justify-between px-4 py-3">
        <span className="text-xs font-semibold uppercase tracking-wide text-sub">Changed files</span>
        <div
          role="group"
          aria-label="File list layout"
          className="flex overflow-hidden rounded-md border border-surface"
        >
          {seg('path', 'Path', List)}
          {seg('tree', 'Tree', ListTree)}
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-auto pb-3" aria-busy={!detail}>
        {!detail && (
          <div role="status" aria-label="Loading files" className="space-y-3 px-4 pt-1">
            {[70, 55, 85, 60].map((w, i) => (
              <div key={i} className="flex items-center gap-2">
                <Skeleton className="h-4 w-4" />
                <Skeleton className="h-3.5" style={{ width: `${w}%` }} />
              </div>
            ))}
          </div>
        )}
        {view === 'path' &&
          detail?.files.map((f) => (
            <FileRow key={f.path} f={f} selected={file?.path === f.path} onSelect={onSelectFile} />
          ))}
        {view === 'tree' &&
          groups.map(([dir, fs]) => (
            <div key={dir}>
              {dir && (
                <div className="flex items-center gap-2 px-4 py-1.5 text-[13px] text-sub">
                  <Folder size={14} aria-hidden /> <span className="truncate">{dir}</span>
                </div>
              )}
              <div className={dir ? 'pl-5' : ''}>
                {fs.map((f) => (
                  <FileRow key={f.path} f={f} tree selected={file?.path === f.path} onSelect={onSelectFile} />
                ))}
              </div>
            </div>
          ))}
      </div>
    </div>
  );
}
