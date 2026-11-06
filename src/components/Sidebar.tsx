import { useEffect, useMemo, useState } from 'react';
import { Archive, Check, ChevronDown, ChevronRight, Cloud, Folder, FolderOpen, GitBranch, Globe, Laptop, Search, Tag } from 'lucide-react';
import { ancestors, buildTree, visibleRows, type RefLeaf } from '../lib/refTree';
import { useRepo } from '../store/repoStore';
import { SidebarSkeleton } from './Loading';

function Section({ icon, title, count, children, defaultOpen = false }: { icon: React.ReactNode; title: string; count: number; children: React.ReactNode; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="border-b border-surface/60">
      <button aria-expanded={open} className="flex min-h-[46px] w-full items-center gap-3 px-4 py-2 text-[13px] font-semibold uppercase tracking-wider hover:bg-surface/40" onClick={() => setOpen(!open)}>
        {open ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
        <span className="text-sub [&>svg]:h-[18px] [&>svg]:w-[18px]">{icon}</span>
        <span>{title}</span>
        <span className="ml-auto font-bold text-[#4cc2ff]">{count}</span>
      </button>
      {open && <div className="pb-1">{children}</div>}
    </div>
  );
}

const FLOW_COLOR: Record<string, string> = { feature: '#a6e3a1', bugfix: '#f9e2af', release: '#cba6f7', hotfix: '#f38ba8', support: '#94e2d5' };
const INDENT = 16;

/**
 * Hierarchical ref tree: every "/" is a level, folders collapse, and a folder's count is how many refs it holds.
 * Arrow keys move between rows; Enter locates a branch and Shift+Enter checks it out.
 */
function RefTree({ id, items, open, toggle, forceOpen, onOpen, onNavigate, onContext, rootIcon, colorRoots }: {
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
}) {
  const rows = useMemo(() => visibleRows(buildTree(items), (p) => open.has(`${id}:${p}`), forceOpen), [items, open, id, forceOpen]);

  const onKey = (e: React.KeyboardEvent) => {
    const el = e.target as HTMLElement;
    const list = [...(e.currentTarget as HTMLElement).querySelectorAll<HTMLElement>('[role="treeitem"]')];
    const i = list.indexOf(el);
    if (i < 0) return;
    if (e.key === 'ArrowDown') { e.preventDefault(); list[i + 1]?.focus(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); list[i - 1]?.focus(); }
    else if (e.key === 'ArrowRight' && el.getAttribute('aria-expanded') === 'false') { e.preventDefault(); el.click(); }
    else if (e.key === 'ArrowLeft' && el.getAttribute('aria-expanded') === 'true') { e.preventDefault(); el.click(); }
  };

  return (
    <div role="tree" onKeyDown={onKey}>
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
              aria-level={depth + 1}
              aria-expanded={expanded}
              onClick={() => toggle(key)}
              title={node.path}
              className="flex min-h-[32px] w-full items-center gap-1.5 pr-4 text-left text-[14px] hover:bg-surface/50"
              style={{ paddingLeft: pad }}
            >
              {expanded ? <ChevronDown size={14} className="shrink-0 text-sub" aria-hidden /> : <ChevronRight size={14} className="shrink-0 text-sub" aria-hidden />}
              <Icon size={16} className="shrink-0" style={{ color: tint ?? '#7f849c' }} aria-hidden />
              <span className="truncate" style={tint ? { color: tint } : undefined}>{node.name}</span>
              <span className="ml-auto shrink-0 pl-2 text-[12px] text-sub">{node.count}</span>
            </button>
          );
        }
        const cur = node.leaf?.current;
        return (
          <button
            key={key}
            role="treeitem"
            aria-level={depth + 1}
            aria-selected={!!cur}
            onClick={(e) => { if (e.detail <= 1) onNavigate?.(node.leaf!.full); }}
            onDoubleClick={() => !cur && onOpen(node.leaf!.full)}
            onContextMenu={(e) => { if (onContext) { e.preventDefault(); onContext(node.leaf!.full, e.clientX, e.clientY); } }}
            onKeyDown={(e) => { if (e.key === 'Enter' && (e.shiftKey || !onNavigate) && !cur) { e.preventDefault(); onOpen(node.leaf!.full); } }}
            title={`${node.leaf!.full}${onNavigate ? ' — click to locate' : ''}${cur ? ' (current)' : ' — double-click or Shift+Enter to check out'}`}
            className={`flex min-h-[32px] w-full items-center gap-2 pr-4 text-left text-[14px] hover:bg-surface/50 ${cur ? 'bg-[#4cc2ff]/15 font-semibold text-[#4cc2ff]' : ''}`}
            style={{ paddingLeft: pad + 18 }}
          >
            {cur ? <Check size={15} className="shrink-0" aria-hidden /> : <GitBranch size={15} className="shrink-0 text-sub" aria-hidden />}
            <span className={`truncate ${cur ? 'text-[16.8px]' : ''}`}>{node.name}</span>
            {cur && <span className="ml-auto shrink-0 text-[11px] font-normal uppercase tracking-wide">HEAD</span>}
          </button>
        );
      })}
    </div>
  );
}

export function Sidebar({ onNavigate, onContext, onTag, onStash }: { onNavigate: (kind: 'local' | 'remote', name: string) => void; onContext: (kind: 'local' | 'remote', name: string, x: number, y: number) => void; onTag: (name: string) => void; onStash: (stash: { id: string; message: string }) => void }) {
  const { refs, checkout, checkoutRemote, loading } = useRepo();
  const [q, setQ] = useState('');
  const [open, setOpen] = useState<Set<string>>(new Set());
  const toggle = (key: string) => setOpen((s) => { const n = new Set(s); n.has(key) ? n.delete(key) : n.add(key); return n; });

  // keep the folders on the way to the checked-out branch open, so after a checkout you can see where you are
  const cur = refs.local.find((b) => b.current)?.name;
  useEffect(() => {
    if (cur) setOpen((s) => new Set([...s, ...ancestors(cur).map((p) => `local:${p}`)]));
  }, [cur]);

  const f = (n: string) => n.toLowerCase().includes(q.toLowerCase());
  const filtering = q.trim().length > 0;
  const local = useMemo(() => refs.local.filter((b) => f(b.name)).map((b) => ({ full: b.name, current: b.current })), [refs.local, q]); // eslint-disable-line react-hooks/exhaustive-deps
  const remote = useMemo(() => refs.remote.filter((b) => f(b.name)).map((b) => ({ full: b.name })), [refs.remote, q]); // eslint-disable-line react-hooks/exhaustive-deps
  const tags = useMemo(() => refs.tags.filter((t) => f(t.name)).map((t) => ({ full: t.name })), [refs.tags, q]); // eslint-disable-line react-hooks/exhaustive-deps
  const stashes = refs.stashes.filter((s) => f(s.message));

  const empty = !refs.local.length && !refs.remote.length && !refs.tags.length && !refs.stashes.length;
  if (loading && empty) return <div className="h-full bg-mantle"><SidebarSkeleton /></div>;

  return (
    <div className="flex h-full flex-col overflow-y-auto bg-mantle">
      <div className="p-4">
        <div className="relative">
          <input value={q} onChange={(e) => setQ(e.target.value)} aria-label="Filter branches and tags" placeholder="Filter branches, tags…" className="w-full rounded-md border border-surface bg-crust py-2 pl-3 pr-8 outline-none placeholder:text-sub focus:border-[#4cc2ff]" />
          <Search size={14} className="absolute right-2.5 top-3 text-sub" aria-hidden />
        </div>
      </div>
      <Section key={`local-${filtering}`} icon={<Laptop />} title="Local" count={local.length} defaultOpen>
        <RefTree id="local" items={local} open={open} toggle={toggle} forceOpen={filtering} onOpen={checkout} onNavigate={(name) => onNavigate('local', name)} onContext={(name, x, y) => onContext('local', name, x, y)} colorRoots />
      </Section>
      <Section key={`remote-${filtering}`} icon={<Cloud />} title="Remote" count={remote.length} defaultOpen={filtering}>
        <RefTree id="remote" items={remote} open={open} toggle={toggle} forceOpen={filtering} onOpen={checkoutRemote} onNavigate={(name) => onNavigate('remote', name)} onContext={(name, x, y) => onContext('remote', name, x, y)} rootIcon />
      </Section>
      <Section icon={<Archive />} title="Stashes" count={stashes.length}>
        {stashes.map((s) => <button key={s.id} onClick={() => onStash(s)} title={s.message} className="block min-h-[32px] w-full truncate px-9 py-[7px] text-left text-[14px] hover:bg-surface/50">{s.message}</button>)}
      </Section>
      <Section key={`tags-${filtering}`} icon={<Tag />} title="Tags" count={tags.length} defaultOpen={filtering}>
        <RefTree id="tags" items={tags} open={open} toggle={toggle} forceOpen={filtering} onOpen={checkout} onNavigate={onTag} />
      </Section>
    </div>
  );
}
