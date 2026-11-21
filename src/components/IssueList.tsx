import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { CircleDot, RefreshCw } from 'lucide-react';
import { desktopApi } from '../platform/api';
import type { HostedRepo } from '../shared/pullRequests';
import { HostError, ISSUES_CHANGED, issueBranchName, openIssues, type OpenIssue } from '../lib/pullRequests';
import { useRepo } from '../store/repoStore';
import { flowFor } from '../store/settingsStore';
import { hostedFor } from './PullRequestList';
import { askText } from './Dialogs';
import { Chevron, Collapse } from './Motion';
import { ContextMenu } from './ContextMenu';

const AUTO_REFRESH_MS = 2 * 60_000;
type State =
  | { kind: 'loading' }
  | { kind: 'none'; message: string }
  | { kind: 'error'; message: string; needsToken: boolean }
  | { kind: 'ready'; items: OpenIssue[] };

const GROUPS: { id: string; label: string; match: (i: OpenIssue) => boolean }[] = [
  { id: 'assigned', label: 'Assigned to me', match: (i) => i.assignedToMe },
  { id: 'mine', label: 'Created by me', match: (i) => i.mine },
  { id: 'all', label: 'All open', match: () => true },
];

function ago(iso: string) {
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 3600) return `${Math.max(1, Math.round(s / 60))}m`;
  if (s < 86400) return `${Math.round(s / 3600)}h`;
  return `${Math.round(s / 86400)}d`;
}

/** Create and check out a branch for an issue, named from its number and title. */
export async function branchForIssue(repoPath: string, issue: OpenIssue) {
  const name = await askText(
    `Branch for #${issue.number}`,
    'Branch name',
    issueBranchName(issue, flowFor(repoPath).feature || 'feature/'),
  );
  if (name?.trim()) await useRepo.getState().createBranch(name.trim());
}

/** Open issues for the sidebar (GitHub / GitLab). Reports its count through `onCount`. */
export function IssueList({
  repoPath,
  query,
  onCount,
  onConnect,
}: {
  repoPath: string;
  query: string;
  onCount: (count: number) => void;
  onConnect: () => void;
}) {
  const [hosted, setHosted] = useState<HostedRepo | null>(null);
  const [state, setState] = useState<State>({ kind: 'loading' });
  const [closed, setClosed] = useState<Set<string>>(new Set(['mine']));
  const [menu, setMenu] = useState<{ issue: OpenIssue; x: number; y: number } | null>(null);
  const loading = useRef(false);

  const load = useCallback(
    async (background = false) => {
      if (loading.current) return;
      loading.current = true;
      if (!background) setState((s) => (s.kind === 'ready' ? s : { kind: 'loading' }));
      try {
        const repo = await hostedFor(repoPath).catch(() => null);
        setHosted(repo);
        if (!repo) return setState({ kind: 'none', message: 'No GitHub or GitLab origin remote.' });
        if (repo.kind === 'bitbucket')
          return setState({ kind: 'none', message: 'Issues are shown for GitHub and GitLab repositories.' });
        setState({ kind: 'ready', items: await openIssues(repo) });
      } catch (e) {
        const failed: State = {
          kind: 'error',
          message: String((e as Error)?.message ?? e),
          needsToken: e instanceof HostError && e.needsToken,
        };
        setState((s) => (background && s.kind === 'ready' ? s : failed));
      } finally {
        loading.current = false;
      }
    },
    [repoPath],
  );

  useEffect(() => {
    setState({ kind: 'loading' });
    void load();
    const reload = () => void load();
    const tick = () => document.visibilityState === 'visible' && void load(true);
    const timer = setInterval(tick, AUTO_REFRESH_MS);
    // a token added in the PR dialog also unlocks issues
    window.addEventListener(ISSUES_CHANGED, reload);
    window.addEventListener('gitverse:pull-requests-changed', reload);
    return () => {
      clearInterval(timer);
      window.removeEventListener(ISSUES_CHANGED, reload);
      window.removeEventListener('gitverse:pull-requests-changed', reload);
    };
  }, [load]);

  const items = useMemo(() => {
    if (state.kind !== 'ready') return [];
    const q = query.trim().toLowerCase();
    if (!q) return state.items;
    return state.items.filter((i) =>
      [i.title, i.author, `#${i.number}`, ...i.labels].some((v) => v.toLowerCase().includes(q)),
    );
  }, [state, query]);
  useEffect(() => onCount(state.kind === 'ready' ? state.items.length : 0), [state, onCount]);

  const open = (url: string) => {
    if (hosted)
      void desktopApi()
        .hosting.open(hosted.kind, hosted.host, url)
        .catch(() => {});
  };
  const copy = (text: string, what: string) =>
    void navigator.clipboard.writeText(text).then(() => useRepo.getState().toast(`${what} copied`));

  return (
    <div>
      <div className="flex items-center gap-1 px-4 pb-1">
        <span className="flex-1 truncate text-xs text-sub">{hosted?.path ?? ''}</span>
        <button
          type="button"
          onClick={() => void load()}
          aria-label="Refresh issues"
          title="Refresh"
          className="rounded p-1 text-sub hover:bg-surface hover:text-text"
        >
          <RefreshCw size={14} className={state.kind === 'loading' ? 'animate-spin motion-reduce:animate-none' : ''} />
        </button>
      </div>
      {state.kind === 'loading' && <p className="px-10 py-1 text-xs text-sub">Loading…</p>}
      {state.kind === 'none' && <p className="px-10 py-1 text-xs text-sub">{state.message}</p>}
      {state.kind === 'error' && (
        <div className="px-4 py-1 text-xs">
          <p className="break-words text-danger" title={state.message}>
            {state.needsToken
              ? `Not connected to ${hosted?.host ?? 'the server'}, or the token cannot see this repository.`
              : state.message}
          </p>
          {state.needsToken && (
            <button onClick={onConnect} className="mt-1 text-accent hover:underline">
              Connect
            </button>
          )}
        </div>
      )}
      {state.kind === 'ready' &&
        GROUPS.map((group) => {
          const list = items.filter(group.match);
          const isOpen = !closed.has(group.id);
          return (
            <div key={group.id}>
              <button
                type="button"
                aria-expanded={isOpen}
                onClick={() =>
                  setClosed((s) => {
                    const n = new Set(s);
                    n.has(group.id) ? n.delete(group.id) : n.add(group.id);
                    return n;
                  })
                }
                className="flex min-h-[30px] w-full items-center gap-1.5 pl-8 pr-4 text-left text-sm hover:bg-surface/50"
              >
                <Chevron open={isOpen} className="text-sub" />
                <span className="flex-1">{group.label}</span>
                <span className="text-xs tabular-nums text-sub">{list.length}</span>
              </button>
              <Collapse open={isOpen}>
                {list.length === 0 && <p className="py-1 pl-14 text-xs text-sub">None</p>}
                {list.map((issue) => (
                  <button
                    key={`${group.id}:${issue.id}`}
                    type="button"
                    onClick={(e) => e.detail <= 1 && open(issue.url)}
                    onDoubleClick={() => void branchForIssue(repoPath, issue)}
                    onContextMenu={(e) => {
                      e.preventDefault();
                      setMenu({ issue, x: e.clientX, y: e.clientY });
                    }}
                    title={`${issue.title}\nClick to open · double-click to create a branch for it`}
                    className="flex w-full items-start gap-2 py-1.5 pl-12 pr-4 text-left hover:bg-surface/50"
                  >
                    <CircleDot size={14} className="mt-0.5 shrink-0 text-success" aria-hidden />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm">{issue.title}</span>
                      <span className="block truncate text-2xs text-sub">
                        #{issue.number}
                        {issue.labels.length ? `, ${issue.labels.slice(0, 3).join(', ')}` : ''}, {ago(issue.updated)}
                      </span>
                    </span>
                  </button>
                ))}
              </Collapse>
            </div>
          );
        })}
      {menu && (
        <ContextMenu
          label={`Actions for issue #${menu.issue.number}`}
          x={menu.x}
          y={menu.y}
          width={280}
          onClose={() => setMenu(null)}
          items={[
            { label: 'Create branch for this issue…', run: () => void branchForIssue(repoPath, menu.issue) },
            { label: 'Open in browser', run: () => open(menu.issue.url) },
            '-',
            {
              label: 'Copy',
              sub: [
                { label: 'Link', run: () => copy(menu.issue.url, 'Link') },
                { label: `Reference (#${menu.issue.number})`, run: () => copy(`#${menu.issue.number}`, 'Reference') },
                { label: 'Title', run: () => copy(menu.issue.title, 'Title') },
              ],
            },
          ]}
        />
      )}
    </div>
  );
}
