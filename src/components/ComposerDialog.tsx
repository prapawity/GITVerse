import { useCallback, useEffect, useMemo, useState } from 'react';
import { ArrowDown, ArrowUp, Check, Layers, Loader2, RefreshCw, Sparkles, Trash2, X } from 'lucide-react';
import { desktopApi } from '../platform/api';
import { useRepo } from '../store/repoStore';
import { useSettings } from '../store/settingsStore';
import { providerLabel } from '../shared/aiTypes';
import type { FileStatus } from '../shared/types';
import { runAiTask } from '../lib/aiTask';
import { composeMaterial, fileKind, newCommitId, parsePlan, useComposer, type PlannedCommit } from '../lib/composer';
import { entryFor, snapshot, useActionHistory } from '../lib/actionHistory';

type Phase =
  | { kind: 'thinking'; step: string }
  | { kind: 'review' }
  | { kind: 'applying'; done: number; failed?: string }
  | { kind: 'error'; message: string };

const clean = (e: unknown) =>
  String((e as Error)?.message ?? e).replace(/^Error invoking remote method '[^']*': (Error: )?/, '');
const KIND_COLOR: Record<string, string> = {
  added: 'text-success',
  'new file': 'text-success',
  deleted: 'text-danger',
  renamed: 'text-accent',
};

/** Commit Composer: AI splits the uncommitted changes into a few reviewable commits, which you edit, then apply. */
export function ComposerDialog() {
  const open = useComposer((s) => s.open);
  const close = useComposer((s) => s.close);
  const repoPath = useRepo((s) => s.repoPath);
  const provider = useSettings((s) => s.aiProvider);
  const [files, setFiles] = useState<FileStatus[]>([]);
  const [plan, setPlan] = useState<PlannedCommit[]>([]);
  const [phase, setPhase] = useState<Phase>({ kind: 'thinking', step: 'Reading your changes…' });
  const [details, setDetails] = useState<Set<string>>(new Set());

  const generate = useCallback(async () => {
    if (!repoPath) return;
    const state = useRepo.getState();
    const changed = state.status.filter(
      (f) => !['DD', 'AU', 'UD', 'UA', 'DU', 'AA', 'UU'].includes(f.index + f.worktree),
    );
    if (changed.length !== state.status.length)
      return setPhase({ kind: 'error', message: 'Resolve conflicts before composing commits.' });
    if (changed.length < 2)
      return setPhase({
        kind: 'error',
        message: 'Composing needs at least two changed files. Commit this one directly.',
      });
    setFiles(changed);
    setPhase({ kind: 'thinking', step: 'Reading your changes…' });
    try {
      const subjects = state.commits.slice(0, 15).map((c) => c.subject);
      const material = await composeMaterial(repoPath, changed, subjects);
      setPhase({ kind: 'thinking', step: `${providerLabel(useSettings.getState().aiProvider)} is grouping them…` });
      const result = await runAiTask('compose', material);
      setPlan(
        parsePlan(
          result,
          changed.map((f) => f.path),
        ),
      );
      setDetails(new Set());
      setPhase({ kind: 'review' });
    } catch (e) {
      setPhase({ kind: 'error', message: clean(e) });
    }
  }, [repoPath]);

  useEffect(() => {
    if (open) void generate();
  }, [open, generate]);
  const busy = phase.kind === 'thinking' || phase.kind === 'applying';
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && !busy && close();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, busy, close]);

  const byPath = useMemo(() => new Map(files.map((f) => [f.path, f])), [files]);
  if (!open) return null;

  const update = (id: string, patch: Partial<PlannedCommit>) =>
    setPlan((p) => p.map((c) => (c.id === id ? { ...c, ...patch } : c)));
  const move = (index: number, by: -1 | 1) =>
    setPlan((p) => {
      const next = [...p];
      const [item] = next.splice(index, 1);
      next.splice(index + by, 0, item);
      return next;
    });
  // removing a commit keeps its files: they join the commit before it (or after, for the first)
  const remove = (index: number) =>
    setPlan((p) => {
      if (p.length < 2) return p;
      const target = index > 0 ? index - 1 : 1;
      return p
        .map((c, i) => (i === target ? { ...c, files: [...c.files, ...p[index].files] } : c))
        .filter((_, i) => i !== index);
    });
  const moveFile = (path: string, to: string) =>
    setPlan((p) => {
      let next = p.map((c) => ({ ...c, files: c.files.filter((f) => f !== path) }));
      if (to === 'new') next = [...next, { id: newCommitId(), summary: '', body: '', files: [path] }];
      else next = next.map((c) => (c.id === to ? { ...c, files: [...c.files, path] } : c));
      return next.filter((c) => c.files.length);
    });

  const ready = plan.length > 0 && plan.every((c) => c.summary.trim() && c.files.length);
  const apply = async () => {
    if (!repoPath || !ready) return;
    const cwd = repoPath;
    const start = snapshot(useRepo.getState().refs);
    setPhase({ kind: 'applying', done: 0 });
    let done = 0;
    try {
      for (const c of plan) {
        await desktopApi().commitFiles(cwd, c.files, c.summary.trim(), c.body.trim());
        done++;
        setPhase({ kind: 'applying', done });
      }
    } catch (e) {
      setPhase({ kind: 'applying', done, failed: clean(e) });
    }
    await useRepo.getState().refresh();
    // one Undo step for the whole composition: a soft reset keeps every change, staged
    const entry = entryFor(
      `Compose ${done} commit${done === 1 ? '' : 's'}`,
      'commit',
      start,
      snapshot(useRepo.getState().refs),
    );
    if (entry && done) useActionHistory.getState().record(cwd, entry);
    if (done === plan.length) {
      useRepo.getState().notify('success', `Created ${done} commits`, 'Undo puts all the changes back, staged.');
      close();
    }
  };

  return (
    <div
      className="fixed inset-0 z-[95] flex items-center justify-center bg-black/55 p-4"
      onMouseDown={() => !busy && close()}
    >
      <section
        role="dialog"
        aria-modal="true"
        aria-labelledby="composer-title"
        onMouseDown={(e) => e.stopPropagation()}
        className="flex max-h-[90vh] w-full max-w-[900px] flex-col overflow-hidden rounded-xl border border-surface bg-mantle shadow-2xl"
      >
        <header className="flex items-center gap-3 border-b border-surface px-5 py-4">
          <Layers size={18} className="text-ai" aria-hidden />
          <div className="min-w-0 flex-1">
            <h2 id="composer-title" className="font-semibold">
              Compose commits
            </h2>
            <p className="text-sm text-sub">
              {phase.kind === 'review'
                ? `${plan.length} commit${plan.length === 1 ? '' : 's'} from ${files.length} files. Edit anything before creating them.`
                : 'Splits your uncommitted changes into commits a reviewer can follow.'}
            </p>
          </div>
          <button
            onClick={close}
            disabled={busy}
            aria-label="Close"
            className="rounded p-1.5 hover:bg-surface disabled:opacity-40"
          >
            <X size={17} />
          </button>
        </header>

        <div className="min-h-[220px] flex-1 overflow-y-auto px-5 py-4" aria-live="polite">
          {phase.kind === 'thinking' && (
            <p className="flex items-center gap-2 text-sm text-sub">
              <Loader2 size={15} className="animate-spin text-ai" aria-hidden /> {phase.step}
            </p>
          )}
          {phase.kind === 'error' && (
            <p role="alert" className="whitespace-pre-wrap text-sm text-danger">
              {phase.message}
            </p>
          )}
          {(phase.kind === 'review' || phase.kind === 'applying') && (
            <ol className="space-y-3">
              {plan.map((c, index) => {
                const status =
                  phase.kind === 'applying'
                    ? index < phase.done
                      ? 'done'
                      : index === phase.done
                        ? phase.failed
                          ? 'failed'
                          : 'doing'
                        : 'waiting'
                    : null;
                return (
                  <li
                    key={c.id}
                    className={`fade-in rounded-lg border p-3 ${status === 'failed' ? 'border-danger/60' : status === 'done' ? 'border-success/40' : 'border-surface'}`}
                  >
                    <div className="flex items-center gap-2">
                      <span
                        className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-xs font-semibold ${status === 'done' ? 'bg-success/20 text-success' : 'bg-ai/15 text-ai'}`}
                        aria-label={`Commit ${index + 1}`}
                      >
                        {status === 'done' ? (
                          <Check size={13} />
                        ) : status === 'doing' ? (
                          <Loader2 size={13} className="animate-spin" />
                        ) : (
                          index + 1
                        )}
                      </span>
                      <input
                        value={c.summary}
                        onChange={(e) => update(c.id, { summary: e.target.value })}
                        disabled={busy}
                        placeholder="Commit summary"
                        aria-label={`Summary of commit ${index + 1}`}
                        className="min-w-0 flex-1 rounded-md border border-transparent bg-transparent px-2 py-1 font-medium outline-none hover:border-surface focus:border-accent"
                      />
                      <span className="shrink-0 text-xs tabular-nums text-sub">{c.summary.length}/72</span>
                      {phase.kind === 'review' && (
                        <span className="flex shrink-0 items-center">
                          <button
                            onClick={() => move(index, -1)}
                            disabled={index === 0}
                            aria-label="Move up"
                            className="rounded p-1 text-sub hover:bg-surface disabled:opacity-30"
                          >
                            <ArrowUp size={14} />
                          </button>
                          <button
                            onClick={() => move(index, 1)}
                            disabled={index === plan.length - 1}
                            aria-label="Move down"
                            className="rounded p-1 text-sub hover:bg-surface disabled:opacity-30"
                          >
                            <ArrowDown size={14} />
                          </button>
                          <button
                            onClick={() => remove(index)}
                            disabled={plan.length < 2}
                            aria-label="Remove commit (its files join the neighbouring commit)"
                            title="Remove (its files join the neighbouring commit)"
                            className="rounded p-1 text-sub hover:bg-danger/15 hover:text-danger disabled:opacity-30"
                          >
                            <Trash2 size={14} />
                          </button>
                        </span>
                      )}
                    </div>
                    {details.has(c.id) || c.body ? (
                      <textarea
                        value={c.body}
                        onChange={(e) => update(c.id, { body: e.target.value })}
                        disabled={busy}
                        rows={2}
                        placeholder="Details (optional)"
                        aria-label={`Details of commit ${index + 1}`}
                        className="ml-8 mt-1 w-[calc(100%-2rem)] resize-y rounded-md border border-surface bg-crust px-2 py-1 text-sm outline-none focus:border-accent"
                      />
                    ) : (
                      phase.kind === 'review' && (
                        <button
                          onClick={() => setDetails((d) => new Set(d).add(c.id))}
                          className="ml-8 mt-1 text-xs text-sub hover:text-text"
                        >
                          Add details
                        </button>
                      )
                    )}
                    <ul className="ml-8 mt-2 space-y-0.5">
                      {c.files.map((path) => {
                        const f = byPath.get(path);
                        const kind = f ? fileKind(f) : 'changed';
                        return (
                          <li key={path} className="flex items-center gap-2 text-sm">
                            <span className={`w-16 shrink-0 text-xs ${KIND_COLOR[kind] ?? 'text-[#fab387]'}`}>
                              {kind}
                            </span>
                            <span className="min-w-0 flex-1 truncate" title={path}>
                              {path}
                            </span>
                            {phase.kind === 'review' && (
                              <select
                                value={c.id}
                                onChange={(e) => moveFile(path, e.target.value)}
                                aria-label={`Move ${path} to another commit`}
                                className="shrink-0 rounded border border-surface bg-crust px-1 py-0.5 text-xs text-sub"
                              >
                                {plan.map((t, i) => (
                                  <option key={t.id} value={t.id}>
                                    {t.id === c.id ? `In commit ${i + 1}` : `Move to commit ${i + 1}`}
                                  </option>
                                ))}
                                <option value="new">Move to a new commit</option>
                              </select>
                            )}
                          </li>
                        );
                      })}
                    </ul>
                  </li>
                );
              })}
            </ol>
          )}
          {phase.kind === 'applying' && phase.failed && (
            <p role="alert" className="mt-3 text-sm text-danger">
              Stopped at commit {phase.done + 1}: {phase.failed}. {phase.done} commit
              {phase.done === 1 ? ' was' : 's were'} created; Undo takes them back.
            </p>
          )}
        </div>

        <footer className="flex items-center gap-2 border-t border-surface px-5 py-3">
          <span className="flex-1 text-xs text-sub">
            Uses {providerLabel(provider)}. Commits are created in this order; Undo takes them all back.
          </span>
          {(phase.kind === 'review' || phase.kind === 'error') && (
            <button
              onClick={() => void generate()}
              className="btn-secondary flex items-center gap-1.5 px-3 py-1.5 text-sm"
            >
              <RefreshCw size={14} aria-hidden /> Regroup
            </button>
          )}
          <button onClick={close} disabled={busy} className="btn-secondary px-3 py-1.5 text-sm">
            {phase.kind === 'applying' && phase.failed ? 'Close' : 'Cancel'}
          </button>
          {phase.kind === 'review' && (
            <button
              onClick={() => void apply()}
              disabled={!ready}
              title={ready ? undefined : 'Every commit needs a summary'}
              className="flex items-center gap-1.5 rounded-md bg-success/20 px-4 py-1.5 text-sm font-semibold text-success hover:bg-success/30 disabled:opacity-40"
            >
              <Sparkles size={14} aria-hidden /> Create {plan.length} commit{plan.length === 1 ? '' : 's'}
            </button>
          )}
        </footer>
      </section>
    </div>
  );
}
