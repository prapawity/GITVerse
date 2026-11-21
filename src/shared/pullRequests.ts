/**
 * Pull/merge request hosting contract shared by the renderer and the Electron backend.
 * The Rust backend (src-tauri/core/src/hosting.rs) mirrors `apiBase` and `checkRequest`.
 *
 * A token is stored per (kind, host) and is only ever sent to that host's API, so a remote URL
 * cannot redirect a saved token somewhere else.
 */
export type HostKind = 'github' | 'gitlab' | 'bitbucket';
export const HOST_KINDS: HostKind[] = ['github', 'gitlab', 'bitbucket'];
export const HOST_LABEL: Record<HostKind, string> = { github: 'GitHub', gitlab: 'GitLab', bitbucket: 'Bitbucket' };
/** What the provider calls the feature. */
export const REQUEST_NOUN: Record<HostKind, string> = {
  github: 'Pull Request',
  gitlab: 'Merge Request',
  bitbucket: 'Pull Request',
};

export interface HostedRepo {
  kind: HostKind;
  host: string; // e.g. github.com, gitlab.example.com:8443
  /** owner/name for GitHub and Bitbucket; full group/subgroup/name path for GitLab */
  path: string;
}

export interface HostRequest {
  kind: HostKind;
  host: string;
  method: 'GET' | 'POST';
  path: string; // API path after the base, starting with '/'
  body?: unknown;
}

/** Result of connecting to a host: which credential worked, or which ones were tried. */
export interface ConnectResult {
  connected: boolean;
  account?: string;
  source?: string;
  tried?: string[];
  /** the OS keychain refused access: the token only lasts until the app quits */
  sessionOnly?: boolean;
}

/** Display name from a provider's `/user` response. */
export function accountName(data: unknown): string {
  const d = (data ?? {}) as Record<string, unknown>;
  const name = d.login ?? d.username ?? d.display_name ?? d.nickname ?? d.name;
  return typeof name === 'string' ? name : '';
}

/** Page where the user creates a token, with the right scopes pre-filled where the host supports it. */
export function tokenPageUrl(kind: HostKind, host: string): string {
  if (kind === 'github')
    return `https://${host}/settings/tokens/new?scopes=repo&description=${encodeURIComponent('GITVerse')}`;
  if (kind === 'gitlab')
    return `https://${host}/-/user_settings/personal_access_tokens?name=${encodeURIComponent('GITVerse')}&scopes=api`;
  return 'https://bitbucket.org/account/settings/app-passwords/new';
}

export interface HostResponse {
  status: number;
  data: unknown;
}

const HOST_RE = /^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?(?::\d{1,5})?$/i;

export function checkRequest(request: HostRequest): string | null {
  if (!request || !HOST_KINDS.includes(request.kind)) return 'Unknown hosting provider.';
  if (typeof request.host !== 'string' || !HOST_RE.test(request.host)) return 'Invalid host.';
  if (request.kind === 'bitbucket' && request.host.toLowerCase() !== 'bitbucket.org')
    return 'Only Bitbucket Cloud (bitbucket.org) is supported.';
  if (request.method !== 'GET' && request.method !== 'POST') return 'Unsupported request method.';
  const path = request.path;
  // `..` is refused only as a whole path segment: GitHub's compare uses `base...head`
  if (
    typeof path !== 'string' ||
    !path.startsWith('/') ||
    path.length > 2000 ||
    /[\s\\@]|\/\/|(?:^|\/)\.\.(?:[/?]|$)/.test(path)
  )
    return 'Invalid API path.';
  return null;
}

export function apiBase(kind: HostKind, host: string): string {
  const lower = host.toLowerCase();
  if (kind === 'github') return lower === 'github.com' ? 'https://api.github.com' : `https://${lower}/api/v3`;
  if (kind === 'gitlab') return `https://${lower}/api/v4`;
  return 'https://api.bitbucket.org/2.0';
}

export function authHeaders(kind: HostKind, token: string | null): Record<string, string> {
  const headers: Record<string, string> = { Accept: 'application/json', 'User-Agent': 'GITVerse' };
  if (kind === 'github') headers.Accept = 'application/vnd.github+json';
  if (!token) return headers;
  if (kind === 'gitlab') headers['PRIVATE-TOKEN'] = token;
  // Bitbucket app passwords are entered as "username:app-password"; access tokens are plain
  else if (kind === 'bitbucket' && token.includes(':'))
    headers.Authorization = `Basic ${btoa(unescape(encodeURIComponent(token)))}`;
  else headers.Authorization = `Bearer ${token}`;
  return headers;
}

/** Whether `url` is an https page on the repository's own web host; the only links the app opens. */
export function webUrlAllowed(kind: HostKind, host: string, url: string): boolean {
  if (checkRequest({ kind, host, method: 'GET', path: '/' })) return false;
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' && !parsed.username && parsed.host.toLowerCase() === host.toLowerCase();
  } catch {
    return false;
  }
}

/** Secret-store key for a host's token; same string on both backends. */
export const hostTokenKey = (kind: HostKind, host: string) => `hosting.token.${kind}.${host.toLowerCase()}`;

/**
 * Work out the hosting provider from a remote URL (HTTPS, SSH or scp-style).
 * Self-hosted GitLab/GitHub Enterprise are recognised by "gitlab"/"github" in the host name;
 * `override` maps other hosts to a kind (saved per repository by the UI).
 */
export function detectHostedRepo(remote: string, override?: HostKind | null): HostedRepo | null {
  const url = remote.trim();
  let host: string;
  let path: string;
  const scp = /^(?:[\w.-]+@)?([^/:\s]+):(?!\/\/)(.+)$/.exec(url);
  if (/^[a-z+]+:\/\//i.test(url)) {
    try {
      const parsed = new URL(url.replace(/^git\+/, ''));
      host = parsed.hostname;
      // keep a custom HTTPS port (APIs live there too); SSH ports are not the web port
      if (parsed.port && /^https?:$/.test(parsed.protocol)) host += `:${parsed.port}`;
      path = parsed.pathname;
    } catch {
      return null;
    }
  } else if (scp) {
    host = scp[1];
    path = scp[2];
  } else return null;
  // Bitbucket/GitHub SSH hosts sometimes carry a "ssh." / "altssh." prefix
  host = host.toLowerCase().replace(/^(?:alt)?ssh\./, '');
  path = path
    .replace(/^\/+/, '')
    .replace(/\.git\/?$/, '')
    .replace(/\/+$/, '');
  if (!host || !path.includes('/')) return null;
  const kind: HostKind | null =
    override ??
    (host === 'github.com' || host.includes('github')
      ? 'github'
      : host === 'bitbucket.org'
        ? 'bitbucket'
        : host.includes('gitlab')
          ? 'gitlab'
          : null);
  if (!kind) return null;
  // GitHub and Bitbucket paths are exactly owner/name; GitLab allows nested groups
  if (kind !== 'gitlab') path = path.split('/').slice(-2).join('/');
  return { kind, host, path };
}

/** Host part of a remote URL, used when asking the user which provider a self-hosted server runs. */
export function remoteHost(remote: string): string | null {
  const repo = detectHostedRepo(remote, 'gitlab');
  return repo?.host ?? null;
}
