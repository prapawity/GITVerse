import { useEffect, useMemo, useState } from 'react';
import { Bot, Loader2, X } from 'lucide-react';
import { create } from 'zustand';
import { desktopApi } from '../platform/api';
import { useRepo } from '../store/repoStore';
import { useSettings } from '../store/settingsStore';
import { agentBranchName, agentWorktreePath, startAgentSession } from '../lib/agents';

export const useNewAgentSession = create<{ open: boolean; show: () => void; close: () => void }>((set) => ({
  open: false,
  show: () => set({ open: true }),
  close: () => set({ open: false }),
}));

const field = 'w-full rounded-md border border-surface bg-crust px-3 py-2 text-sm outline-none focus:border-accent';
const clean = (e: unknown) =>
  String((e as Error)?.message ?? e).replace(/^Error invoking remote method '[^']*': (Error: )?/, '');

/** Start an AI coding agent on its own branch and worktree, in a terminal tab of the app. */
export function NewAgentSession() {
  const open = useNewAgentSession((s) => s.open);
  const close = useNewAgentSession((s) => s.close);
  const repo = useRepo((s) => s.repoPath);
  const refs = useRepo((s) => s.refs);
  const savedSetup = useSettings((s) => s.agentSetup);
  const [agents, setAgents] = useState<{ id: string; name: string }[] | null>(null);
  const [agent, setAgent] = useState('');
  const [task, setTask] = useState('');
  const [base, setBase] = useState('');
  const [branch, setBranch] = useState('');
  const [branchEdited, setBranchEdited] = useState(false);
  const [folder, setFolder] = useState('');
  const [folderEdited, setFolderEdited] = useState(false);
  const [setup, setSetup] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!open) return;
    setTask('');
    setError('');
    setBranchEdited(false);
    setFolderEdited(false);
    setSetup(savedSetup);
    setBase(useRepo.getState().refs.local.find((b) => b.current)?.name ?? '');
    void desktopApi()
      .agents()
      .then((list) => {
        setAgents(list);
        setAgent((a) => a || list[0]?.id || '');
      })
      .catch(() => setAgents([]));
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  const agentName = agents?.find((a) => a.id === agent)?.name ?? agent;
  const suggestedBranch = useMemo(() => agentBranchName(task, agent || 'agent'), [task, agent]);
  const actualBranch = branchEdited ? branch : suggestedBranch;
  const actualFolder = folderEdited ? folder : repo ? agentWorktreePath(repo, actualBranch) : '';

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && !busy && close();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, busy, close]);
  if (!open || !repo) return null;

  const start = async () => {
    if (!task.trim() || !agent || busy) return;
    setBusy(true);
    setError('');
    try {
      useSettings.getState().set('agentSetup', setup.trim());
      await startAgentSession({
        repo,
        agent,
        agentName,
        task,
        base,
        branch: actualBranch.trim(),
        path: actualFolder.trim(),
      });
      close();
    } catch (e) {
      setError(clean(e));
    } finally {
      setBusy(false);
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
        aria-labelledby="agent-title"
        onMouseDown={(e) => e.stopPropagation()}
        className="flex max-h-[90vh] w-full max-w-[640px] flex-col overflow-hidden rounded-xl border border-surface bg-mantle shadow-2xl"
      >
        <header className="flex items-center gap-3 border-b border-surface px-5 py-4">
          <Bot size={18} className="text-ai" aria-hidden />
          <div className="flex-1">
            <h2 id="agent-title" className="font-semibold">
              New agent session
            </h2>
            <p className="text-sm text-sub">
              The agent works on its own branch in a separate folder, so your work is untouched.
            </p>
          </div>
          <button onClick={close} disabled={busy} aria-label="Close" className="rounded p-1.5 hover:bg-surface">
            <X size={17} />
          </button>
        </header>
        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-5 py-4">
          {agents && !agents.length && (
            <p className="rounded-md border border-warning/40 bg-warning/5 p-3 text-sm text-warning">
              No coding agent was found on this computer. Install one, for example Claude Code (npm install -g
              @anthropic-ai/claude-code), Codex CLI or Gemini CLI, then open this again.
            </p>
          )}
          <label className="block text-sm">
            <span className="mb-1 block text-sub">Task</span>
            <textarea
              autoFocus
              value={task}
              onChange={(e) => setTask(e.target.value)}
              rows={4}
              placeholder="What should the agent do? e.g. Add input validation to the login form and cover it with tests"
              className={`${field} resize-y`}
            />
          </label>
          <div className="grid grid-cols-2 gap-3">
            <label className="block text-sm">
              <span className="mb-1 block text-sub">Agent</span>
              <select
                value={agent}
                onChange={(e) => setAgent(e.target.value)}
                className={field}
                disabled={!agents?.length}
              >
                {!agents && <option>Looking for agents…</option>}
                {agents?.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="block text-sm">
              <span className="mb-1 block text-sub">Start from</span>
              <select value={base} onChange={(e) => setBase(e.target.value)} className={field}>
                {refs.local.map((b) => (
                  <option key={b.name} value={b.name}>
                    {b.name}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <label className="block text-sm">
            <span className="mb-1 block text-sub">New branch</span>
            <input
              value={actualBranch}
              onChange={(e) => {
                setBranchEdited(true);
                setBranch(e.target.value);
              }}
              className={field}
            />
          </label>
          <label className="block text-sm">
            <span className="mb-1 block text-sub">Folder</span>
            <input
              value={actualFolder}
              onChange={(e) => {
                setFolderEdited(true);
                setFolder(e.target.value);
              }}
              className={`${field} font-mono text-xs`}
            />
          </label>
          <label className="block text-sm">
            <span className="mb-1 block text-sub">Setup commands (optional, remembered)</span>
            <input
              value={setup}
              onChange={(e) => setSetup(e.target.value)}
              placeholder="e.g. npm install"
              className={`${field} font-mono text-xs`}
            />
            <span className="mt-1 block text-xs text-sub">Run in the new folder before the agent starts.</span>
          </label>
          {error && (
            <p role="alert" className="whitespace-pre-wrap text-sm text-danger">
              {error}
            </p>
          )}
        </div>
        <footer className="flex justify-end gap-2 border-t border-surface px-5 py-3">
          <button onClick={close} disabled={busy} className="btn-secondary px-4 py-1.5 text-sm">
            Cancel
          </button>
          <button
            onClick={() => void start()}
            disabled={busy || !task.trim() || !agent || !base}
            className="flex items-center gap-2 rounded-md bg-ai/20 px-4 py-1.5 text-sm font-semibold text-ai hover:bg-ai/30 disabled:opacity-40"
          >
            {busy && <Loader2 size={14} className="animate-spin" aria-hidden />}
            Start {agentName || 'agent'}
          </button>
        </footer>
      </section>
    </div>
  );
}
