import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  Archive,
  Check,
  ChevronDown,
  ChevronRight,
  Cloud,
  Folder,
  FolderOpen,
  GitBranch,
  Globe,
  Laptop,
  Search,
  Tag,
  X,
} from 'lucide-react';
import { ancestors, buildTree, visibleRows, type RefLeaf } from '../lib/refTree';
import { useRepo } from '../store/repoStore';
import { checkoutRemoteWithSparseRecovery } from '../lib/checkoutRemoteFlow';
import { SidebarSkeleton } from './Loading';
import type { StashRef } from '../shared/types';
import { askConfirm } from './Dialogs';

function Section({
  icon,
  title,
  count,
  children,
  defaultOpen = false,
  filtering = false,
}: {
  icon: React.ReactNode;
  title: string;
  count: number;
  children: React.ReactNode;
  defaultOpen?: boolean;
  filtering?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const beforeFilter = useRef(open);
  const wasFiltering = useRef(false);
  useEffect(() => {
    if (filtering && !wasFiltering.current) {
      beforeFilter.current = open;
      setOpen(true);
    } else if (!filtering && wasFiltering.current) {
      setOpen(beforeFilter.current);
    }
    wasFiltering.current = filtering;
  }, [filtering]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <section className="border-b border-surface/60">
      <button
        aria-expanded={open}
        className="flex min-h-[42px] w-full items-center gap-2.5 px-4 py-2 text-left text-[13px] font-semibold hover:bg-surface/40 focus-visible:outline focus-visible:outline-2 focus-visible:outline-[#4cc2ff]"
        onClick={() => setOpen(!open)}
      >
        {open ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
        <span className="text-sub [&>svg]:h-[18px] [&>svg]:w-[18px]">{icon}</span>
        <span>{title}</span>
        <span className="ml-auto rounded bg-surface/70 px-1.5 py-0.5 text-xs font-medium tabular-nums text-sub">
          {count}
        </span>
      </button>
      {open && (
        <div className="pb-2">
          {count ? (
            children
          ) : (
            <p className="px-10 py-1 text-xs text-sub">{filtering ? 'No matches' : `No ${title.toLowerCase()} yet`}</p>
          )}
        </div>
      )}
    </section>
  );
}

const FLOW_COLOR: Record<string, string> = {
  feature: '#a6e3a1',
  bugfix: '#f9e2af',
  release: '#cba6f7',
  hotfix: '#f38ba8',
  support: '#94e2d5',
};
const INDENT = 16;

/**
 * Hierarchical ref tree: every "/" is a level, folders collapse, and a folder's count is how many refs it holds.
 * Arrow keys move between rows; Enter locates a branch and Shift+Enter checks it out.
 */
function RefTree({
  id,
  items,
  open,
  toggle,
  forceOpen,
  onOpen,
  onNavigate,
  onContext,
  rootIcon,
  colorRoots,
  currentStatus,
}: {
  id: string;
  items: RefLeaf[];
  open: Set<string>;
  toggle: (key: string) => void;
  forceOpen: boolean;
  onOpen: (full: string) => void;
  onNavigate?: (full: string) => void;
  onContext?: (name: string, x: number, y: number) => void;
  rootIcon?: boolean; // top level are remotes (origin, upstream…)
  colorRoots?: boolean; // tint git-flow prefixes
  currentStatus?: { upstream?: string; ahead?: number; behind?: number; gone?: boolean };
}) {
  const rows = useMemo(
    () => visibleRows(buildTree(items), (p) => open.has(`${id}:${p}`), forceOpen),
    [items, open, id, forceOpen],
  );
  const [focusPath, setFocusPath] = useState<string | null>(null);
  const tabStopPath = rows.some(({ node }) => node.path === focusPath)
    ? focusPath
    : (rows.find(({ node }) => node.leaf?.current)?.node.path ?? rows[0]?.node.path);

  const onKey = (e: React.KeyboardEvent) => {
    const el = e.target as HTMLElement;
    const list = [...(e.currentTarget as HTMLElement).querySelectorAll<HTMLElement>('[role="treeitem"]')];
    const i = list.indexOf(el);
    if (i < 0) return;
    const focusItem = (target?: HTMLElement) => {
      if (!target) return;
      setFocusPath(target.dataset.refPath ?? null);
      target.focus();
    };
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      focusItem(list[i + 1]);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      focusItem(list[i - 1]);
    } else if (e.key === 'Home') {
      e.preventDefault();
      focusItem(list[0]);
    } else if (e.key === 'End') {
      e.preventDefault();
      focusItem(list[list.length - 1]);
    } else if (e.key === 'ArrowRight' && el.getAttribute('aria-expanded') === 'false') {
      e.preventDefault();
      el.click();
    } else if (e.key === 'ArrowLeft' && el.getAttribute('aria-expanded') === 'true') {
      e.preventDefault();
      el.click();
    }
  };

  return (
    <div role="tree" aria-label={`${id} refs`} onKeyDown={onKey}>
      {rows.map(({ node, depth, isFolder }) => {
        const key = `${id}:${node.path}`;
        const expanded = forceOpen || open.has(key);
        const pad = 14 + depth * INDENT;
        if (isFolder) {
          const tint = colorRoots && depth === 0 ? FLOW_COLOR[node.name] : undefined;
          const Icon = rootIcon && depth === 0 ? Globe : expanded ? FolderOpen : Folder;
          return (
            <button
              key={key}
              role="treeitem"
              data-ref-path={node.path}
              tabIndex={tabStopPath === node.path ? 0 : -1}
              aria-level={depth + 1}
              aria-expanded={expanded}
              onFocus={() => setFocusPath(node.path)}
              onClick={() => toggle(key)}
              title={node.path}
              className="flex min-h-[32px] w-full items-center gap-1.5 pr-4 text-left text-[14px] hover:bg-surface/50"
              style={{ paddingLeft: pad }}
            >
              {expanded ? (
                <ChevronDown size={14} className="shrink-0 text-sub" aria-hidden />
              ) : (
                <ChevronRight size={14} className="shrink-0 text-sub" aria-hidden />
              )}
              <Icon size={16} className="shrink-0" style={{ color: tint ?? '#7f849c' }} aria-hidden />
              <span className="truncate" style={tint ? { color: tint } : undefined}>
                {node.name}
              </span>
              <span className="ml-auto shrink-0 pl-2 text-[12px] text-sub">{node.count}</span>
            </button>
          );
        }
        const cur = node.leaf?.current;
        return (
          <button
            key={key}
            role="treeitem"
            data-ref-path={node.path}
            tabIndex={tabStopPath === node.path ? 0 : -1}
            aria-level={depth + 1}
            aria-selected={!!cur}
            aria-description={
              id === 'tags' ? undefined : 'Press Enter to locate this branch. Press Shift+Enter to check it out.'
            }
            aria-keyshortcuts={id === 'tags' ? undefined : 'Shift+Enter'}
            onFocus={() => setFocusPath(node.path)}
            onClick={(e) => {
              if (e.detail <= 1) onNavigate?.(node.leaf!.full);
            }}
            onDoubleClick={() => !cur && onOpen(node.leaf!.full)}
            onContextMenu={(e) => {
              if (onContext) {
                e.preventDefault();
                onContext(node.leaf!.full, e.clientX, e.clientY);
              }
            }}
            onKeyDown={(e) => {
              if ((e.key === 'F10' && e.shiftKey) || e.key === 'ContextMenu') {
                if (!onContext) return;
                e.preventDefault();
                const bounds = e.currentTarget.getBoundingClientRect();
                onContext(node.leaf!.full, bounds.left + Math.min(bounds.width, 180), bounds.top + bounds.height / 2);
                return;
              }
              if (e.key === 'Enter' && (e.shiftKey || !onNavigate) && !cur) {
                e.preventDefault();
                onOpen(node.leaf!.full);
              }
            }}
            title={`${node.leaf!.full}${onNavigate ? ' — click to locate' : ''}${cur ? ' (current)' : ' — double-click or Shift+Enter to check out'}`}
            className={`flex min-h-[32px] w-full items-center gap-2 pr-4 text-left text-[14px] hover:bg-surface/50 ${cur ? 'border-l-2 border-[#4cc2ff] bg-[#4cc2ff]/15 font-semibold text-[#4cc2ff]' : ''}`}
            style={{ paddingLeft: pad + 18 }}
          >
            {cur ? (
              <Check size={15} className="shrink-0" aria-hidden />
            ) : (
              <GitBranch size={15} className="shrink-0 text-sub" aria-hidden />
            )}
            <span className="truncate">{node.name}</span>
            {cur && <span className="ml-auto shrink-0 text-[11px] font-normal">Current</span>}
            {cur &&
              currentStatus?.upstream &&
              (currentStatus.gone || !!currentStatus.ahead || !!currentStatus.behind) && (
                <span
                  className="shrink-0 text-[11px] font-normal"
                  title={
                    currentStatus.gone
                      ? `${currentStatus.upstream} is unavailable`
                      : `Compared with ${currentStatus.upstream}: ${currentStatus.ahead ?? 0} ahead, ${currentStatus.behind ?? 0} behind`
                  }
                >
                  {currentStatus.gone
                    ? 'Gone'
                    : `${currentStatus.ahead ? `↑${currentStatus.ahead} ` : ''}${currentStatus.behind ? `↓${currentStatus.behind}` : ''}`}
                </span>
              )}
          </button>
        );
      })}
    </div>
  );
}

export function Sidebar({
  onNavigate,
  onContext,
  onTag,
  onStash,
  selectedStashHash,
}: {
  onNavigate: (kind: 'local' | 'remote', name: string) => void;
  onContext: (kind: 'local' | 'remote', name: string, x: number, y: number) => void;
  onTag: (name: string) => void;
  onStash: (stash: StashRef) => void;
  selectedStashHash?: string;
}) {
  const { refs, checkout, loading, repoPath, working, operation } = useRepo();
  const [q, setQ] = useState('');
  const [stashMenu, setStashMenu] = useState<{ stash: StashRef; x: number; y: number } | null>(null);
  const [stashBusy, setStashBusy] = useState(false);
  const [open, setOpen] = useState<Set<string>>(new Set());
  const toggle = (key: string) =>
    setOpen((s) => {
      const n = new Set(s);
      n.has(key) ? n.delete(key) : n.add(key);
      return n;
    });

  // keep the folders on the way to the checked-out branch open, so after a checkout you can see where you are
  const cur = refs.local.find((b) => b.current)?.name;
  useEffect(() => {
    if (cur) setOpen((s) => new Set([...s, ...ancestors(cur).map((p) => `local:${p}`)]));
  }, [cur]);

  const query = q.trim().toLowerCase();
  const f = (n: string) => n.toLowerCase().includes(query);
  const filtering = query.length > 0;
  const local = useMemo(
    () => refs.local.filter((b) => f(b.name)).map((b) => ({ full: b.name, current: b.current })),
    [refs.local, q],
  ); // eslint-disable-line react-hooks/exhaustive-deps
  const remote = useMemo(() => refs.remote.filter((b) => f(b.name)).map((b) => ({ full: b.name })), [refs.remote, q]); // eslint-disable-line react-hooks/exhaustive-deps
  const tags = useMemo(() => refs.tags.filter((t) => f(t.name)).map((t) => ({ full: t.name })), [refs.tags, q]); // eslint-disable-line react-hooks/exhaustive-deps
  const stashes = refs.stashes.filter((s) => f(s.message));

  const empty = !refs.local.length && !refs.remote.length && !refs.tags.length && !refs.stashes.length;
  useEffect(() => {
    if (!stashMenu) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setStashMenu(null);
    };
    window.addEventListener('keydown', closeOnEscape);
    return () => window.removeEventListener('keydown', closeOnEscape);
  }, [stashMenu]);

  const runStashAction = async (action: 'apply' | 'pop' | 'drop') => {
    const stash = stashMenu?.stash;
    if (!stash || !stash.hash || !repoPath || stashBusy || working || operation) return;
    const selectedRepo = repoPath;
    const selectedHash = stash.hash;
    setStashMenu(null);
    const description =
      action === 'drop'
        ? 'Permanently remove this stash and its saved changes.'
        : action === 'pop'
          ? 'Apply the saved changes and remove the stash only if applying succeeds.'
          : 'Apply the saved changes and keep the stash entry.';
    if (
      !(await askConfirm(`${action[0].toUpperCase()}${action.slice(1)} stash?`, `${stash.message}\n\n${description}`, {
        label: `${action[0].toUpperCase()}${action.slice(1)} stash`,
        danger: action === 'drop',
      }))
    )
      return;
    if (useRepo.getState().repoPath !== selectedRepo) return;

    setStashBusy(true);
    let failure = '';
    await useRepo.getState().track(`Stash ${action}…`, async () => {
      try {
        await (window as any).gitApi.stashAction(selectedRepo, selectedHash, action);
      } catch (error) {
        failure = String((error as Error).message).replace(/^Error invoking remote method '[^']*': (Error: )?/, '');
      } finally {
        if (useRepo.getState().repoPath === selectedRepo) await useRepo.getState().refresh();
      }
    }, { blocking: true });
    setStashBusy(false);
    if (useRepo.getState().repoPath !== selectedRepo) return;
    if (failure) {
      const hasConflicts = useRepo
        .getState()
        .status.some((file) => ['DD', 'AU', 'UD', 'UA', 'DU', 'AA', 'UU'].includes(file.index + file.worktree));
      useRepo.getState().notify(
        'error',
        `Could not ${action} stash`,
        hasConflicts ? 'Resolve conflicted files in Working changes. The stash was kept.' : failure,
      );
    } else {
      useRepo.getState().notify('success', `Stash ${action === 'apply' ? 'applied' : action === 'pop' ? 'popped' : 'dropped'}`);
    }
  };
  if (loading && empty)
    return (
      <div className="glass-panel h-full bg-mantle">
        <SidebarSkeleton />
      </div>
    );

  return (
    <div className="glass-panel flex h-full flex-col overflow-y-auto bg-mantle">
      <div className="px-4 pb-3 pt-4">
        <div className="mb-2 flex items-baseline justify-between gap-2">
          <h2 className="text-sm font-semibold">Repository</h2>
          <span className="text-xs text-sub">Branches & refs</span>
        </div>
        <div className="relative">
          <Search
            size={15}
            className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-sub"
            aria-hidden
          />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            aria-label="Filter branches, stashes, and tags"
            placeholder="Filter branches, stashes, tags…"
            className="w-full rounded-md border border-surface bg-crust py-2 pl-9 pr-9 text-sm placeholder:text-sub focus:border-[#4cc2ff] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[#4cc2ff]"
          />
          {q && (
            <button
              type="button"
              aria-label="Clear filter"
              onClick={() => setQ('')}
              className="absolute right-1 top-1/2 flex h-7 w-7 -translate-y-1/2 items-center justify-center rounded text-sub hover:bg-surface hover:text-text focus-visible:outline focus-visible:outline-2 focus-visible:outline-[#4cc2ff]"
            >
              <X size={14} aria-hidden />
            </button>
          )}
        </div>
        {filtering && (
          <p className="mt-2 text-xs text-sub" role="status">
            {local.length + remote.length + stashes.length + tags.length
              ? `${local.length + remote.length + stashes.length + tags.length} results`
              : 'No matching branches, stashes, or tags.'}
          </p>
        )}
        <p className="mt-2 text-[11px] text-sub">Enter locates a branch · Shift+Enter checks it out</p>
      </div>
      <Section icon={<Laptop />} title="Local" count={local.length} defaultOpen filtering={filtering}>
        <RefTree
          id="local"
          items={local}
          open={open}
          toggle={toggle}
          forceOpen={filtering}
          onOpen={checkout}
          onNavigate={(name) => onNavigate('local', name)}
          onContext={(name, x, y) => onContext('local', name, x, y)}
          colorRoots
          currentStatus={refs.local.find((b) => b.current)}
        />
      </Section>
      <Section icon={<Cloud />} title="Remote" count={remote.length} filtering={filtering}>
        <RefTree
          id="remote"
          items={remote}
          open={open}
          toggle={toggle}
          forceOpen={filtering}
          onOpen={(name) => void checkoutRemoteWithSparseRecovery(name)}
          onNavigate={(name) => onNavigate('remote', name)}
          onContext={(name, x, y) => onContext('remote', name, x, y)}
          rootIcon
        />
      </Section>
      <Section icon={<Archive />} title="Stashes" count={stashes.length} filtering={filtering}>
        {stashes.map((s) => (
          <button
            key={s.id}
            type="button"
            onClick={() => onStash(s)}
            onContextMenu={(event) => {
              event.preventDefault();
              setStashMenu({ stash: s, x: event.clientX, y: event.clientY });
            }}
            aria-pressed={!!s.hash && s.hash === selectedStashHash}
            title={s.message}
            className={`block min-h-[32px] w-full truncate px-9 py-[7px] text-left text-[14px] hover:bg-surface/50 ${s.hash && s.hash === selectedStashHash ? 'bg-[#f5a623]/15 text-[#f5a623]' : ''}`}
          >
            {s.message}
          </button>
        ))}
      </Section>
      <Section icon={<Tag />} title="Tags" count={tags.length} filtering={filtering}>
        <RefTree
          id="tags"
          items={tags}
          open={open}
          toggle={toggle}
          forceOpen={filtering}
          onOpen={checkout}
          onNavigate={onTag}
        />
      </Section>
      {stashMenu && createPortal(
        <div
          className="fixed inset-0 z-[100]"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) setStashMenu(null);
          }}
          onContextMenu={(event) => {
            event.preventDefault();
            setStashMenu(null);
          }}
        >
          <div
            role="menu"
            aria-label={`Actions for stash ${stashMenu.stash.message}`}
            className="glass-context-menu fixed z-[101] w-56 rounded-xl border border-white/15 p-1.5 shadow-2xl"
            style={{ left: Math.min(stashMenu.x, window.innerWidth - 240), top: Math.min(stashMenu.y, window.innerHeight - 170) }}
            onMouseDown={(event) => event.stopPropagation()}
          >
            {(['apply', 'pop', 'drop'] as const).map((action) => (
              <button
                key={action}
                type="button"
                role="menuitem"
                disabled={stashBusy || !!working || !!operation || !stashMenu.stash.hash}
                onClick={() => void runStashAction(action)}
                className={`flex min-h-9 w-full items-center rounded-lg px-3 text-left text-[13px] capitalize hover:bg-white/10 focus-visible:outline focus-visible:outline-2 focus-visible:outline-[#4cc2ff] disabled:opacity-40 ${action === 'drop' ? 'text-[#f38ba8]' : 'text-text'}`}
              >
                {action === 'apply' ? 'Apply stash' : action === 'pop' ? 'Pop stash' : 'Drop stash'}
              </button>
            ))}
          </div>
        </div>,
        document.body,
      )}
    </div>
  );
}
