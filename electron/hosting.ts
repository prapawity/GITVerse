// Pull/merge request hosting: per-host tokens in secure storage and one authenticated API call.
// Provider logic (which endpoints, how to read them) lives in the renderer; this side only checks
// the request, attaches the token for that exact host, and returns the JSON.
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { ipcMain, net, shell } from 'electron';
import { isSessionOnly, readSecret, writeSecret } from './ai/common';
import { pushTokenKey } from './pushTokens';
import {
  accountName,
  apiBase,
  authHeaders,
  checkRequest,
  hostTokenKey,
  type ConnectResult,
  type HostKind,
  type HostRequest,
  type HostResponse,
  webUrlAllowed,
} from '../src/shared/pullRequests';

async function send(request: HostRequest, token: string | null): Promise<HostResponse> {
  const headers = authHeaders(request.kind, token);
  if (request.body !== undefined) headers['Content-Type'] = 'application/json';
  const base = apiBase(request.kind, request.host);
  const origin = new URL(base).origin;
  let url = base + request.path;
  let response: Response | null = null;
  // follow up to 3 redirects, only within the same API origin so the token never leaves it
  for (let hop = 0; hop < 4; hop++) {
    // Electron's net uses Chromium's network stack: the OS certificate store (company CAs) and system proxy
    response = await net
      .fetch(url, {
        method: request.method,
        headers,
        body: request.body === undefined ? undefined : JSON.stringify(request.body),
        redirect: 'manual',
        signal: AbortSignal.timeout(30_000),
      })
      .catch((error: Error & { cause?: { code?: string; message?: string } }) => {
        const cause = error.cause?.code ?? error.cause?.message;
        throw new Error(`Could not reach ${request.host}: ${error.message}${cause ? ` (${cause})` : ''}`);
      });
    const location = response.status >= 300 && response.status < 400 ? response.headers.get('location') : null;
    if (!location) break;
    const next = new URL(location, url);
    if (next.origin !== origin) throw new Error(`${request.host} redirected outside its API.`);
    url = next.href;
  }
  if (!response) throw new Error(`Could not reach ${request.host}.`);
  const text = await response.text();
  let data: unknown = text;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    // not JSON (an HTML error page, for example): return the text
  }
  return { status: response.status, data };
}

/** The account a token signs in as, or null when the host rejects it. */
async function verify(kind: HostKind, host: string, token: string): Promise<string | null> {
  const response = await send({ kind, host, method: 'GET', path: '/user' }, token).catch(() => null);
  return response && response.status === 200 ? accountName(response.data) || 'signed in' : null;
}

// GUI apps on macOS do not get the shell PATH, so look where package managers install CLIs too
const SEARCH = [...(process.env.PATH ?? '').split(path.delimiter), '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin'];
function findTool(name: string) {
  const exe = process.platform === 'win32' ? `${name}.exe` : name;
  for (const dir of SEARCH) if (dir && existsSync(path.join(dir, exe))) return path.join(dir, exe);
  return null;
}

function run(file: string, args: string[], input?: string): Promise<string> {
  return new Promise((resolve) => {
    const child = execFile(
      file,
      args,
      {
        timeout: 8000,
        // never open a prompt or browser while looking for saved credentials
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never', GH_PROMPT_DISABLED: '1' },
      },
      (error, stdout) => resolve(error ? '' : stdout),
    );
    child.stdin?.end(input ?? '');
  });
}

/** Credentials already on this machine that might work as an API token, most likely first. */
async function candidates(
  kind: HostKind,
  host: string,
  repo: string | null,
  profileIds: string[],
): Promise<{ source: string; token: string }[]> {
  const found: { source: string; token: string }[] = [];
  const add = (source: string, token: string | null | undefined) => {
    const value = token?.trim();
    if (value && !found.some((f) => f.token === value)) found.push({ source, token: value });
  };
  if (repo) for (const id of profileIds) add('push profile token', readSecret(pushTokenKey(repo, id)));
  const git = findTool('git') ?? 'git';
  const filled = await run(git, ['credential', 'fill'], `protocol=https\nhost=${host}\n\n`);
  const fields: Record<string, string> = {};
  for (const line of filled.split('\n')) {
    const at = line.indexOf('=');
    if (at > 0) fields[line.slice(0, at)] = line.slice(at + 1);
  }
  if (fields.password)
    add(
      'Git saved login',
      kind === 'bitbucket' && fields.username ? `${fields.username}:${fields.password}` : fields.password,
    );
  if (kind === 'github') {
    const gh = findTool('gh');
    if (gh) add('GitHub CLI (gh)', await run(gh, ['auth', 'token', '--hostname', host]));
    if (host === 'github.com') add('GITHUB_TOKEN', process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN);
  }
  if (kind === 'gitlab') {
    const glab = findTool('glab');
    if (glab) add('GitLab CLI (glab)', await run(glab, ['config', 'get', 'token', '--host', host]));
    // an environment token belongs to gitlab.com; never offer it to another server
    if (host === 'gitlab.com') add('GITLAB_TOKEN', process.env.GITLAB_TOKEN);
  }
  return found;
}

export function registerHosting() {
  const invalid = (kind: HostKind, host: string) => checkRequest({ kind, host, method: 'GET', path: '/' });
  ipcMain.handle('hosting:tokenStatus', (_e, kind: HostKind, host: string) =>
    invalid(kind, host) ? false : !!readSecret(hostTokenKey(kind, host)),
  );
  ipcMain.handle('hosting:setToken', (_e, kind: HostKind, host: string, token: string | null) => {
    const problem = invalid(kind, host);
    if (problem) throw new Error(problem);
    writeSecret(hostTokenKey(kind, host), token?.trim() || null);
  });
  /**
   * Check a new token before saving it, or the saved one; otherwise look for credentials already on
   * this machine (push profile, Git's saved login, gh/glab) and keep the first the host accepts.
   */
  ipcMain.handle(
    'hosting:connect',
    async (
      _e,
      kind: HostKind,
      host: string,
      options: { token?: string; repo?: string; profileIds?: string[] } = {},
    ): Promise<ConnectResult> => {
      const problem = invalid(kind, host);
      if (problem) throw new Error(problem);
      const entered = options.token?.trim();
      if (entered) {
        const account = await verify(kind, host, entered);
        if (!account) return { connected: false, tried: ['the token you entered'] };
        const stored = writeSecret(hostTokenKey(kind, host), entered);
        return { connected: true, account, source: 'access token', sessionOnly: stored === 'session' };
      }
      const saved = readSecret(hostTokenKey(kind, host));
      if (saved) {
        const account = await verify(kind, host, saved);
        if (account)
          return {
            connected: true,
            account,
            source: 'access token',
            sessionOnly: isSessionOnly(hostTokenKey(kind, host)),
          };
      }
      const tried: string[] = saved ? ['saved access token'] : [];
      for (const candidate of await candidates(kind, host, options.repo ?? null, options.profileIds ?? [])) {
        tried.push(candidate.source);
        const account = await verify(kind, host, candidate.token);
        if (account) {
          const stored = writeSecret(hostTokenKey(kind, host), candidate.token);
          return { connected: true, account, source: candidate.source, sessionOnly: stored === 'session' };
        }
      }
      return { connected: false, tried };
    },
  );
  ipcMain.handle('hosting:open', (_e, kind: HostKind, host: string, url: string) => {
    if (!webUrlAllowed(kind, host, url)) throw new Error("Refusing to open a link outside this repository's host.");
    return shell.openExternal(url);
  });
  ipcMain.handle('hosting:request', async (_e, request: HostRequest): Promise<HostResponse> => {
    const problem = checkRequest(request);
    if (problem) throw new Error(problem);
    return send(request, readSecret(hostTokenKey(request.kind, request.host)));
  });
}
