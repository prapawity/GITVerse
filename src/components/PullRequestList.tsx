import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { GitPullRequest, GitPullRequestDraft, KeyRound, Plus, RefreshCw } from 'lucide-react';
import { desktopApi } from '../platform/api';
import {
  detectHostedRepo,
  HOST_KINDS,
  remoteHost,
  REQUEST_NOUN,
  type HostedRepo,
  type HostKind,
} from '../shared/pullRequests';
import { CiBadge } from './CiBadge';
import { HostError, openRequests, REQUESTS_CHANGED, savedKindKey, type OpenRequest } from '../lib/pullRequests';
import { locateRef, openRef } from '../lib/refActions';
import { useRepo } from '../store/repoStore';
import { ContextMenu } from './ContextMenu';
import { Chevron, Collapse } from './Motion';

const AUTO_REFRESH_MS = 2 * 60_000;
const FOCUS_REFRESH_MS = 30_000;

type State =
  | { kind: 'loading' }
  | { kind: 'none'; message: string }
  | { kind: 'error'; message: string; needsToken: boolean }
  | { kind: 'ready'; items: OpenRequest[] };

const GROUPS: { id: string; label: string; match: (r: OpenRequest) => boolean }[] = [
  { id: 'mine', label: 'Mine', match: (r) => r.mine },
  { id: 'review', label: 'Review requested', match: (r) => r.reviewRequested },
  { id: 'assigned', label: 'Assigned to me', match: (r) => r.assigned },
  { id: 'all', label: 'All open', match: () => true },
];

function ago(iso: string) {
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 3600) return `${Math.max(1, Math.round(s / 60))}m`;
  if (s < 86400) return `${Math.round(s / 3600)}h`;
  return `${Math.round(s / 86400)}d`;
}

/** Find the hosted repository for `cwd` (origin remote, or the provider saved for its host). */
export async function hostedFor(cwd: string): Promise<HostedRepo | null> {
  const url: string = await desktopApi().remoteUrl(cwd);
  const host = remoteHost(url);
  const saved = host ? desktopApi().stateStorage.getItem(savedKindKey(host)) : null;
  return detectHostedRepo(url, saved && (HOST_KINDS as string[]).includes(saved) ? (saved as HostKind) : null);
}

/** Open pull/merge requests for the sidebar. Reports its count through `onCount`. */
export function PullRequestList({
  repoPath,
  query,
  onCount,
  onCreate,
}: {
  repoPath: string;
  query: string;
  onCount: (count: number) => void;
  onCreate: () => void;
}) {
  const [hosted, setHosted] = useState<HostedRepo | null>(null);
  const [state, setState] = useState<State>({ kind: 'loading' });
  const [closed, setClosed] = useState<Set<string>>(new Set());
  const [menu, setMenu] = useState<{ request: OpenRequest; x: number; y: number } | null>(null);
  const copy = (text: string, what: string) =>
    void navigator.clipboard.writeText(text).then(() => useRepo.getState().toast(`${what} copied`));

  const loading = useRef(false);
  const lastLoad = useRef(0);
  /** `background`: an automatic refresh; a failure keeps the list already shown */
  const load = useCallback(
    async (background = false) => {
      if (loading.current) return;
      loading.current = true;
      lastLoad.current = Date.now();
      if (!background) setState((s) => (s.kind === 'ready' ? s : { kind: 'loading' }));
      try {
        const repo = await hostedFor(repoPath).catch(() => null);
        setHosted(repo);
        if (!repo) {
          setState({ kind: 'none', message: 'No GitHub, GitLab or Bitbucket origin remote.' });
          return;
        }
        setState({ kind: 'ready', items: await openRequests(repo) });
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
    window.addEventListener(REQUESTS_CHANGED, reload);
    // automatic refresh: on a timer while the app is visible, and when it comes back into focus
    const tick = () => {
      if (document.visibilityState === 'visible') void load(true);
    };
    const timer = setInterval(tick, AUTO_REFRESH_MS);
    const onFocus = () => {
      if (document.visibilityState === 'visible' && Date.now() - lastLoad.current > FOCUS_REFRESH_MS) void load(true);
    };
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onFocus);
    return () => {
      window.removeEventListener(REQUESTS_CHANGED, reload);
      clearInterval(timer);
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onFocus);
    };
  }, [load]);

  const items = useMemo(() => {
    if (state.kind !== 'ready') return [];
    const q = query.trim().toLowerCase();
    if (!q) return state.items;
    return state.items.filter((r) =>
      [r.title, r.author, r.head, r.base, `#${r.number}`].some((v) => v.toLowerCase().includes(q)),
    );
  }, [state, query]);
  useEffect(() => onCount(state.kind === 'ready' ? state.items.length : 0), [state, onCount]);

  const noun = hosted ? REQUEST_NOUN[hosted.kind] : 'Pull Request';
  const open = (url: string) => {
    if (hosted)
      void desktopApi()
        .hosting.open(hosted.kind, hosted.host, url)
        .catch(() => {});
  };

  return (
    <div>
      <div className="flex items-center gap-1 px-4 pb-1">
        <span className="flex-1 truncate text-xs text-sub">{hosted ? `${hosted.path}` : ''}</span>
        <button
          type="button"
          onClick={() => void load()}
          aria-label={`Refresh ${noun.toLowerCase()}s`}
          title="Refresh"
          className="rounded p-1 text-sub hover:bg-surface hover:text-text"
        >
          <RefreshCw size={14} className={state.kind === 'loading' ? 'animate-spin motion-reduce:animate-none' : ''} />
        </button>
        <button
          type="button"
          onClick={onCreate}
          aria-label={`Create ${noun.toLowerCase()}`}
          title={`Create ${noun.toLowerCase()}`}
          className="rounded p-1 text-sub hover:bg-surface hover:text-text"
        >
          <Plus size={15} />
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
            <button onClick={onCreate} className="mt-1 flex items-center gap-1 text-accent hover:underline">
              <KeyRound size={12} aria-hidden /> Connect
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
                {list.map((r) => {
                  const Icon = r.draft ? GitPullRequestDraft : GitPullRequest;
                  return (
                    <button
                      key={`${group.id}:${r.id}`}
                      type="button"
                      onClick={(e) => e.detail <= 1 && open(r.url)}
                      onDoubleClick={() => void openRef('remote', `origin/${r.head}`)}
                      onContextMenu={(event) => {
                        event.preventDefault();
                        setMenu({ request: r, x: event.clientX, y: event.clientY });
                      }}
                      title={`${r.title}\n${r.head} → ${r.base} · ${r.author}\nClick to open · double-click to check out ${r.head}`}
                      className="flex w-full items-start gap-2 py-1.5 pl-12 pr-4 text-left hover:bg-surface/50"
                    >
                      <Icon
                        size={14}
                        className={`mt-0.5 shrink-0 ${r.draft ? 'text-sub' : 'text-success'}`}
                        aria-hidden
                      />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm">{r.title}</span>
                        <span className="block truncate text-2xs text-sub">
                          #{r.number} · {r.head} → {r.base} · {r.author} · {ago(r.updated)}
                        </span>
                      </span>
                      <span className="mt-0.5">
                        <CiBadge repo={hosted} sha={r.sha} />
                      </span>
                    </button>
                  );
                })}
              </Collapse>
            </div>
          );
        })}
      {menu && (
        <ContextMenu
          label={`Actions for ${noun.toLowerCase()} #${menu.request.number}`}
          x={menu.x}
          y={menu.y}
          width={280}
          onClose={() => setMenu(null)}
          items={[
            { label: 'Open in browser', run: () => open(menu.request.url) },
            {
              label: `Check out ${menu.request.head}`,
              run: () => void openRef('remote', `origin/${menu.request.head}`),
            },
            { label: 'Show branch in graph', run: () => void locateRef('remote', `origin/${menu.request.head}`) },
            '-',
            {
              label: 'Copy',
              sub: [
                { label: 'Link', run: () => copy(menu.request.url, 'Link') },
                { label: `Branch name (${menu.request.head})`, run: () => copy(menu.request.head, 'Branch name') },
                { label: `Title`, run: () => copy(menu.request.title, 'Title') },
              ],
            },
          ]}
        />
      )}
    </div>
  );
}
