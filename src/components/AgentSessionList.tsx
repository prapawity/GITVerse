import { useEffect, useState } from 'react';
import { FolderOpen, GitPullRequest, Plus, SquareTerminal, Trash2 } from 'lucide-react';
import { desktopApi } from '../platform/api';
import { useRepo } from '../store/repoStore';
import { useSettings, type AgentSession } from '../store/settingsStore';
import { launchAgent, removeAgentSession, terminalFor } from '../lib/agents';
import { focusTerminal, onTerminalsChanged, terminalState } from './TerminalPanel';
import { askConfirm } from './Dialogs';
import { useNewAgentSession } from './NewAgentSession';

const EMPTY: AgentSession[] = [];
const STATE_LABEL = { running: 'Running', exited: 'Agent exited', closed: 'Not open' } as const;
const STATE_DOT = { running: 'bg-success', exited: 'bg-warning', closed: 'bg-sub/50' } as const;

/** Agent sessions of the open repository, for the sidebar. Reports its count through `onCount`. */
export function AgentSessionList({
  repoPath,
  onCount,
  onPullRequest,
}: {
  repoPath: string;
  onCount: (n: number) => void;
  onPullRequest: (path: string) => void;
}) {
  const sessions = useSettings((s) => s.agentSessions[repoPath] ?? EMPTY);
  const [changes, setChanges] = useState<Record<string, number>>({});
  const [, rerender] = useState(0);
  useEffect(() => onTerminalsChanged(() => rerender((n) => n + 1)), []);
  useEffect(() => onCount(sessions.length), [sessions.length, onCount]);

  // uncommitted files per session folder, refreshed while the app is visible
  useEffect(() => {
    if (!sessions.length) return;
    let active = true;
    const load = async () => {
      if (document.visibilityState !== 'visible') return;
      const entries = await Promise.all(
        sessions.map(
          async (s) =>
            [
              s.id,
              (
                (await desktopApi()
                  .status(s.path)
                  .catch(() => null)) as unknown[] | null
              )?.length ?? -1,
            ] as const,
        ),
      );
      if (active) setChanges(Object.fromEntries(entries));
    };
    void load();
    const timer = setInterval(() => void load(), 15_000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [sessions]);

  const remove = async (s: AgentSession) => {
    const dirty = (changes[s.id] ?? 0) > 0;
    if (
      !(await askConfirm(
        'Remove agent session',
        `Remove the folder ${s.path} and delete the branch ${s.branch}?${dirty ? `\n\nIt has ${changes[s.id]} uncommitted change${changes[s.id] === 1 ? '' : 's'}, which will be lost.` : ''}\n\nCommits already pushed or merged elsewhere are not affected.`,
        { label: 'Remove', danger: true },
      ))
    )
      return;
    try {
      await removeAgentSession(repoPath, s, true, dirty);
    } catch (e) {
      useRepo.getState().notify('error', 'Could not remove the agent session', String((e as Error)?.message ?? e));
    }
  };

  return (
    <div className="pb-1">
      <div className="px-4 pb-2">
        <button
          type="button"
          onClick={() => useNewAgentSession.getState().show()}
          className="flex w-full items-center justify-center gap-1.5 rounded-md border border-dashed border-ai/40 py-1.5 text-sm text-ai hover:bg-ai/10"
        >
          <Plus size={14} aria-hidden /> New agent session
        </button>
      </div>
      {!sessions.length && (
        <p className="px-6 pb-1 text-xs text-sub">
          Each agent works on its own branch in a separate folder, so several can run at once.
        </p>
      )}
      {sessions.map((s) => {
        const state = terminalState(terminalFor(s.id));
        const count = changes[s.id];
        return (
          <article
            key={s.id}
            className="mx-3 mb-2 rounded-lg border border-surface/70 px-3 py-2"
            aria-label={`${s.agentName}: ${s.task}`}
          >
            <div className="flex items-center gap-2 text-xs">
              <span className={`h-2 w-2 shrink-0 rounded-full ${STATE_DOT[state]}`} aria-hidden />
              <span className="font-medium">{s.agentName}</span>
              <span className="text-sub">{STATE_LABEL[state]}</span>
              <span className="ml-auto tabular-nums text-sub">
                {count === -1 ? 'Folder missing' : count ? `${count} changed` : count === 0 ? 'No changes' : ''}
              </span>
            </div>
            <p className="mt-1 line-clamp-2 text-sm" title={s.task}>
              {s.task}
            </p>
            <p className="mt-0.5 truncate text-xs text-sub" title={s.path}>
              {s.branch} from {s.base}
            </p>
            <div className="mt-1.5 flex gap-1">
              <button
                type="button"
                onClick={() => {
                  const key = terminalFor(s.id);
                  if (!(key !== undefined && state !== 'closed' && focusTerminal(key))) void launchAgent(s, false);
                }}
                title={state === 'running' ? 'Show its terminal' : `Start ${s.agentName} again in this folder`}
                className="flex items-center gap-1 rounded px-1.5 py-1 text-xs text-sub hover:bg-surface hover:text-text"
              >
                <SquareTerminal size={13} aria-hidden /> {state === 'running' ? 'Terminal' : 'Resume'}
              </button>
              <button
                type="button"
                onClick={() => void useRepo.getState().openRepo(s.path)}
                title="Open this worktree as a tab to review its changes"
                className="flex items-center gap-1 rounded px-1.5 py-1 text-xs text-sub hover:bg-surface hover:text-text"
              >
                <FolderOpen size={13} aria-hidden /> Open
              </button>
              <button
                type="button"
                onClick={() => onPullRequest(s.path)}
                title="Create a pull / merge request from this branch"
                className="flex items-center gap-1 rounded px-1.5 py-1 text-xs text-sub hover:bg-surface hover:text-text"
              >
                <GitPullRequest size={13} aria-hidden /> PR
              </button>
              <button
                type="button"
                onClick={() => void remove(s)}
                aria-label={`Remove agent session ${s.branch}`}
                title="Remove the folder and branch"
                className="ml-auto rounded p-1 text-sub hover:bg-danger/15 hover:text-danger"
              >
                <Trash2 size={13} />
              </button>
            </div>
          </article>
        );
      })}
    </div>
  );
}
