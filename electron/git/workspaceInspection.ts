import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);
const options = (cwd: string) => ({ cwd, maxBuffer: 4 * 1024 * 1024, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' } });

// Repository configuration may contain passwords or tokens. Never send URL credentials,
// query strings, or fragments to the renderer.
function displayUrl(value: string) {
  const cleaned = value.replace(/[\r\n]/g, ' ');
  try {
    const parsed = new URL(cleaned);
    parsed.username = '';
    parsed.password = '';
    parsed.search = '';
    parsed.hash = '';
    return parsed.toString();
  } catch {
    return cleaned
      .replace(/^([a-z][a-z0-9+.-]*:\/\/)[^/]*@/i, '$1')
      .replace(/^[^/@:]+@(?=[^/:]+:)/, '')
      .replace(/[?#].*$/, '');
  }
}

export async function inspectWorkspace(cwd: string) {
  const worktreeOut = await run('git', ['worktree', 'list', '--porcelain', '-z'], options(cwd));
  let config = '';
  try {
    config = (await run('git', ['config', '--null', '--get-regexp', '^remote\\..*\\.(url|pushurl)$'], options(cwd))).stdout;
  } catch (error: any) {
    // Git uses exit code 1 when there are no matching remote settings.
    if (error.code !== 1) throw new Error(String(error.stderr || error.message).trim(), { cause: error });
  }
  const remotes = new Map<string, { name: string; fetch: string[]; push: string[] }>();
  for (const item of config.split('\0').filter(Boolean)) {
    const newline = item.indexOf('\n');
    if (newline < 0) continue;
    const key = item.slice(0, newline);
    const match = /^remote\.(.+)\.(url|pushurl)$/i.exec(key);
    if (!match) continue;
    const name = match[1];
    const remote = remotes.get(name) ?? { name, fetch: [], push: [] };
    (match[2].toLowerCase() === 'url' ? remote.fetch : remote.push).push(displayUrl(item.slice(newline + 1)));
    remotes.set(name, remote);
  }
  const worktrees = worktreeOut.stdout.split('\0\0').filter(Boolean).map((record) => {
    const fields = record.split('\0').filter(Boolean);
    const value = (name: string) => fields.find((field) => field.startsWith(`${name} `))?.slice(name.length + 1);
    const branch = value('branch');
    return {
      path: value('worktree') ?? '',
      head: value('HEAD') ?? '',
      branch: branch?.startsWith('refs/heads/') ? branch.slice(11) : branch,
      detached: fields.includes('detached'),
      bare: fields.includes('bare'),
      locked: fields.some((field) => field === 'locked' || field.startsWith('locked ')),
      prunable: fields.some((field) => field === 'prunable' || field.startsWith('prunable ')),
    };
  }).filter((entry) => entry.path);
  return { remotes: [...remotes.values()], worktrees };
}
