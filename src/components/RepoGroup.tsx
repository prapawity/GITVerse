import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Check, ChevronDown, Folder, GitBranch, RefreshCw, Search, Trash2, X } from 'lucide-react';
import { Chevron, Collapse } from './Motion';

type GroupNode = { name: string; path: string; repo?: string; children: GroupNode[] };
const parts = (path: string) => path.replace(/\\/g, '/').split('/').filter(Boolean);

export function RepoGroup({
  name,
  repos,
  root,
  current,
  onOpen,
  onCloseRepo,
  onContext,
  onDelete,
  onSync,
  syncing = false,
}: {
  name: string;
  repos: string[];
  root?: string;
  current: string | null;
  onOpen: (path: string) => void;
  onCloseRepo: (path: string) => void;
  onContext: (path: string, x: number, y: number) => void;
  onDelete: () => void;
  onSync?: (manual: boolean) => void;
  syncing?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const container = useRef<HTMLDivElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ left: 0, top: 0 });
  useEffect(() => {
    if (!open) return;
    const outside = (e: PointerEvent) => {
      if (!container.current?.contains(e.target as Node) && !menu.current?.contains(e.target as Node)) setOpen(false);
    };
    const escape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    const scroll = (e: Event) => {
      if ((e.target as Node).contains(container.current)) setOpen(false);
    };
    document.addEventListener('pointerdown', outside);
    document.addEventListener('keydown', escape);
    document.addEventListener('scroll', scroll, true);
    return () => {
      document.removeEventListener('pointerdown', outside);
      document.removeEventListener('keydown', escape);
      document.removeEventListener('scroll', scroll, true);
    };
  }, [open]);
  const tree = useMemo(() => {
    const all = repos.map(parts);
    let prefix = root ? parts(root) : (all[0]?.slice(0, -1) ?? []);
    if (!root)
      for (const path of all)
        while (prefix.length && !prefix.every((part, i) => path[i] === part)) prefix = prefix.slice(0, -1);
    const nodes: GroupNode[] = [];
    for (let i = 0; i < repos.length; i++) {
      const segments = prefix.every((part, j) => all[i][j] === part)
        ? all[i].slice(prefix.length)
        : [all[i].at(-1) || repos[i]];
      if (!segments.length) segments.push(all[i].at(-1) || repos[i]);
      let children = nodes;
      segments.forEach((segment, index) => {
        const path = segments.slice(0, index + 1).join('/');
        let node = children.find((item) => item.name === segment);
        if (!node) {
          node = { name: segment, path, children: [] };
          children.push(node);
        }
        if (index === segments.length - 1) node.repo = repos[i];
        children = node.children;
      });
    }
    const sort = (items: GroupNode[]) => {
      items.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));
      items.forEach((node) => sort(node.children));
    };
    sort(nodes);
    return nodes;
  }, [repos.join('\0'), root]); // eslint-disable-line react-hooks/exhaustive-deps
  const filterTree = (nodes: GroupNode[], term: string): GroupNode[] =>
    nodes.flatMap((node) => {
      const children = filterTree(node.children, term);
      const matches = node.path.toLowerCase().includes(term);
      return matches || children.length ? [{ ...node, children }] : [];
    });
  const term = query.trim().toLowerCase();
  const shown = term ? filterTree(tree, term) : tree;
  const renderNodes = (nodes: GroupNode[], depth: number): React.ReactNode =>
    nodes.map((node) => {
      const isOpen = !!term || expanded.has(node.path);
      return (
        <div key={node.path}>
          {node.children.length > 0 && (
            <button
              onClick={() =>
                setExpanded((old) => {
                  const next = new Set(old);
                  next.has(node.path) ? next.delete(node.path) : next.add(node.path);
                  return next;
                })
              }
              aria-expanded={isOpen}
              style={{ paddingLeft: 12 + depth * 16 }}
              className="flex min-h-[34px] w-full items-center gap-2 rounded text-left text-sm text-sub hover:bg-surface/50 hover:text-text"
            >
              <Chevron open={isOpen} size={15} />
              <Folder size={15} />
              <span className="truncate">{node.name}</span>
            </button>
          )}
          {node.repo && (
            <div
              style={{ paddingLeft: 28 + depth * 16 }}
              className={`group flex min-h-[34px] items-center gap-2 rounded pr-2 text-sm hover:bg-surface/50 ${node.repo === current ? 'bg-accent/15 text-accent' : ''}`}
              onContextMenu={(e) => {
                e.preventDefault();
                e.stopPropagation();
                onContext(node.repo!, e.clientX, e.clientY);
              }}
            >
              <button
                onClick={() => {
                  onOpen(node.repo!);
                  setOpen(false);
                }}
                title={node.repo}
                aria-current={node.repo === current ? 'true' : undefined}
                className="flex min-w-0 flex-1 items-center gap-2 py-2 text-left"
              >
                <GitBranch size={15} className="shrink-0" />
                <span className="truncate">{node.name}</span>
                {node.repo === current && <Check size={14} className="ml-auto shrink-0" />}
              </button>
              <button
                aria-label={`Close ${node.name}`}
                title="Close repository"
                onClick={() => onCloseRepo(node.repo!)}
                className="rounded p-1 text-sub opacity-0 hover:bg-surface focus:opacity-100 group-hover:opacity-100"
              >
                <X size={14} />
              </button>
            </div>
          )}
          {node.children.length > 0 && <Collapse open={isOpen}>{renderNodes(node.children, depth + 1)}</Collapse>}
        </div>
      );
    });
  return (
    <div ref={container} className="relative mx-1 shrink-0" onClick={(e) => e.stopPropagation()}>
      <button
        onClick={() => {
          const rect = container.current!.getBoundingClientRect();
          setPosition({
            left: Math.max(8, Math.min(rect.left, window.innerWidth - Math.min(320, window.innerWidth * 0.8) - 8)),
            top: rect.bottom + 8,
          });
          setOpen(!open);
          if (!open && root) onSync?.(false);
        }}
        aria-expanded={open}
        aria-haspopup="true"
        aria-busy={syncing}
        className={`flex h-9 items-center gap-2 rounded-lg border px-3 text-sm font-semibold ${repos.includes(current ?? '') ? 'border-accent/50 bg-accent/10 text-accent' : 'border-surface text-sub hover:bg-surface/50'}`}
      >
        <Folder size={16} />
        <span className="max-w-[120px] truncate">{name}</span>
        <span className="rounded-full bg-surface px-1.5 text-2xs">{repos.length}</span>
        {syncing ? (
          <RefreshCw size={14} className="animate-spin motion-reduce:animate-none" />
        ) : (
          <ChevronDown size={14} />
        )}
      </button>
      {open &&
        createPortal(
          <div
            ref={menu}
            style={position}
            onClick={(e) => e.stopPropagation()}
            className="pop-in fixed z-50 w-[320px] max-w-[80vw] rounded-lg border border-surface bg-mantle p-2 shadow-2xl"
          >
            <div className="flex items-center justify-between gap-2 px-2 pb-2">
              <div className="min-w-0 break-words text-xs font-semibold uppercase text-sub">
                {name} · {repos.length} repositories
              </div>
              <button
                type="button"
                aria-label={`Sync ${name}`}
                aria-busy={syncing}
                disabled={!root || syncing}
                title={
                  !root
                    ? 'This group has no source folder'
                    : syncing
                      ? 'Scanning for repositories'
                      : 'Sync repositories from folder'
                }
                onClick={() => onSync?.(true)}
                className="flex h-8 w-8 shrink-0 items-center justify-center rounded text-sub hover:bg-surface/50 hover:text-text disabled:cursor-not-allowed disabled:opacity-50"
              >
                <RefreshCw size={15} className={syncing ? 'animate-spin motion-reduce:animate-none' : ''} />
              </button>
            </div>
            <div className="relative mb-2">
              <Search size={15} className="absolute left-3 top-2.5 text-sub" aria-hidden />
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                aria-label={`Search repositories in ${name}`}
                placeholder="Search repositories or folders…"
                className="w-full rounded-md border border-surface bg-crust py-2 pl-9 pr-3 text-sm outline-none focus:border-accent"
              />
            </div>
            <div className="max-h-[min(60vh,480px)] overflow-auto">
              {shown.length ? (
                renderNodes(shown, 0)
              ) : (
                <p className="px-3 py-3 text-sm text-sub">No matching repositories.</p>
              )}
            </div>
            <div className="mt-1 flex items-center justify-between gap-2 border-t border-surface px-2 pt-2">
              <p className="text-xs text-sub">Right-click a repository to manage its group.</p>
              <button
                onClick={onDelete}
                className="flex shrink-0 items-center gap-1 rounded px-2 py-1 text-xs text-danger hover:bg-danger/10"
              >
                <Trash2 size={14} /> Delete group
              </button>
            </div>
          </div>,
          document.body,
        )}
    </div>
  );
}
