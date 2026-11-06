import { useEffect, useRef, useState } from 'react';
import { Check, ChevronDown, ChevronRight, FolderOpen, GitBranch, Search } from 'lucide-react';
import { useRepo } from '../store/repoStore';

export function RepoBranchDropdown({ current }: { current: string }) {
  const { repoPath, recentRepos, refs, loading, openRepo, checkout, checkoutRemote } = useRepo();
  const [open, setOpen] = useState<'repo' | 'branch' | null>(null);
  const [query, setQuery] = useState('');
  const container = useRef<HTMLDivElement>(null);
  const repoButton = useRef<HTMLButtonElement>(null);
  const branchButton = useRef<HTMLButtonElement>(null);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    input.current?.focus();
    const outside = (e: PointerEvent) => {
      if (!container.current?.contains(e.target as Node)) setOpen(null);
    };
    const escape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        setOpen(null);
        (open === 'repo' ? repoButton : branchButton).current?.focus();
      }
    };
    document.addEventListener('pointerdown', outside);
    document.addEventListener('keydown', escape);
    return () => {
      document.removeEventListener('pointerdown', outside);
      document.removeEventListener('keydown', escape);
    };
  }, [open]);

  useEffect(() => {
    setOpen(null);
  }, [repoPath]);
  const toggle = (name: 'repo' | 'branch') => {
    setQuery('');
    setOpen((v) => (v === name ? null : name));
  };
  const matches = (value: string) => value.toLowerCase().includes(query.trim().toLowerCase());
  const local = refs.local.filter((b) => matches(b.name));
  const remote = refs.remote.filter((b) => matches(b.name));
  const repos = recentRepos.filter(matches);
  const item =
    'flex min-h-[38px] w-full items-center gap-2 rounded px-3 py-2 text-left text-[13px] hover:bg-surface/70 focus-visible:bg-surface';

  return (
    <div ref={container} className="flex min-w-0 items-center">
      <div className="relative min-w-0 max-w-[220px]">
        <button
          ref={repoButton}
          onClick={() => toggle('repo')}
          aria-label="Choose repository"
          aria-expanded={open === 'repo'}
          aria-controls="repository-list"
          className="block max-w-full rounded px-1 text-left hover:bg-surface/50"
        >
          <span className="block text-[12px] text-sub">repository</span>
          <span className="flex min-w-0 items-center gap-1 text-[18px] font-semibold leading-tight">
            <span className="truncate">{repoPath?.split('/').pop() ?? '—'}</span>
            <ChevronDown size={14} className="shrink-0 text-sub" aria-hidden />
          </span>
        </button>
        {open === 'repo' && (
          <div
            id="repository-list"
            className="absolute left-0 top-full z-40 mt-2 w-[min(360px,80vw)] rounded-lg border border-surface bg-[#252a35] p-2 shadow-xl"
          >
            <div className="relative mb-2">
              <Search size={14} className="absolute left-3 top-3 text-sub" aria-hidden />
              <input
                ref={input}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                aria-label="Filter repositories"
                placeholder="Filter repositories…"
                className="w-full rounded border border-surface bg-crust py-2 pl-9 pr-3 outline-none focus:border-[#4cc2ff]"
              />
            </div>
            <div className="max-h-72 overflow-auto">
              {repos.map((path) => (
                <button
                  key={path}
                  onClick={() => {
                    setOpen(null);
                    if (path !== repoPath) void openRepo(path);
                  }}
                  aria-current={path === repoPath ? 'true' : undefined}
                  title={path}
                  className={item}
                >
                  <FolderOpen size={15} className="shrink-0 text-sub" aria-hidden />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate">{path.split('/').pop()}</span>
                    <span className="block truncate text-xs text-sub">{path}</span>
                  </span>
                  {path === repoPath && (
                    <Check size={15} className="shrink-0 text-[#4cc2ff]" aria-label="Current repository" />
                  )}
                </button>
              ))}
              {!repos.length && <p className="px-3 py-2 text-sm text-sub">No repositories found.</p>}
            </div>
            <button
              onClick={() => {
                setOpen(null);
                void openRepo();
              }}
              className={`${item} mt-1 border-t border-surface text-[#4cc2ff]`}
            >
              <FolderOpen size={15} aria-hidden />
              Open repository…
            </button>
          </div>
        )}
      </div>
      <ChevronRight size={18} className="mx-2 shrink-0 text-sub" aria-hidden />
      <div className="relative min-w-0 max-w-[320px]">
        <button
          ref={branchButton}
          disabled={!repoPath || loading}
          onClick={() => toggle('branch')}
          aria-label="Choose branch"
          aria-expanded={open === 'branch'}
          aria-controls="branch-list"
          className="block max-w-full rounded px-1 text-left hover:bg-surface/50 disabled:opacity-50"
        >
          <span className="block text-[12px] text-sub">branch</span>
          <span className="flex min-w-0 items-center gap-1 text-[18px] font-semibold leading-tight">
            <span className="truncate">{current}</span>
            <ChevronDown size={14} className="shrink-0 text-sub" aria-hidden />
          </span>
        </button>
        {open === 'branch' && (
          <div
            id="branch-list"
            className="absolute left-0 top-full z-40 mt-2 w-[min(380px,80vw)] rounded-lg border border-surface bg-[#252a35] p-2 shadow-xl"
          >
            <div className="relative mb-2">
              <Search size={14} className="absolute left-3 top-3 text-sub" aria-hidden />
              <input
                ref={input}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                aria-label="Filter branches"
                placeholder="Filter branches…"
                className="w-full rounded border border-surface bg-crust py-2 pl-9 pr-3 outline-none focus:border-[#4cc2ff]"
              />
            </div>
            <div className="max-h-80 overflow-auto">
              {local.length > 0 && (
                <div className="px-3 pb-1 pt-2 text-xs font-semibold uppercase tracking-wide text-sub">Local</div>
              )}
              {local.map((b) => (
                <button
                  key={b.name}
                  onClick={() => {
                    setOpen(null);
                    if (!b.current) void checkout(b.name);
                  }}
                  aria-current={b.current ? 'true' : undefined}
                  title={b.name}
                  className={item}
                >
                  <GitBranch size={15} className="shrink-0 text-sub" aria-hidden />
                  <span className="min-w-0 flex-1 truncate">{b.name}</span>
                  {b.current && <Check size={15} className="shrink-0 text-[#4cc2ff]" aria-label="Current branch" />}
                </button>
              ))}
              {remote.length > 0 && (
                <div className="px-3 pb-1 pt-3 text-xs font-semibold uppercase tracking-wide text-sub">Remote</div>
              )}
              {remote.map((b) => (
                <button
                  key={b.name}
                  onClick={() => {
                    setOpen(null);
                    void checkoutRemote(b.name);
                  }}
                  title={b.name}
                  className={item}
                >
                  <GitBranch size={15} className="shrink-0 text-sub" aria-hidden />
                  <span className="min-w-0 flex-1 truncate">{b.name}</span>
                </button>
              ))}
              {!local.length && !remote.length && <p className="px-3 py-2 text-sm text-sub">No branches found.</p>}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
