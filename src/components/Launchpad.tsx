import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  CircleDot,
  ExternalLink,
  FilePen,
  FolderOpen,
  GitBranchPlus,
  GitPullRequest,
  GitPullRequestDraft,
  Loader2,
  RefreshCw,
  Rocket,
  Search,
  X,
} from 'lucide-react';
import { desktopApi } from '../platform/api';
import { useRepo } from '../store/repoStore';
import { loadLaunchpad, useLaunchpad, type RepoSummary } from '../lib/launchpad';
import { openRef } from '../lib/refActions';
import type { OpenIssue, OpenRequest } from '../lib/pullRequests';
import { branchForIssue } from './IssueList';

type Tab = 'attention' | 'requests' | 'issues' | 'wip';

function ago(iso: string) {
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 3600) return `${Math.max(1, Math.round(s / 60))}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

const requestReason = (r: OpenRequest) =>
  r.reviewRequested ? 'Review requested' : r.assigned ? 'Assigned to you' : r.mine ? 'Yours' : null;
const issueReason = (i: OpenIssue) => (i.assignedToMe ? 'Assigned to you' : i.mine ? 'Opened by you' : null);

/**
 * Launchpad: pull requests, issues and uncommitted work across every open repository, with the
 * items that are waiting on you first.
 */
export function Launchpad() {
  const open = useLaunchpad((s) => s.open);
  const close = useLaunchpad((s) => s.close);
  const repos = useRepo((s) => s.recentRepos);
  const [summaries, setSummaries] = useState<Map<string, RepoSummary>>(new Map());
  const [loading, setLoading] = useState(false);
  const [tab, setTab] = useState<Tab>('attention');
  const [query, setQuery] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    await loadLaunchpad(repos, (summary) => setSummaries((m) => new Map(m).set(summary.path, summary)));
    setLoading(false);
  }, [repos]);
  useEffect(() => {
    if (open) void load();
  }, [open, load]);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) =>
      e.key === 'Escape' && !document.querySelector('[role="dialog"][aria-modal]:not(#launchpad)') && close();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, close]);

  // clones of the same project would list the same requests twice: keep the first repository's copy
  const ordered = useMemo(() => {
    const seen = new Set<string>();
    return repos
      .map((p) => summaries.get(p))
      .filter((s): s is RepoSummary => !!s)
      .map((s) => {
        const key = s.hosted ? `${s.hosted.kind}:${s.hosted.host}/${s.hosted.path}` : s.path;
        const duplicate = seen.has(key);
        seen.add(key);
        return duplicate ? { ...s, requests: [], issues: [] } : s;
      });
  }, [repos, summaries]);

  const q = query.trim().toLowerCase();
  const match = (...values: (string | number)[]) => !q || values.some((v) => String(v).toLowerCase().includes(q));
  const view = ordered.map((s) => {
    const requests = s.requests.filter((r) => match(r.title, r.author, r.head, r.base, `#${r.number}`, s.name));
    const issues = s.issues.filter((i) => match(i.title, i.author, `#${i.number}`, ...i.labels, s.name));
    return {
      summary: s,
      requests: tab === 'attention' ? requests.filter((r) => r.reviewRequested || r.assigned) : requests,
      issues: tab === 'attention' ? issues.filter((i) => i.assignedToMe) : issues,
    };
  });
  const counts = {
    attention: ordered.reduce(
      (n, s) =>
        n +
        s.requests.filter((r) => r.reviewRequested || r.assigned).length +
        s.issues.filter((i) => i.assignedToMe).length,
      0,
    ),
    requests: ordered.reduce((n, s) => n + s.requests.length, 0),
    issues: ordered.reduce((n, s) => n + s.issues.length, 0),
    wip: ordered.filter((s) => s.changes > 0).length,
  };

  if (!open) return null;

  const openUrl = (s: RepoSummary, url: string) =>
    s.hosted &&
    void desktopApi()
      .hosting.open(s.hosted.kind, s.hosted.host, url)
      .catch(() => {});
  const goTo = async (s: RepoSummary, then?: () => Promise<void> | void) => {
    close();
    if (useRepo.getState().repoPath !== s.path) await useRepo.getState().openRepo(s.path);
    await then?.();
  };

  const visible = view.filter((v) =>
    tab === 'wip'
      ? v.summary.changes > 0 && match(v.summary.name, v.summary.branch ?? '')
      : tab === 'issues'
        ? v.issues.length
        : tab === 'requests'
          ? v.requests.length
          : v.requests.length || v.issues.length,
  );
  const problems = ordered.filter((s) => s.problem && s.hosted);

  return (
    <div className="fixed inset-0 z-[85] flex bg-black/40 p-4 sm:p-8" onMouseDown={close}>
      <section
        id="launchpad"
        role="dialog"
        aria-modal="true"
        aria-labelledby="launchpad-title"
        onMouseDown={(e) => e.stopPropagation()}
        className="mx-auto flex w-full max-w-[1100px] flex-col overflow-hidden rounded-xl border border-surface bg-mantle shadow-2xl"
      >
        <header className="flex flex-wrap items-center gap-3 border-b border-surface px-6 py-4">
          <Rocket size={20} className="text-accent" aria-hidden />
          <div className="mr-auto">
            <h2 id="launchpad-title" className="text-lg font-semibold">
              Launchpad
            </h2>
            <p className="text-sm text-sub">
              {repos.length} open repositor{repos.length === 1 ? 'y' : 'ies'}
              {loading ? ', loading…' : ''}
            </p>
          </div>
          <label className="relative">
            <Search size={14} className="absolute left-2.5 top-2.5 text-sub" aria-hidden />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Filter by title, branch, person…"
              aria-label="Filter Launchpad"
              className="w-64 rounded-md border border-surface bg-crust py-1.5 pl-8 pr-3 text-sm outline-none focus:border-accent"
            />
          </label>
          <button
            onClick={() => void load()}
            disabled={loading}
            aria-label="Refresh"
            title="Refresh"
            className="rounded-md p-2 text-sub hover:bg-surface hover:text-text"
          >
            <RefreshCw size={16} className={loading ? 'animate-spin motion-reduce:animate-none' : ''} />
          </button>
          <button onClick={close} aria-label="Close Launchpad" className="rounded-md p-2 hover:bg-surface">
            <X size={17} />
          </button>
        </header>

        <nav className="flex gap-1 border-b border-surface px-4" role="tablist" aria-label="Launchpad views">
          {(
            [
              ['attention', 'Needs you'],
              ['requests', 'Pull requests'],
              ['issues', 'Issues'],
              ['wip', 'Work in progress'],
            ] as const
          ).map(([id, label]) => (
            <button
              key={id}
              role="tab"
              aria-selected={tab === id}
              onClick={() => setTab(id)}
              className={`flex items-center gap-2 border-b-2 px-3 py-2.5 text-sm transition-colors ${tab === id ? 'border-accent text-text' : 'border-transparent text-sub hover:text-text'}`}
            >
              {label}
              <span
                className={`rounded-full px-1.5 text-xs tabular-nums ${tab === id ? 'bg-accent/20 text-accent' : 'bg-surface text-sub'}`}
              >
                {counts[id]}
              </span>
            </button>
          ))}
        </nav>

        <div className="min-h-0 flex-1 overflow-y-auto px-6 py-4">
          {!ordered.length && loading && (
            <p className="flex items-center gap-2 text-sm text-sub">
              <Loader2 size={15} className="animate-spin" aria-hidden /> Loading repositories…
            </p>
          )}
          {ordered.length > 0 && !visible.length && (
            <p className="py-10 text-center text-sm text-sub">
              {tab === 'attention'
                ? 'Nothing is waiting on you. Reviews requested from you and items assigned to you show up here.'
                : tab === 'wip'
                  ? 'No uncommitted changes in your open repositories.'
                  : q
                    ? 'Nothing matches the filter.'
                    : `No open ${tab === 'issues' ? 'issues' : 'pull requests'} in your open repositories.`}
            </p>
          )}

          {visible.map(({ summary: s, requests, issues }) => (
            <section key={s.path} className="fade-in mb-6" aria-label={s.name}>
              <div className="mb-1.5 flex items-baseline gap-3 border-b border-surface/60 pb-1.5">
                <h3 className="font-semibold">{s.name}</h3>
                {s.branch && <span className="truncate text-sm text-sub">on {s.branch}</span>}
                {s.hosted && <span className="hidden truncate text-xs text-sub md:inline">{s.hosted.path}</span>}
                <button
                  onClick={() => void goTo(s)}
                  className="ml-auto flex shrink-0 items-center gap-1.5 rounded px-2 py-0.5 text-xs text-accent hover:bg-accent/10"
                >
                  <FolderOpen size={13} aria-hidden /> Open repository
                </button>
              </div>

              {tab === 'wip' && (
                <div className="flex items-center gap-3 py-2 text-sm">
                  <FilePen size={15} className="text-[#fab387]" aria-hidden />
                  <span className="flex-1">
                    {s.changes} uncommitted change{s.changes === 1 ? '' : 's'}
                    {s.branch ? ` on ${s.branch}` : ''}
                  </span>
                  <button onClick={() => void goTo(s)} className="btn-secondary px-3 py-1 text-xs">
                    Review changes
                  </button>
                </div>
              )}

              {tab !== 'wip' &&
                tab !== 'issues' &&
                requests.map((r) => {
                  const reason = requestReason(r);
                  const Icon = r.draft ? GitPullRequestDraft : GitPullRequest;
                  return (
                    <div
                      key={`r${r.id}`}
                      className="group flex items-center gap-3 rounded-md px-2 py-2 hover:bg-surface/40"
                    >
                      <Icon size={16} className={`shrink-0 ${r.draft ? 'text-sub' : 'text-success'}`} aria-hidden />
                      <button
                        onClick={() => openUrl(s, r.url)}
                        className="min-w-0 flex-1 text-left"
                        title="Open in browser"
                      >
                        <span className="block truncate text-sm">{r.title}</span>
                        <span className="block truncate text-xs text-sub">
                          #{r.number} {r.head} → {r.base}, by {r.author}, {ago(r.updated)}
                        </span>
                      </button>
                      {reason && (
                        <span
                          className={`shrink-0 rounded-full px-2 py-0.5 text-xs ${reason === 'Yours' ? 'bg-surface text-sub' : 'bg-warning/15 text-warning'}`}
                        >
                          {reason}
                        </span>
                      )}
                      <span className="flex shrink-0 gap-1 opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100">
                        <button
                          onClick={() => void goTo(s, () => openRef('remote', `origin/${r.head}`))}
                          title={`Check out ${r.head}`}
                          className="rounded px-2 py-1 text-xs text-accent hover:bg-accent/10"
                        >
                          Check out
                        </button>
                        <button
                          onClick={() => openUrl(s, r.url)}
                          aria-label="Open in browser"
                          className="rounded p-1 text-sub hover:bg-surface hover:text-text"
                        >
                          <ExternalLink size={14} />
                        </button>
                      </span>
                    </div>
                  );
                })}

              {tab !== 'wip' &&
                tab !== 'requests' &&
                issues.map((i) => {
                  const reason = issueReason(i);
                  return (
                    <div
                      key={`i${i.id}`}
                      className="group flex items-center gap-3 rounded-md px-2 py-2 hover:bg-surface/40"
                    >
                      <CircleDot size={16} className="shrink-0 text-success" aria-hidden />
                      <button
                        onClick={() => openUrl(s, i.url)}
                        className="min-w-0 flex-1 text-left"
                        title="Open in browser"
                      >
                        <span className="block truncate text-sm">{i.title}</span>
                        <span className="block truncate text-xs text-sub">
                          #{i.number}
                          {i.labels.length ? `, ${i.labels.slice(0, 3).join(', ')}` : ''}, by {i.author},{' '}
                          {ago(i.updated)}
                        </span>
                      </button>
                      {reason && (
                        <span
                          className={`shrink-0 rounded-full px-2 py-0.5 text-xs ${i.assignedToMe ? 'bg-warning/15 text-warning' : 'bg-surface text-sub'}`}
                        >
                          {reason}
                        </span>
                      )}
                      <span className="flex shrink-0 gap-1 opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100">
                        <button
                          onClick={() => void goTo(s, () => branchForIssue(s.path, i))}
                          title="Create a branch for this issue"
                          className="flex items-center gap-1 rounded px-2 py-1 text-xs text-accent hover:bg-accent/10"
                        >
                          <GitBranchPlus size={13} aria-hidden /> Branch
                        </button>
                        <button
                          onClick={() => openUrl(s, i.url)}
                          aria-label="Open in browser"
                          className="rounded p-1 text-sub hover:bg-surface hover:text-text"
                        >
                          <ExternalLink size={14} />
                        </button>
                      </span>
                    </div>
                  );
                })}
            </section>
          ))}

          {problems.length > 0 && tab !== 'wip' && (
            <div className="mt-2 border-t border-surface pt-3 text-xs text-sub">
              <p className="mb-1">Not shown from:</p>
              <ul className="space-y-0.5">
                {problems.map((s) => (
                  <li key={s.path} className="truncate" title={s.problem}>
                    {s.name}:{' '}
                    {s.needsToken
                      ? `not connected to ${s.hosted!.host}. Open it and use PR / MR to connect.`
                      : s.problem}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      </section>
    </div>
  );
}
