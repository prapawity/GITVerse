/**
 * Agent Sessions: each AI coding agent works on its own branch in its own worktree, started in a
 * terminal tab of the app. Sessions are remembered per repository; the terminal tab is per app run.
 */
import { desktopApi } from '../platform/api';
import { useRepo } from '../store/repoStore';
import { useSettings, type AgentSession } from '../store/settingsStore';
import { runInTerminal } from '../components/TerminalPanel';
import { agentCommand } from './agentCommands';

export { agentBranchName, agentCommand, agentWorktreePath, shellQuote } from './agentCommands';

const terminals = new Map<string, number>(); // session id → terminal tab key (this run of the app)
export const terminalFor = (id: string) => terminals.get(id);

const sessionsOf = (repo: string) => useSettings.getState().agentSessions[repo] ?? [];
const save = (repo: string, list: AgentSession[]) => useSettings.getState().setAgentSessions(repo, list);

/** Start (or restart) the agent of a session in a new terminal tab. */
export async function launchAgent(session: AgentSession, firstRun: boolean) {
  const { command, clipboard } = agentCommand(session.agent, firstRun ? session.task : '');
  const setup = firstRun ? useSettings.getState().agentSetup.trim() : '';
  const line = setup ? `${setup} && ${command}` : command;
  if (clipboard && firstRun) await navigator.clipboard.writeText(session.task).catch(() => {});
  terminals.set(
    session.id,
    await runInTerminal(session.path, line, `${session.agentName}: ${session.branch.split('/').pop()}`),
  );
  if (clipboard && firstRun)
    useRepo.getState().notify('info', 'Task copied', `Paste it into ${session.agentName} to start.`);
}

export async function startAgentSession(input: {
  repo: string;
  agent: string;
  agentName: string;
  task: string;
  base: string;
  branch: string;
  path: string;
}) {
  await desktopApi().worktreeAddBranch(input.repo, input.path, input.branch, input.base);
  const session: AgentSession = {
    id: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
    agent: input.agent,
    agentName: input.agentName,
    task: input.task.trim(),
    branch: input.branch,
    base: input.base,
    path: input.path,
    created: Date.now(),
  };
  save(input.repo, [session, ...sessionsOf(input.repo)]);
  await useRepo.getState().refresh(true);
  await launchAgent(session, true);
  return session;
}

/** Remove the worktree (and its branch when `deleteBranch`), then forget the session. */
export async function removeAgentSession(repo: string, session: AgentSession, deleteBranch: boolean, force: boolean) {
  const exists: boolean = await desktopApi()
    .inspectWorkspace(repo)
    .then((w: { worktrees: { path: string }[] }) =>
      w.worktrees.some((x) => x.path.replace(/\\/g, '/') === session.path.replace(/\\/g, '/')),
    )
    .catch(() => false);
  if (exists)
    await desktopApi().worktreeRemove(
      repo,
      session.path.replace(/\\/g, '/'),
      force,
      deleteBranch ? session.branch : null,
    );
  save(
    repo,
    sessionsOf(repo).filter((s) => s.id !== session.id),
  );
  terminals.delete(session.id);
  await useRepo.getState().refresh(true);
}
