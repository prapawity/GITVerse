import { useState } from 'react';
import { ChevronDown, ChevronRight, FilePen, Loader2, Minus, Plus, RefreshCw, Sparkles } from 'lucide-react';
import { useRepo } from '../store/repoStore';
import { askConfirm } from './Dialogs';
import type { FileStatus } from '../shared/types';
import { useSettings } from '../store/settingsStore';
import { providerLabel } from '../shared/aiTypes';

export type WorkingFile = { path: string; status: string; area: 'staged' | 'unstaged' | 'untracked' };
const api = () => (window as any).gitApi;
const isConflict = (f: FileStatus) => ['DD', 'AU', 'UD', 'UA', 'DU', 'AA', 'UU'].includes(f.index + f.worktree);
const clean = (e: unknown) =>
  String((e as Error)?.message ?? e).replace(/^Error invoking remote method '[^']*': (Error: )?/, '');
const EMPTY_DRAFT = { summary: '', description: '', amend: false, signoff: false };

export function WorkingChangesPanel({
  selected,
  onSelect,
  onClear,
  onRefresh,
}: {
  selected: WorkingFile | null;
  onSelect: (file: WorkingFile) => void;
  onClear: () => void;
  onRefresh: () => Promise<void>;
}) {
  const { repoPath, status, refs, operation, working, notify, openConflict, refresh, commitDrafts, setCommitDraft } =
    useRepo();
  const [pending, setPending] = useState(false);
  const [generating, setGenerating] = useState(false);
  const provider = useSettings((s) => s.aiProvider);
  const draft = repoPath ? (commitDrafts[repoPath] ?? EMPTY_DRAFT) : EMPTY_DRAFT;
  const { summary, description, amend, signoff } = draft;
  const updateDraft = (changes: Partial<typeof draft>) => {
    if (repoPath) setCommitDraft(repoPath, { ...draft, ...changes });
  };
  const [optionsOpen, setOptionsOpen] = useState(false);
  const [error, setError] = useState('');

  const conflict = status.filter(isConflict);
  const staged = status.filter((f) => !isConflict(f) && f.index !== ' ' && f.index !== '?');
  const unstaged = status.filter((f) => !isConflict(f) && (f.worktree !== ' ' || f.index === '?'));
  const busy = pending || generating || !!working;
  const missingSummary = !summary.trim() && (!amend || !!description.trim());
  const current = refs.local.find((b) => b.current)?.name ?? 'detached HEAD';

  const changeAmend = async (enabled: boolean) => {
    if (!repoPath || busy) return;
    if (!enabled) {
      updateDraft({ amend: false });
      return;
    }
    const cwd = repoPath;
    setPending(true);
    setError('');
    try {
      await useRepo.getState().prefillAmendDraft(cwd);
    } catch (e) {
      if (useRepo.getState().repoPath === cwd) setError(clean(e));
    } finally {
      setPending(false);
    }
  };

  const changeStage = async (action: 'stage' | 'unstage', files: FileStatus[]) => {
    if (!repoPath || !files.length || busy) return;
    const cwd = repoPath;
    setPending(true);
    setError('');
    try {
      await api().trackedStage(
        cwd,
        action,
        files.map((f) => f.path),
      );
      useRepo
        .getState()
        .recordActivity(
          'success',
          `${action === 'stage' ? 'Staged' : 'Unstaged'} ${files.length} file${files.length === 1 ? '' : 's'}`,
          files.map((f) => f.path).join('\n'),
          cwd,
        );
      if (useRepo.getState().repoPath === cwd) {
        if (selected && files.some((f) => f.path === selected.path)) onClear();
        await onRefresh();
      }
    } catch (e) {
      setError(clean(e));
      useRepo.getState().recordActivity('error', `${action === 'stage' ? 'Stage' : 'Unstage'} failed`, clean(e), cwd);
    } finally {
      setPending(false);
    }
  };

  const generate = async () => {
    if (!repoPath || !staged.length || busy) return;
    if (
      (summary.trim() || description.trim()) &&
      !(await askConfirm('Replace commit message?', 'Generating a new message will replace the current draft.', {
        label: 'Generate',
      }))
    )
      return;
    if (useRepo.getState().repoPath !== repoPath) return;
    const cwd = repoPath;
    const original = { summary, description };
    setGenerating(true);
    setError('');
    try {
      const snapshot: { tree: string; diff: string } = await api().stagedForCommitMessage(cwd);
      const settings = useSettings.getState();
      const model =
        (provider === 'openai' ? settings.openaiModel : provider === 'copilot' ? settings.copilotModel : '') ||
        undefined;
      const result = await api().ai.commitMessage(provider, model, snapshot.diff);
      if (!result.ok) throw new Error(result.error.message);
      const text = String(result.text)
        .trim()
        .replace(/^```(?:[\w-]+)?\s*\n/, '')
        .replace(/\n```\s*$/, '')
        .trim();
      const [first, ...rest] = text.split(/\r?\n/);
      if (!first?.trim()) throw new Error('AI did not return a usable commit message.');
      if (useRepo.getState().repoPath !== cwd) return;
      const latest = useRepo.getState().commitDrafts[cwd] ?? EMPTY_DRAFT;
      if (latest.summary !== original.summary || latest.description !== original.description)
        throw new Error('The commit draft changed while AI was working. Generate again if needed.');
      if ((await api().stagedForCommitMessage(cwd)).tree !== snapshot.tree)
        throw new Error('Staged changes changed while AI was working. Generate again.');
      if (useRepo.getState().repoPath !== cwd) return;
      setCommitDraft(cwd, { ...latest, summary: first.trim(), description: rest.join('\n').trim() });
      useRepo.getState().recordActivity('success', 'AI generated a commit message', undefined, cwd);
    } catch (e) {
      if (useRepo.getState().repoPath === cwd) setError(clean(e));
    } finally {
      setGenerating(false);
    }
  };

  const submit = async () => {
    if (!repoPath || missingSummary || busy || conflict.length || operation || (!staged.length && !amend)) return;
    if (
      amend &&
      !(await askConfirm(
        'Amend previous commit?',
        'This replaces the previous commit and changes its hash. If it was pushed, updating the remote may require a force push.',
        { label: 'Amend commit' },
      ))
    )
      return;
    const cwd = repoPath;
    setPending(true);
    setError('');
    try {
      await api().commit(cwd, summary.trim(), description, { amend, signoff });
      setCommitDraft(cwd, null);
      if (useRepo.getState().repoPath === cwd) {
        onClear();
        await refresh();
      }
      notify('success', amend ? 'Commit amended' : 'Commit created');
    } catch (e) {
      setError(clean(e));
      useRepo.getState().recordActivity('error', 'Commit failed', clean(e), cwd);
    } finally {
      setPending(false);
    }
  };

  const group = (label: string, files: FileStatus[], area: 'staged' | 'unstaged') => (
    <section>
      <div className="flex items-center gap-2 border-b border-surface/60 px-4 py-2 text-xs font-semibold uppercase tracking-wide text-sub">
        <span className="flex-1">
          {label} · {files.length}
        </span>
        <button
          disabled={!files.length || busy}
          onClick={() => changeStage(area === 'staged' ? 'unstage' : 'stage', files)}
          className="rounded border border-[#a6e3a1]/50 px-2 py-1 text-[11px] normal-case tracking-normal text-[#a6e3a1] hover:bg-[#a6e3a1]/10 disabled:opacity-40"
        >
          {area === 'staged' ? 'Unstage all' : 'Stage all'}
        </button>
      </div>
      {files.map((f) => {
        const kind = area === 'unstaged' && f.index === '?' ? 'untracked' : area;
        const code = kind === 'untracked' ? '?' : kind === 'staged' ? f.index : f.worktree;
        const active = selected?.path === f.path && selected.area === kind;
        return (
          <div key={f.path} className={`group flex items-center ${active ? 'bg-[#4cc2ff]/20' : 'hover:bg-surface/40'}`}>
            <button
              onClick={() => onSelect({ path: f.path, status: code, area: kind })}
              aria-pressed={active}
              title={f.oldPath ? `${f.oldPath} → ${f.path}` : f.path}
              className="flex min-h-[38px] min-w-0 flex-1 items-center gap-2 px-4 text-left"
            >
              <span
                className={`w-4 shrink-0 text-center font-mono text-xs font-semibold ${code === 'D' ? 'text-[#f38ba8]' : code === 'A' || code === '?' ? 'text-[#a6e3a1]' : 'text-[#fab387]'}`}
              >
                {code}
              </span>
              <span className="min-w-0 flex-1 truncate">{f.path}</span>
            </button>
            <button
              disabled={busy}
              onClick={() => changeStage(area === 'staged' ? 'unstage' : 'stage', [f])}
              aria-label={`${area === 'staged' ? 'Unstage' : 'Stage'} ${f.path}`}
              title={area === 'staged' ? 'Unstage file' : 'Stage file'}
              className="mr-2 rounded p-1.5 text-sub hover:bg-surface hover:text-text disabled:opacity-40"
            >
              {area === 'staged' ? <Minus size={15} /> : <Plus size={15} />}
            </button>
          </div>
        );
      })}
      {!files.length && <p className="px-4 py-2 text-xs text-sub">No {label.toLowerCase()} files.</p>}
    </section>
  );
  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden">
      <div className="flex items-center gap-2 border-b border-surface px-4 py-3">
        <FilePen size={16} className="shrink-0 text-[#fab387]" aria-hidden />
        <h2 className="min-w-0 flex-1 truncate font-semibold">
          {status.length} file change{status.length === 1 ? '' : 's'} on {current}
        </h2>
        <button
          disabled={busy}
          onClick={onRefresh}
          aria-label="Refresh local changes"
          title="Refresh local changes"
          className="rounded p-1.5 text-sub hover:bg-surface hover:text-text disabled:opacity-40"
        >
          <RefreshCw size={15} />
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
        {conflict.length > 0 && (
          <section>
            <div className="border-b border-surface/60 px-4 py-2 text-xs font-semibold uppercase text-[#f9e2af]">
              Conflicted · {conflict.length}
            </div>
            {conflict.map((f) => (
              <button
                key={f.path}
                onClick={() => openConflict(f.path)}
                title={f.path}
                className="block w-full truncate px-4 py-2 text-left text-sm text-[#f9e2af] hover:bg-surface/40"
              >
                {f.path}
              </button>
            ))}
          </section>
        )}
        {group('Unstaged', unstaged, 'unstaged')}
        {group('Staged', staged, 'staged')}
      </div>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
        className="max-h-[65%] shrink-0 space-y-3 overflow-y-auto border-t border-surface p-4"
      >
        <div className="font-semibold">Commit</div>
        {error && (
          <p role="alert" className="max-h-24 overflow-auto whitespace-pre-wrap text-xs text-[#f38ba8]">
            {error}
          </p>
        )}
        {operation && (
          <p className="text-xs text-[#f9e2af]">Finish or abort the {operation.kind} using the conflict panel.</p>
        )}
        {!operation && conflict.length > 0 && (
          <p className="text-xs text-[#f9e2af]">Resolve conflicts before committing.</p>
        )}
        <label className="flex items-center gap-2 text-sm text-sub">
          <input
            type="checkbox"
            checked={amend}
            disabled={busy}
            onChange={(e) => void changeAmend(e.target.checked)}
            className="accent-[#4cc2ff]"
          />{' '}
          Amend previous commit
        </label>
        <button
          type="button"
          onClick={() => void generate()}
          disabled={busy || !staged.length || !!operation || conflict.length > 0}
          title={`Send staged changes to ${providerLabel(provider)} and review the result before committing`}
          className="flex min-h-[36px] w-full items-center justify-center gap-2 rounded-md bg-gradient-to-r from-[#9333ea] to-[#6366f1] px-3 text-sm font-semibold text-white shadow-sm hover:brightness-110 disabled:opacity-40"
        >
          {generating ? <Loader2 size={15} className="animate-spin" /> : <Sparkles size={15} />}{' '}
          {generating ? 'Generating…' : 'Generate commit message with AI'}
        </button>
        <p className="text-xs text-sub">
          Sends staged changes to {providerLabel(provider)}. Review the message before committing.
        </p>
        <label className="sr-only" htmlFor="commit-summary">
          Commit summary
        </label>
        <div className="relative">
          <input
            id="commit-summary"
            value={summary}
            disabled={busy}
            onChange={(e) => updateDraft({ summary: e.target.value })}
            placeholder={amend ? 'Commit summary (optional)' : 'Commit summary'}
            className="w-full rounded-md border border-surface bg-crust px-3 py-2 pr-12 outline-none focus:border-[#4cc2ff]"
          />
          <span className="absolute right-3 top-2.5 text-xs text-sub" title="Recommended summary length">
            {summary.length}/72
          </span>
        </div>
        <label className="sr-only" htmlFor="commit-description">
          Commit description
        </label>
        <textarea
          id="commit-description"
          value={description}
          disabled={busy}
          onChange={(e) => updateDraft({ description: e.target.value })}
          placeholder="Description (optional)"
          rows={3}
          className="w-full resize-y rounded-md border border-surface bg-crust px-3 py-2 outline-none focus:border-[#4cc2ff]"
        />
        <div>
          <button
            type="button"
            aria-expanded={optionsOpen}
            onClick={() => setOptionsOpen(!optionsOpen)}
            className="flex items-center gap-1 text-sm text-sub hover:text-text"
          >
            {optionsOpen ? <ChevronDown size={15} /> : <ChevronRight size={15} />} Commit options
          </button>
          {optionsOpen && (
            <label className="mt-2 flex items-center gap-2 text-sm text-sub">
              <input
                type="checkbox"
                checked={signoff}
                disabled={busy}
                onChange={(e) => updateDraft({ signoff: e.target.checked })}
                className="accent-[#4cc2ff]"
              />{' '}
              Sign off
            </label>
          )}
        </div>
        <button
          type="submit"
          disabled={busy || missingSummary || !!operation || conflict.length > 0 || (!staged.length && !amend)}
          className="min-h-[40px] w-full rounded-md border border-[#a6e3a1]/60 bg-[#a6e3a1]/15 px-3 py-2 font-medium text-[#a6e3a1] hover:bg-[#a6e3a1]/25 disabled:border-surface disabled:bg-transparent disabled:text-sub/60"
        >
          {generating
            ? 'Generating message…'
            : pending
              ? 'Working…'
              : amend
                ? 'Amend commit'
                : staged.length
                  ? `Commit ${staged.length} staged file${staged.length === 1 ? '' : 's'}`
                  : 'Stage changes to commit'}
        </button>
      </form>
    </div>
  );
}
