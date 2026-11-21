/** Pure helpers for Agent Sessions: how each agent is started, and the branch / folder it gets. */

/** How each agent takes the task when it starts; the rest get it on the clipboard to paste. */
const PROMPT: Record<string, 'arg' | 'flag-i' | 'clipboard'> = {
  claude: 'arg',
  codex: 'arg',
  cursor: 'arg',
  gemini: 'flag-i',
  copilot: 'clipboard',
  opencode: 'clipboard',
};
const COMMAND: Record<string, string> = {
  claude: 'claude',
  codex: 'codex',
  cursor: 'cursor-agent',
  gemini: 'gemini',
  copilot: 'copilot',
  opencode: 'opencode',
};

// navigator is missing in older Node (tests); the app always has it
const windows = typeof navigator !== 'undefined' && /Win/.test(navigator.platform);
/**
 * Quote one argument for the terminal's shell, or null when it cannot be passed safely.
 * On Windows the shell may be cmd (expands %VAR% and !VAR!, and has no escape for `"`) or PowerShell
 * (expands $… and `…` in double quotes), so a task with any of those characters is never typed into
 * the terminal; the caller hands it over on the clipboard instead.
 */
export function shellQuote(text: string, win = windows): string | null {
  if (!win) return `'${text.replace(/'/g, `'\\''`)}'`;
  return /["%!$`\r\n\0]/.test(text) ? null : `"${text}"`;
}

export function agentCommand(agent: string, task: string, win = windows): { command: string; clipboard: boolean } {
  const bin = COMMAND[agent];
  if (!bin) throw new Error('Unknown agent.');
  const style = PROMPT[agent] ?? 'clipboard';
  const text = task.trim();
  const quoted = text && style !== 'clipboard' ? shellQuote(text, win) : null;
  if (quoted && style === 'arg') return { command: `${bin} ${quoted}`, clipboard: false };
  if (quoted && style === 'flag-i') return { command: `${bin} -i ${quoted}`, clipboard: false };
  return { command: bin, clipboard: !!text };
}

/** `agent/fix-login-crash` from the task text. */
export function agentBranchName(task: string, agent: string) {
  const slug = task
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .split('-')
    .slice(0, 5)
    .join('-');
  return `agent/${slug || `${agent}-${Date.now().toString(36)}`}`;
}

/** Worktrees live next to the repository: `<parent>/<repo>.agents/<branch leaf>`. */
export function agentWorktreePath(repo: string, branch: string) {
  const sep = repo.includes('\\') ? '\\' : '/';
  const trimmed = repo.replace(/[\\/]+$/, '');
  const at = trimmed.lastIndexOf(sep);
  const parent = trimmed.slice(0, at);
  const name = trimmed.slice(at + 1);
  return `${parent}${sep}${name}.agents${sep}${branch.split('/').pop()}`;
}
