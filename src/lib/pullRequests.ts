/**
 * Pull/merge request client for GitHub, GitLab and Bitbucket Cloud. Every call goes through the
 * desktop bridge (`hosting.request`), which holds the token; this module only knows the endpoints.
 */
import { desktopApi } from '../platform/api';
import { REQUEST_NOUN, type HostedRepo, type HostKind } from '../shared/pullRequests';

export interface Template {
  name: string;
  body: string;
  source: 'project' | 'local';
}
export interface PastRequest {
  title: string;
  body: string;
}
export interface Comparison {
  commits: string[];
  files: { path: string; status: string; additions?: number; deletions?: number; patch?: string }[];
  /** Bitbucket returns one unified diff instead of per-file patches */
  diff?: string;
}
export interface NewRequest {
  base: string;
  head: string;
  title: string;
  body: string;
  draft: boolean;
}

export class HostError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
  get needsToken() {
    return this.status === 401 || this.status === 403 || this.status === 404;
  }
}

const enc = encodeURIComponent;
const project = (repo: HostedRepo) => `/projects/${enc(repo.path)}`;
const repoPath = (repo: HostedRepo) => (repo.kind === 'github' ? `/repos/${repo.path}` : `/repositories/${repo.path}`);

function errorText(data: unknown): string {
  if (typeof data === 'string')
    return data
      .replace(/<[^>]+>/g, ' ')
      .trim()
      .slice(0, 300);
  const d = (data ?? {}) as Record<string, unknown>;
  const nested = d.error as { message?: string } | string | undefined;
  const details = Array.isArray(d.errors)
    ? (d.errors as { message?: string; field?: string }[])
        .map((e) => e.message ?? e.field)
        .filter(Boolean)
        .join('; ')
    : '';
  const message =
    (typeof d.message === 'string' ? d.message : Array.isArray(d.message) ? d.message.join('; ') : '') ||
    (typeof nested === 'string' ? nested : (nested?.message ?? ''));
  return [message, details].filter(Boolean).join(': ') || 'Request failed.';
}

async function call<T>(repo: HostedRepo, method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
  const response = await desktopApi().hosting.request({ kind: repo.kind, host: repo.host, method, path, body });
  if (response.status >= 400) {
    const hint =
      response.status === 401
        ? ' Check the access token.'
        : response.status === 403 || response.status === 404
          ? ' The token may be missing or lack access to this repository.'
          : '';
    throw new HostError(`${repo.host} (${response.status}): ${errorText(response.data)}${hint}`, response.status);
  }
  return response.data as T;
}

const decode64 = (text: string) => {
  const bytes = Uint8Array.from(atob(text.replace(/\s/g, '')), (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
};

export async function defaultBranch(repo: HostedRepo): Promise<string | null> {
  if (repo.kind === 'github')
    return (await call<{ default_branch?: string }>(repo, 'GET', repoPath(repo))).default_branch ?? null;
  if (repo.kind === 'gitlab')
    return (await call<{ default_branch?: string }>(repo, 'GET', project(repo))).default_branch ?? null;
  return (await call<{ mainbranch?: { name?: string } }>(repo, 'GET', repoPath(repo))).mainbranch?.name ?? null;
}

/** Single-file templates each provider reads from the repository, checked in the working tree. */
const LOCAL_TEMPLATES: Record<HostKind, string[]> = {
  github: [
    '.github/pull_request_template.md',
    '.github/PULL_REQUEST_TEMPLATE.md',
    'pull_request_template.md',
    'PULL_REQUEST_TEMPLATE.md',
    'docs/pull_request_template.md',
    'docs/PULL_REQUEST_TEMPLATE.md',
  ],
  gitlab: ['.gitlab/merge_request_templates/Default.md', '.gitlab/merge_request_templates/default.md'],
  bitbucket: [
    'PULL_REQUEST_TEMPLATE.md',
    'pull_request_template.md',
    '.bitbucket/pull_request_template.md',
    '.bitbucket/PULL_REQUEST_TEMPLATE.md',
    '.github/pull_request_template.md',
  ],
};

/**
 * Templates from the project: the provider's template folder on the target branch (GitHub/GitLab API)
 * plus the single-file templates in the local working tree. Failures just mean fewer templates.
 */
export async function templates(repo: HostedRepo, cwd: string, base: string): Promise<Template[]> {
  const found: Template[] = [];
  const add = (template: Template) => {
    if (template.body.trim() && !found.some((t) => t.name === template.name)) found.push(template);
  };
  const remote = async () => {
    if (repo.kind === 'github') {
      const list = await call<{ name: string; path: string; type: string }[]>(
        repo,
        'GET',
        `${repoPath(repo)}/contents/.github/PULL_REQUEST_TEMPLATE?ref=${enc(base)}`,
      ).catch(() => []);
      for (const file of Array.isArray(list) ? list : []) {
        if (file.type !== 'file' || !/\.(md|markdown|txt)$/i.test(file.name)) continue;
        const content = await call<{ content?: string }>(
          repo,
          'GET',
          `${repoPath(repo)}/contents/${file.path.split('/').map(enc).join('/')}?ref=${enc(base)}`,
        ).catch(() => null);
        if (content?.content)
          add({ name: file.name.replace(/\.\w+$/, ''), body: decode64(content.content), source: 'project' });
      }
    } else if (repo.kind === 'gitlab') {
      const list = await call<{ key?: string; name: string }[]>(
        repo,
        'GET',
        `${project(repo)}/templates/merge_requests`,
      ).catch(() => []);
      for (const item of Array.isArray(list) ? list : []) {
        const name = item.key ?? item.name;
        const content = await call<{ content?: string }>(
          repo,
          'GET',
          `${project(repo)}/templates/merge_requests/${enc(name)}`,
        ).catch(() => null);
        if (content?.content) add({ name: item.name, body: content.content, source: 'project' });
      }
    }
  };
  const local = async () => {
    for (const path of LOCAL_TEMPLATES[repo.kind]) {
      const body = await desktopApi()
        .readWorkFile(cwd, path)
        .catch(() => null);
      if (typeof body === 'string')
        add({
          name: path
            .split('/')
            .pop()!
            .replace(/\.\w+$/, ''),
          body,
          source: 'local',
        });
    }
  };
  await Promise.all([remote(), local()]);
  // a single "Default" template comes first so it can be applied automatically
  return found.sort((a, b) => Number(/default/i.test(b.name)) - Number(/default/i.test(a.name)));
}

/** Recently merged requests with a description, as style examples for AI. */
export async function pastRequests(repo: HostedRepo, limit = 5): Promise<PastRequest[]> {
  let items: PastRequest[];
  if (repo.kind === 'github') {
    const list = await call<{ title: string; body: string | null; merged_at: string | null }[]>(
      repo,
      'GET',
      `${repoPath(repo)}/pulls?state=closed&sort=updated&direction=desc&per_page=30`,
    );
    items = list.filter((p) => p.merged_at).map((p) => ({ title: p.title, body: p.body ?? '' }));
  } else if (repo.kind === 'gitlab') {
    const list = await call<{ title: string; description: string | null }[]>(
      repo,
      'GET',
      `${project(repo)}/merge_requests?state=merged&order_by=updated_at&per_page=20`,
    );
    items = list.map((m) => ({ title: m.title, body: m.description ?? '' }));
  } else {
    const list = await call<{ values?: { title: string; description?: string; summary?: { raw?: string } }[] }>(
      repo,
      'GET',
      `${repoPath(repo)}/pullrequests?state=MERGED&pagelen=20`,
    );
    items = (list.values ?? []).map((p) => ({ title: p.title, body: p.summary?.raw ?? p.description ?? '' }));
  }
  return items.filter((p) => p.body.trim().length > 20).slice(0, limit);
}

/** Commits and changes on `head` that are not on `base`, from the host (the branch must be pushed). */
export async function compare(repo: HostedRepo, base: string, head: string): Promise<Comparison> {
  if (repo.kind === 'github') {
    const data = await call<{
      commits: { commit: { message: string } }[];
      files?: { filename: string; status: string; additions: number; deletions: number; patch?: string }[];
    }>(repo, 'GET', `${repoPath(repo)}/compare/${enc(base)}...${enc(head)}`);
    return {
      commits: data.commits.map((c) => c.commit.message),
      files: (data.files ?? []).map((f) => ({
        path: f.filename,
        status: f.status,
        additions: f.additions,
        deletions: f.deletions,
        patch: f.patch,
      })),
    };
  }
  if (repo.kind === 'gitlab') {
    const data = await call<{
      commits: { message: string }[];
      diffs: { new_path: string; new_file: boolean; deleted_file: boolean; renamed_file: boolean; diff: string }[];
    }>(repo, 'GET', `${project(repo)}/repository/compare?from=${enc(base)}&to=${enc(head)}&straight=false`);
    return {
      commits: data.commits.map((c) => c.message),
      files: data.diffs.map((d) => ({
        path: d.new_path,
        status: d.new_file ? 'added' : d.deleted_file ? 'removed' : d.renamed_file ? 'renamed' : 'modified',
        patch: d.diff,
      })),
    };
  }
  const [commits, diff] = await Promise.all([
    call<{ values?: { message: string }[] }>(
      repo,
      'GET',
      `${repoPath(repo)}/commits/${enc(head)}?exclude=${enc(base)}&pagelen=50`,
    ),
    call<string>(repo, 'GET', `${repoPath(repo)}/diff/${enc(head)}..${enc(base)}`),
  ]);
  return {
    commits: (commits.values ?? []).map((c) => c.message),
    files: [],
    diff: typeof diff === 'string' ? diff : '',
  };
}

/** Open request already proposed from `head` into `base`, if any. */
export async function existingRequest(repo: HostedRepo, base: string, head: string): Promise<string | null> {
  if (repo.kind === 'github') {
    const owner = repo.path.split('/')[0];
    const list = await call<{ html_url: string }[]>(
      repo,
      'GET',
      `${repoPath(repo)}/pulls?state=open&head=${enc(`${owner}:${head}`)}&base=${enc(base)}`,
    );
    return list[0]?.html_url ?? null;
  }
  if (repo.kind === 'gitlab') {
    const list = await call<{ web_url: string }[]>(
      repo,
      'GET',
      `${project(repo)}/merge_requests?state=opened&source_branch=${enc(head)}&target_branch=${enc(base)}`,
    );
    return list[0]?.web_url ?? null;
  }
  const query = enc(`source.branch.name="${head}" AND destination.branch.name="${base}" AND state="OPEN"`);
  const list = await call<{ values?: { links?: { html?: { href?: string } } }[] }>(
    repo,
    'GET',
    `${repoPath(repo)}/pullrequests?q=${query}`,
  );
  return list.values?.[0]?.links?.html?.href ?? null;
}

/** Create the request; returns its web URL. */
export async function createRequest(repo: HostedRepo, request: NewRequest): Promise<string> {
  if (repo.kind === 'github') {
    const data = await call<{ html_url: string }>(repo, 'POST', `${repoPath(repo)}/pulls`, {
      title: request.title,
      head: request.head,
      base: request.base,
      body: request.body,
      draft: request.draft,
    });
    return data.html_url;
  }
  if (repo.kind === 'gitlab') {
    const data = await call<{ web_url: string }>(repo, 'POST', `${project(repo)}/merge_requests`, {
      source_branch: request.head,
      target_branch: request.base,
      title: request.draft && !/^draft:/i.test(request.title) ? `Draft: ${request.title}` : request.title,
      description: request.body,
    });
    return data.web_url;
  }
  const data = await call<{ links: { html: { href: string } } }>(repo, 'POST', `${repoPath(repo)}/pullrequests`, {
    title: request.title,
    description: request.body,
    source: { branch: { name: request.head } },
    destination: { branch: { name: request.base } },
    draft: request.draft,
  });
  return data.links.html.href;
}

const MAX_PROMPT = 120_000;

/** Material for the AI: template, past examples, commits and the diff, trimmed to fit. */
export function aiPrompt(input: {
  kind: HostKind;
  base: string;
  head: string;
  template: string;
  examples: PastRequest[];
  comparison: Comparison;
  notes: string;
}): string {
  const noun = REQUEST_NOUN[input.kind].toLowerCase();
  const parts: string[] = [`Write a ${noun} that merges \`${input.head}\` into \`${input.base}\`.`];
  if (input.notes.trim()) parts.push(`Notes from the author (what they already typed):\n${input.notes.trim()}`);
  parts.push(
    input.template.trim()
      ? `Template to fill in (keep its headings and structure):\n<template>\n${input.template}\n</template>`
      : 'The project has no template: use a short summary followed by a bulleted list of changes.',
  );
  if (input.examples.length)
    parts.push(
      `Earlier ${noun}s in this project, as examples of how the team writes them:\n` +
        input.examples
          .map((e, i) => `<example ${i + 1}>\nTitle: ${e.title}\n\n${e.body.slice(0, 4000)}\n</example ${i + 1}>`)
          .join('\n'),
    );
  parts.push(`Commits:\n${input.comparison.commits.map((c) => `- ${c.split('\n')[0]}`).join('\n') || '(none)'}`);
  const summary = input.comparison.files
    .map((f) => `${f.status} ${f.path}${f.additions !== undefined ? ` (+${f.additions} -${f.deletions})` : ''}`)
    .join('\n');
  if (summary) parts.push(`Changed files:\n${summary}`);
  const head = parts.join('\n\n');
  let budget = MAX_PROMPT - head.length - 200;
  const diffs: string[] = [];
  const all = input.comparison.diff
    ? [input.comparison.diff]
    : input.comparison.files.filter((f) => f.patch).map((f) => `--- ${f.path}\n${f.patch}`);
  for (const d of all) {
    if (budget <= 0) break;
    const piece = d.length > budget ? `${d.slice(0, budget)}\n… (truncated)` : d;
    diffs.push(piece);
    budget -= piece.length;
  }
  return `${head}\n\nDiff:\n<diff>\n${diffs.join('\n') || '(not available)'}\n</diff>`;
}

/** First line is the title, the rest is the description; strips a wrapping code fence. */
export function parseAiResult(text: string): { title: string; body: string } {
  const clean = text
    .trim()
    .replace(/^```(?:[\w-]+)?\s*\n/, '')
    .replace(/\n```\s*$/, '')
    .trim();
  const [first, ...rest] = clean.split(/\r?\n/);
  return {
    title: (first ?? '')
      .replace(/^#+\s*/, '')
      .replace(/^title:\s*/i, '')
      .trim(),
    body: rest.join('\n').trim(),
  };
}

export interface OpenRequest {
  id: string;
  number: number;
  title: string;
  author: string;
  url: string;
  head: string;
  base: string;
  draft: boolean;
  updated: string;
  mine: boolean;
  assigned: boolean;
  reviewRequested: boolean;
}

type Person = { login?: string; username?: string; uuid?: string; display_name?: string; name?: string };
const who = (p: Person | null | undefined) => p?.login ?? p?.username ?? p?.display_name ?? p?.name ?? '';
const same = (p: Person | null | undefined, me: Person | null) =>
  !!me && !!p && (p.uuid && me.uuid ? p.uuid === me.uuid : !!who(p) && who(p) === who(me));

/** Signed-in account for "mine / assigned / review" grouping; null without a token. */
async function me(repo: HostedRepo): Promise<Person | null> {
  return call<Person>(repo, 'GET', '/user').catch(() => null);
}

/** Open pull/merge requests of the repository, newest activity first (first 50). */
export async function openRequests(repo: HostedRepo): Promise<OpenRequest[]> {
  const user = await me(repo);
  if (repo.kind === 'github') {
    const list = await call<
      {
        id: number;
        number: number;
        title: string;
        user: Person;
        html_url: string;
        head: { ref: string };
        base: { ref: string };
        draft?: boolean;
        updated_at: string;
        assignees?: Person[];
        requested_reviewers?: Person[];
      }[]
    >(repo, 'GET', `${repoPath(repo)}/pulls?state=open&sort=updated&direction=desc&per_page=50`);
    return list.map((p) => ({
      id: String(p.id),
      number: p.number,
      title: p.title,
      author: who(p.user),
      url: p.html_url,
      head: p.head.ref,
      base: p.base.ref,
      draft: !!p.draft,
      updated: p.updated_at,
      mine: same(p.user, user),
      assigned: (p.assignees ?? []).some((a) => same(a, user)),
      reviewRequested: (p.requested_reviewers ?? []).some((r) => same(r, user)),
    }));
  }
  if (repo.kind === 'gitlab') {
    const list = await call<
      {
        id: number;
        iid: number;
        title: string;
        author: Person;
        web_url: string;
        source_branch: string;
        target_branch: string;
        draft?: boolean;
        work_in_progress?: boolean;
        updated_at: string;
        assignees?: Person[];
        reviewers?: Person[];
      }[]
    >(repo, 'GET', `${project(repo)}/merge_requests?state=opened&order_by=updated_at&per_page=50`);
    return list.map((m) => ({
      id: String(m.id),
      number: m.iid,
      title: m.title,
      author: who(m.author),
      url: m.web_url,
      head: m.source_branch,
      base: m.target_branch,
      draft: !!(m.draft ?? m.work_in_progress),
      updated: m.updated_at,
      mine: same(m.author, user),
      assigned: (m.assignees ?? []).some((a) => same(a, user)),
      reviewRequested: (m.reviewers ?? []).some((r) => same(r, user)),
    }));
  }
  const list = await call<{
    values?: {
      id: number;
      title: string;
      author: Person;
      links: { html: { href: string } };
      source: { branch: { name: string } };
      destination: { branch: { name: string } };
      draft?: boolean;
      updated_on: string;
      reviewers?: Person[];
    }[];
  }>(repo, 'GET', `${repoPath(repo)}/pullrequests?state=OPEN&pagelen=50&fields=%2Bvalues.reviewers`);
  return (list.values ?? []).map((p) => ({
    id: String(p.id),
    number: p.id,
    title: p.title,
    author: who(p.author),
    url: p.links.html.href,
    head: p.source.branch.name,
    base: p.destination.branch.name,
    draft: !!p.draft,
    updated: p.updated_on,
    mine: same(p.author, user),
    assigned: false, // Bitbucket has no assignees
    reviewRequested: (p.reviewers ?? []).some((r) => same(r, user)),
  }));
}

/** Provider chosen by hand for a self-hosted server, remembered per host. */
export const savedKindKey = (host: string) => `hosting.kind.${host.toLowerCase()}`;
/** Fired after a request is created so lists refresh. */
export const REQUESTS_CHANGED = 'gitverse:pull-requests-changed';

/** Connect to the host using an entered token or credentials explicitly requested by the user. */
export function connectHost(repo: HostedRepo, token?: string) {
  return desktopApi().hosting.connect(repo.kind, repo.host, { token });
}

/** A readable title from a branch name: `feature/ABC-123-add-login` → `ABC-123 Add login`. */
export function titleFromBranch(branch: string): string {
  const leaf = branch.split('/').pop() ?? branch;
  const ticket = /([A-Za-z][A-Za-z0-9]+-\d+)/.exec(leaf)?.[1];
  const words = leaf
    .replace(ticket ?? '', '')
    .replace(/[-_.]+/g, ' ')
    .trim();
  const sentence = words ? words[0].toUpperCase() + words.slice(1) : '';
  return [ticket?.toUpperCase(), sentence].filter(Boolean).join(' ');
}

/** Markdown bullet list of commit subjects (merge commits left out). */
export function commitList(commits: string[]): string {
  return commits
    .map((c) => c.split('\n')[0].trim())
    .filter((s) => s && !/^Merge (branch|remote-tracking|pull request)/i.test(s))
    .map((s) => `- ${s}`)
    .join('\n');
}

// ---- issues (GitHub / GitLab) ----

export interface OpenIssue {
  id: string;
  number: number;
  title: string;
  author: string;
  url: string;
  labels: string[];
  updated: string;
  assignedToMe: boolean;
  mine: boolean;
}

/** Open issues of the repository, newest activity first (first 50). Bitbucket is not supported. */
export async function openIssues(repo: HostedRepo): Promise<OpenIssue[]> {
  const user = await me(repo);
  if (repo.kind === 'github') {
    const list = await call<
      {
        id: number;
        number: number;
        title: string;
        user: Person;
        html_url: string;
        labels: ({ name: string } | string)[];
        updated_at: string;
        assignees?: Person[];
        pull_request?: unknown;
      }[]
    >(repo, 'GET', `${repoPath(repo)}/issues?state=open&sort=updated&direction=desc&per_page=50`);
    return list
      .filter((i) => !i.pull_request) // the issues API also lists pull requests
      .map((i) => ({
        id: String(i.id),
        number: i.number,
        title: i.title,
        author: who(i.user),
        url: i.html_url,
        labels: i.labels.map((l) => (typeof l === 'string' ? l : l.name)),
        updated: i.updated_at,
        assignedToMe: (i.assignees ?? []).some((a) => same(a, user)),
        mine: same(i.user, user),
      }));
  }
  if (repo.kind === 'gitlab') {
    const list = await call<
      {
        id: number;
        iid: number;
        title: string;
        author: Person;
        web_url: string;
        labels: string[];
        updated_at: string;
        assignees?: Person[];
      }[]
    >(repo, 'GET', `${project(repo)}/issues?state=opened&order_by=updated_at&per_page=50`);
    return list.map((i) => ({
      id: String(i.id),
      number: i.iid,
      title: i.title,
      author: who(i.author),
      url: i.web_url,
      labels: i.labels ?? [],
      updated: i.updated_at,
      assignedToMe: (i.assignees ?? []).some((a) => same(a, user)),
      mine: same(i.author, user),
    }));
  }
  throw new HostError('Issues are available for GitHub and GitLab repositories.', 400);
}

/** Branch name for working on an issue: `feature/123-fix-login-crash`. */
export function issueBranchName(issue: { number: number; title: string }, prefix = 'feature/'): string {
  const slug = issue.title
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .split('-')
    .slice(0, 6)
    .join('-');
  return `${prefix}${issue.number}${slug ? `-${slug}` : ''}`;
}

/** Issue number a branch was made for (`feature/123-…`, `123-…`), if any. */
export function issueFromBranch(branch: string): number | null {
  const m = /(?:^|\/)(\d{1,7})(?:-|$)/.exec(branch);
  return m ? Number(m[1]) : null;
}

export const ISSUES_CHANGED = 'gitverse:issues-changed';
