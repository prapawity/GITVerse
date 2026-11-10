import { useEffect, useRef, useState } from 'react';
import { ArrowDown, ArrowUp, X } from 'lucide-react';

type Commit = { hash: string; subject: string };
type Plan = { branch: string; head: string; base: string; upstream: string; commits: Commit[] };
type Entry = Commit & { action: 'pick' | 'reword' | 'squash' | 'fixup' | 'drop' };

/** Read-only planner. It never starts or schedules a rebase. */
export function RebasePreview({ repo, base, onClose }: { repo: string; base: string; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [plan, setPlan] = useState<Plan | null>(null);
  const [entries, setEntries] = useState<Entry[]>([]);
  const [error, setError] = useState('');
  useEffect(() => {
    dialog.current?.showModal();
    let active = true;
    (window as any).gitApi.rebasePreview(repo, base).then((result: Plan) => {
      if (!active) return;
      setPlan(result);
      setEntries(result.commits.map((commit) => ({ ...commit, action: 'pick' })));
    }).catch((err: Error) => {
      if (active) setError(String(err.message).replace(/^Error invoking remote method '[^']*': (Error: )?/, ''));
    });
    return () => { active = false; };
  }, [repo, base]);
  const firstIncluded = entries.find((entry) => entry.action !== 'drop');
  const invalid = !firstIncluded || firstIncluded.action === 'squash' || firstIncluded.action === 'fixup';
  const move = (index: number, direction: number) => setEntries((current) => {
    const next = [...current];
    const target = index + direction;
    if (target < 0 || target >= next.length) return current;
    [next[index], next[target]] = [next[target], next[index]];
    return next;
  });
  return (
    <dialog ref={dialog} onCancel={(event) => { event.preventDefault(); onClose(); }} className="glass-context-menu m-auto max-h-[min(760px,90vh)] w-[min(760px,calc(100vw-32px))] overflow-hidden rounded-xl p-0 text-text backdrop:bg-black/65" aria-labelledby="rebase-preview-title">
      <header className="glass-detail-header flex items-start gap-4 border-b border-surface p-5">
        <div className="min-w-0 flex-1"><h2 id="rebase-preview-title" className="text-lg font-semibold">Interactive rebase preview</h2><p className="mt-1 text-sm text-sub">Explore a plan. Closing this window discards it; no Git operation is started.</p></div>
        <button type="button" aria-label="Close rebase preview" onClick={onClose} className="rounded p-2 hover:bg-surface"><X size={18} aria-hidden /></button>
      </header>
      <div className="max-h-[calc(90vh-100px)] overflow-y-auto p-5">
        {error && <p role="alert" className="whitespace-pre-wrap rounded-md border border-[#f38ba8]/40 bg-[#f38ba8]/10 p-3 text-sm text-[#f38ba8]">{error}</p>}
        {!plan && !error && <p role="status" className="text-sub">Checking history…</p>}
        {plan && <>
          <p className="text-sm text-sub">{plan.branch} after <span className="font-mono text-text">{plan.base.slice(0, 7)}</span>, checked against {plan.upstream}. Commits are shown oldest first.</p>
          <ol className="mt-4 space-y-2" aria-label="Proposed commit order">
            {entries.map((entry, index) => <li key={entry.hash} className="flex flex-wrap items-center gap-2 rounded-lg border border-surface bg-crust/50 p-2">
              <select aria-label={`Action for ${entry.hash.slice(0, 7)} ${entry.subject}`} value={entry.action} onChange={(event) => setEntries((old) => old.map((item) => item.hash === entry.hash ? { ...item, action: event.target.value as Entry['action'] } : item))} className="min-h-[36px] rounded-md border border-surface bg-mantle px-2 text-sm">
                <option value="pick">Pick</option><option value="reword">Reword</option><option value="squash">Squash</option><option value="fixup">Fixup</option><option value="drop">Drop</option>
              </select>
              <div className="min-w-[160px] flex-1"><span className="mr-2 font-mono text-xs text-[#4cc2ff]">{entry.hash.slice(0, 7)}</span><span className="break-words text-sm">{entry.subject}</span></div>
              <button type="button" disabled={index === 0} onClick={() => move(index, -1)} aria-label={`Move ${entry.subject} earlier`} className="rounded p-2 hover:bg-surface disabled:opacity-30"><ArrowUp size={16} aria-hidden /></button>
              <button type="button" disabled={index === entries.length - 1} onClick={() => move(index, 1)} aria-label={`Move ${entry.subject} later`} className="rounded p-2 hover:bg-surface disabled:opacity-30"><ArrowDown size={16} aria-hidden /></button>
            </li>)}
          </ol>
          {invalid && <p role="status" className="mt-3 text-sm text-[#f9e2af]">Keep at least one commit, and start with Pick or Reword before Squash or Fixup.</p>}
          <p className="mt-4 text-xs leading-relaxed text-sub">Preview only. Applying this plan is not available yet. Reword messages and conflict handling must be confirmed when execution is implemented.</p>
        </>}
      </div>
    </dialog>
  );
}
