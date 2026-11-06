import { useEffect, useRef, useState } from 'react';
import { Sparkles, Settings as GearIcon, SquareTerminal, ArchiveRestore, Archive, ArrowDownToLine, Download, FolderOpen, GitBranch, Plus, Redo2, Search, Undo2, Upload, X } from 'lucide-react';
import { Panel, PanelGroup, PanelResizeHandle } from 'react-resizable-panels';
import { CommitGraph } from './components/CommitGraph';
import { CommitMenu } from './components/CommitMenu';
import { askConfirm, askFlow, DialogHost } from './components/Dialogs';
import { DetailsPanel, type ChangedFile } from './components/DetailsPanel';
import { DiffView } from './components/DiffView';
import { BusyOverlay, Toasts } from './components/Feedback';
import { ConflictPanel, ConflictRow } from './components/ConflictPanel';
import { MergeTool } from './components/MergeTool';
import { SettingsPage, type Section } from './components/Settings';
import { AiPanel } from './components/AiPanel';
import { TerminalPanel } from './components/TerminalPanel';
import { useSettings } from './store/settingsStore';
import { storage } from './lib/storage';
import { ActivityBar, GraphSkeleton, Spinner } from './components/Loading';
import { FileRail } from './components/FileRail';
import { Sidebar } from './components/Sidebar';
import { RepoBranchDropdown } from './components/RepoBranchDropdown';
import { PushDialog } from './components/PushDialog';
import { CloneDialog } from './components/CloneDialog';
import { RepoGroup } from './components/RepoGroup';
import { ActivityLog } from './components/ActivityLog';
import { StashView } from './components/StashView';
import { ProfilePicker } from './components/ProfilePicker';
import { WorkingChangesPanel, type WorkingFile } from './components/WorkingChangesPanel';
import { useRepo } from './store/repoStore';
import { AgentCheckpoints } from './components/AgentCheckpoints';
import type { ScanProgress, ScanResult } from './shared/repositoryScan';

let restored = false;
const Handle = () => <PanelResizeHandle className="w-px bg-surface transition-colors hover:bg-[#4cc2ff]" />;

function ToolBtn({ icon, label, onClick, disabled, busy }: { icon: React.ReactNode; label: string; onClick?: () => void; disabled?: boolean; busy?: boolean }) {
  return (
    <button
      disabled={disabled || busy}
      onClick={onClick}
      aria-label={label}
      aria-busy={busy}
      title={label}
      className={`flex min-h-[52px] w-[60px] flex-col items-center justify-center gap-1 rounded-md text-[12px] ${disabled ? 'text-sub/40' : 'hover:bg-surface/60'}`}
    >
      {busy ? <Spinner size={22} className="text-[#4cc2ff]" /> : icon}
      {label}
    </button>
  );
}

export default function App() {
  const { repoPath, recentRepos, graph, status, selectedHash, search, refs, busy, working, loading, operation, conflictView, conflictFile, openConflict, hasMore, loadingMore, loadMore, openRepo, closeRepo, select, setSearch, checkout, checkoutRemote, action, exec, refreshStatus, ensureCommitVisible } = useRepo();
  const [ctx, setCtx] = useState<{ x: number; y: number; hash: string; hashes?: string[]; ref?: { name: string; kind: 'local' | 'remote' } } | null>(null);
  const [selectedHashes, setSelectedHashes] = useState<string[]>([]);
  const [file, setFile] = useState<ChangedFile | null>(null);
  const [workingView, setWorkingView] = useState(true);
  const [stashView, setStashView] = useState<{ id: string; message: string } | null>(null);
  const [workingFile, setWorkingFile] = useState<WorkingFile | null>(null);
  const [workingRevision, setWorkingRevision] = useState(0);
  const [navigation, setNavigation] = useState<{ hash: string; id: number } | null>(null);
  const navigationSeq = useRef(0);
  const attemptedHead = useRef('');
  const [termOpen, setTermOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsSection, setSettingsSection] = useState<Section>('general');
  const [aiOpen, setAiOpen] = useState(false);
  const [cloneOpen, setCloneOpen] = useState(false);
  const [addRepoOpen, setAddRepoOpen] = useState(false);
  const [draggingFolders, setDraggingFolders] = useState(false);
  const [scanningFolders, setScanningFolders] = useState(false);
  const [scanProgress, setScanProgress] = useState<ScanProgress | null>(null);
  const [cancellingScan, setCancellingScan] = useState(false);
  const scanRequest = useRef<{ id: string; cancelled: boolean } | null>(null);
  const dragDepth = useRef(0);
  const [groupMenu, setGroupMenu] = useState<{ repo: string; x: number; y: number } | null>(null);
  const [newGroup, setNewGroup] = useState<string | null>(null);
  const [pushRepo, setPushRepo] = useState<string | null>(null);
  const autoFetchMinutes = useSettings((s) => s.autoFetchMinutes);
  const { indexUndo, indexRedo, moveIndexHistory } = useRepo();
  const theme = useSettings((s) => s.theme);
  const repoGroups = useSettings((s) => s.repoGroups);
  const repoGroupRoots = useSettings((s) => s.repoGroupRoots);
  const setRepoGroupRoot = useSettings((s) => s.setRepoGroupRoot);
  const setRepoGroup = useSettings((s) => s.setRepoGroup);
  useEffect(() => { document.documentElement.dataset.theme = theme; }, [theme]);

  // reopen last session's tabs, then keep the saved list in sync (via subscribe, so the first render can't overwrite it)
  useEffect(() => {
    if (restored) return;
    restored = true;
    try {
      const raw = storage.getItem('gitverse.tabs');
      if (useSettings.getState().rememberTabs && raw) {
        const { repos, active } = JSON.parse(raw) as { repos?: string[]; active?: string | null };
        if (repos?.length) { useRepo.setState({ recentRepos: repos }); if (active) useRepo.getState().openRepo(active); }
      }
    } catch { /* corrupt or unavailable storage: start fresh */ }
    useRepo.subscribe((s, p) => {
      if (s.recentRepos === p.recentRepos && s.repoPath === p.repoPath) return;
      try {
        if (useSettings.getState().rememberTabs) storage.setItem('gitverse.tabs', JSON.stringify({ repos: s.recentRepos, active: s.repoPath }));
        else storage.removeItem('gitverse.tabs');
      } catch { /* ignore */ }
    });
  }, []);

  // background auto-fetch
  useEffect(() => {
    if (!autoFetchMinutes || !repoPath) return;
    const t = setInterval(() => { if (!document.hidden) useRepo.getState().autoFetch(); }, autoFetchMinutes * 60_000);
    return () => clearInterval(t);
  }, [autoFetchMinutes, repoPath]);
  useEffect(() => { setFile(null); }, [repoPath, selectedHash]);
  useEffect(() => { setWorkingView(true); setWorkingFile(null); setStashView(null); setSelectedHashes([]); }, [repoPath]);
  useEffect(() => {
    if (!repoPath) return;
    const refresh = () => {
      const state = useRepo.getState();
      if (!document.hidden && !state.working && !state.loading && !state.loadingMore) void refreshStatus();
    };
    window.addEventListener('focus', refresh);
    document.addEventListener('visibilitychange', refresh);
    const timer = window.setInterval(refresh, 5000);
    return () => { window.removeEventListener('focus', refresh); document.removeEventListener('visibilitychange', refresh); window.clearInterval(timer); };
  }, [repoPath, refreshStatus]);
  const showWorking = () => { setFile(null); setWorkingFile(null); setSelectedHashes([]); setStashView(null); setWorkingView(true); useRepo.setState({ conflictView: false, conflictFile: null }); void refreshStatus(); };
  const refreshWorking = async () => { await refreshStatus(); setWorkingRevision((v) => v + 1); };
  const branch = refs.local.find((b) => b.current)?.name;
  const headHash = refs.headHash ?? graph.rows.find((r) => r.commit.refs.some((ref) => ref.current))?.commit.hash ?? null;
  const detached = !branch && graph.rows.some((row) => row.commit.refs.some((ref) => ref.kind === 'head' && ref.current));
  const current = branch ?? (operation?.head && operation.head !== 'HEAD' ? operation.head : detached ? 'Detached HEAD' : '—');
  const dis = !repoPath;

  useEffect(() => {
    if (!repoPath || !headHash || !status.length || loading || loadingMore || !graph.rows.length || graph.rows.some((r) => r.commit.hash === headHash)) return;
    const key = `${repoPath}\0${headHash}`;
    if (attemptedHead.current === key) return;
    attemptedHead.current = key;
    void ensureCommitVisible(headHash);
  }, [repoPath, headHash, status.length, loading, loadingMore, graph.rows, ensureCommitVisible]);

  const navigateToHash = async (hash: string) => {
    const id = ++navigationSeq.current;
    const cwd = repoPath;
    setFile(null); setWorkingFile(null); setStashView(null);
    if (!await ensureCommitVisible(hash) || id !== navigationSeq.current || useRepo.getState().repoPath !== cwd) return;
    setSearch('');
    setNavigation({ hash, id });
  };
  const navigateBranch = (kind: 'local' | 'remote', name: string) => {
    const ref = refs[kind].find((item) => item.name === name);
    const hash = ref?.hash ?? graph.rows.find((row) => row.commit.refs.some((item) => item.kind === kind && item.name === name))?.commit.hash;
    if (hash) void navigateToHash(hash);
    else useRepo.getState().notify('error', 'Could not locate branch', 'Refresh the repository and try again.');
  };

  const navigateTag = async (name: string) => {
    const cwd = repoPath;
    if (!cwd) return;
    try {
      const hash: string = await (window as any).gitApi.tagCommit(cwd, name);
      if (useRepo.getState().repoPath === cwd) await navigateToHash(hash);
    } catch (error: any) { useRepo.getState().notify('error', 'Could not locate tag', String(error?.message ?? error).replace(/^Error invoking remote method '[^']*': (Error: )?/, '')); }
  };

  const searchRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'f') { e.preventDefault(); searchRef.current?.focus(); }
      if (e.key === 'Escape') { setCtx(null); setAddRepoOpen(false); setGroupMenu(null); }
      if (e.ctrlKey && e.key === '`') { e.preventDefault(); setTermOpen((v) => !v); }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'j') { e.preventDefault(); setAiOpen((v) => !v); }
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, []);
  const newBranch = async () => {
    const name = await askFlow(refs.local.map((b) => b.name), current === '—' ? 'the current checkout' : current);
    if (name) exec('createBranch', name);
  };

  const importFolders = async (paths: string[]) => {
    if (scanRequest.current) return;
    const api = (window as any).gitApi;
    if (!paths.length) { useRepo.getState().notify('error', 'Could not read dropped folders', 'Please drop folders from your file manager.'); return; }
    setScanningFolders(true);
    setScanProgress(null);
    setCancellingScan(false);
    const request = { id: crypto.randomUUID(), cancelled: false };
    scanRequest.current = request;
    const unsubscribe = api.onScanProgress((id: string, progress: ScanProgress) => {
      if (id === request.id) setScanProgress(progress);
    });
    try {
      const found: string[] = [];
      for (const folder of paths) {
        if (request.cancelled) break;
        try {
          const result: ScanResult = await api.findRepositories(folder, request.id);
          if (result.cancelled || request.cancelled) break;
          if (!result.repos.length) useRepo.getState().notify('warning', 'No repositories found', folder);
          if (result.skipped) useRepo.getState().notify('warning', 'Some folders could not be scanned', `${result.skipped} folders could not be read or verified as repositories.`);
          const nested = result.repos.filter((repo) => repo !== result.root);
          if (nested.length) {
            const existing = useSettings.getState().repoGroups;
            let group = result.group || 'Repositories';
            const base = group;
            let suffix = 2;
            const belongsToRoot = (repo: string) => repo === result.root || repo.startsWith(result.root.replace(/[\\/]+$/, '') + (result.root.includes('\\') ? '\\' : '/'));
            while (Object.entries(existing).some(([repo, name]) => name === group && !belongsToRoot(repo))) group = `${base} (${suffix++})`;
            setRepoGroupRoot(group, result.root);
            for (const repo of result.repos) setRepoGroup(repo, group);
          }
          if (request.cancelled) useRepo.getState().notify('info', 'Folder scan cancelled', 'Results from the interrupted folder were not added. Completed folders are kept.');
          found.push(...result.repos);
        } catch (error: any) {
          useRepo.getState().notify('error', 'Could not scan folder', String(error?.message ?? error).replace(/^Error invoking remote method '[^']*': (Error: )?/, ''));
        }
      }
      const repos = [...new Set(found)];
      if (repos.length) {
        useRepo.setState((state) => ({ recentRepos: [...new Set([...state.recentRepos, ...repos])] }));
        await openRepo(repos[0]);
        useRepo.getState().notify('success', `Added ${repos.length} repositor${repos.length === 1 ? 'y' : 'ies'}`);
      }
    } finally { unsubscribe(); scanRequest.current = null; setScanningFolders(false); setScanProgress(null); setCancellingScan(false); }
  };
  const cancelFolderScan = () => {
    const request = scanRequest.current;
    if (!request || request.cancelled) return;
    request.cancelled = true;
    setCancellingScan(true);
    (window as any).gitApi.cancelScan(request.id);
  };
  const dropFolders = (event: React.DragEvent) => {
    event.preventDefault();
    dragDepth.current = 0;
    setDraggingFolders(false);
    const api = (window as any).gitApi;
    const paths = Array.from(event.dataTransfer.files).map((file) => api?.pathForFile?.(file)).filter(Boolean) as string[];
    void importFolders(paths);
  };

  return (
    <div className="flex h-full flex-col" onClick={() => { setCtx(null); setGroupMenu(null); }}
      onDragEnter={(e) => { if (e.dataTransfer.types.includes('Files')) { e.preventDefault(); dragDepth.current++; setDraggingFolders(true); } }}
      onDragOver={(e) => { if (e.dataTransfer.types.includes('Files')) { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; } }}
      onDragLeave={(e) => { e.preventDefault(); if (--dragDepth.current <= 0) { dragDepth.current = 0; setDraggingFolders(false); } }}
      onDrop={(e) => void dropFolders(e)}>
      {(draggingFolders || scanningFolders) && <div className={`fixed inset-0 z-[80] flex items-center justify-center bg-crust/80 ${scanningFolders ? '' : 'pointer-events-none'}`}>
        <div className="mx-4 w-full max-w-[560px] rounded-xl border-2 border-dashed border-[#4cc2ff] bg-mantle p-8 text-center shadow-2xl">
          <div role="status" aria-live="polite">
            <h2 className="text-lg font-semibold">{scanningFolders ? 'Finding repositories…' : 'Drop folders to open repositories'}</h2>
            {scanningFolders && <>
              <p className="mt-3 text-sm text-sub">{(scanProgress?.scanned ?? 0).toLocaleString()} folders scanned · {(scanProgress?.repositories ?? 0).toLocaleString()} repositories found</p>
              <p className="mt-2 break-all text-xs text-sub">{scanProgress?.folder}</p>
              <p className="mt-3 text-sm text-sub">No folder or depth limit. Hidden, dependency and symlink folders are skipped.</p>
            </>}
          </div>
          {scanningFolders && <button autoFocus disabled={cancellingScan} onClick={cancelFolderScan} className="mt-5 min-h-[44px] rounded-md border border-surface px-5 text-sm hover:bg-surface/60 disabled:opacity-50">{cancellingScan ? 'Cancelling…' : 'Cancel scan'}</button>}
        </div>
      </div>}
      {/* repo tabs */}
      <div className="flex items-center border-b border-surface bg-crust">
        <div className="flex items-center gap-2 border-r border-surface px-4 text-[14px] font-bold tracking-wide" aria-label="GITVerse">
          <GitBranch size={16} className="text-[#4cc2ff]" aria-hidden /> GIT<span className="text-[#4cc2ff]">Verse</span>
        </div>
        {recentRepos.map((r, index) => {
          const group = repoGroups[r] || '';
          if (group && recentRepos.findIndex((path) => repoGroups[path] === group) !== index) return null;
          const repos = group ? recentRepos.filter((path) => repoGroups[path] === group) : [r];
          if (group) return <RepoGroup key={group} name={group} repos={repos} root={repoGroupRoots[group]} current={repoPath} onOpen={(path) => void openRepo(path)} onCloseRepo={closeRepo} onContext={(repo, x, y) => { setNewGroup(null); setGroupMenu({ repo, x, y }); }} onDelete={async () => {
            if (!await askConfirm('Delete group', `Remove “${group}” and close its repositories? No files will be deleted from disk.`, { label: 'Delete group' })) return;
            const state = useRepo.getState();
            const members = state.recentRepos.filter((repo) => useSettings.getState().repoGroups[repo] === group);
            for (const repo of members) if (repo !== state.repoPath) state.closeRepo(repo);
            if (state.repoPath && members.includes(state.repoPath)) state.closeRepo(state.repoPath);
            useSettings.getState().deleteRepoGroup(group);
          }} />;
          return <div key={r} onClick={() => openRepo(r)} onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); setNewGroup(null); setGroupMenu({ repo: r, x: e.clientX, y: e.clientY }); }} title={`${r} — right-click to organize groups`} className={`group relative flex min-h-[44px] max-w-[220px] cursor-pointer items-center gap-2 border-r border-surface px-5 text-[15px] ${r === repoPath ? 'bg-mantle text-text after:absolute after:inset-x-0 after:bottom-0 after:h-[2px] after:bg-[#4cc2ff]' : 'text-sub hover:bg-mantle/60 hover:text-text'}`}>
            <GitBranch size={15} /><span className="truncate">{r.split('/').pop()}</span><button aria-label={`Close ${r.split('/').pop()}`} className="rounded p-0.5 opacity-0 hover:bg-surface hover:text-[#f38ba8] focus:opacity-100 group-hover:opacity-100" onClick={(e) => { e.stopPropagation(); closeRepo(r); }}><X size={14} /></button>
          </div>;
        })}
        <button className="px-3 py-2 text-sub hover:text-text" title="Add repository" aria-label="Add repository" onClick={() => setAddRepoOpen(true)}><Plus size={17} /></button>
        <ProfilePicker onManage={() => { setSettingsSection('profiles'); setSettingsOpen(true); }} />
        <button onClick={() => { setSettingsSection('general'); setSettingsOpen((v) => !v); }} aria-pressed={settingsOpen} aria-label="Preferences" title="Preferences" className={`mr-2 flex h-9 w-9 items-center justify-center rounded-md ${settingsOpen ? 'bg-[#4cc2ff]/20 text-[#4cc2ff]' : 'text-sub hover:bg-surface hover:text-text'}`}>
          <GearIcon size={18} aria-hidden />
        </button>
      </div>

      {settingsOpen ? <div className="min-h-0 flex-1"><SettingsPage initial={settingsSection} onExit={() => { setSettingsOpen(false); setSettingsSection('general'); }} /></div> : (<>
      {/* toolbar */}
      <header className="flex items-center gap-1 border-b border-surface bg-mantle px-5 py-2">
        <RepoBranchDropdown current={current} />
        <div className="mx-5 h-9 w-px bg-surface" aria-hidden />
        <div className="flex">
          <span title="Undo the last stage or unstage action"><ToolBtn icon={<Undo2 size={22} />} label="Undo" disabled={!indexUndo || !!working} onClick={() => { void moveIndexHistory('undo').then(() => setWorkingFile(null)); }} /></span>
          <span title="Redo the last undone stage or unstage action"><ToolBtn icon={<Redo2 size={22} />} label="Redo" disabled={!indexRedo || !!working} onClick={() => { void moveIndexHistory('redo').then(() => setWorkingFile(null)); }} /></span>
        </div>
        <div className="mx-3 h-9 w-px bg-surface" aria-hidden />
        <div className="flex">
          <ToolBtn icon={<Download size={22} />} label="Fetch" disabled={dis} busy={busy === 'fetch'} onClick={() => action('fetch')} />
          <ToolBtn icon={<ArrowDownToLine size={22} />} label="Pull" disabled={dis} busy={busy === 'pull'} onClick={() => action('pull')} />
          <ToolBtn icon={<Upload size={22} />} label="Push" disabled={dis} busy={working === 'Pushing…'} onClick={() => setPushRepo(repoPath)} />
          <ToolBtn icon={<GitBranch size={22} />} label="Branch" disabled={dis} busy={working === 'Creating branch…'} onClick={newBranch} />
          <ToolBtn icon={<Archive size={22} />} label="Stash" disabled={dis} busy={busy === 'stash'} onClick={() => action('stash')} />
          <ToolBtn icon={<ArchiveRestore size={22} />} label="Pop" disabled={dis || !refs.stashes.length} busy={busy === 'stashPop'} onClick={() => action('stashPop')} />
        </div>
        <div className="mx-3 h-9 w-px bg-surface" aria-hidden />
        <button onClick={() => setTermOpen((v) => !v)} aria-pressed={termOpen} aria-label="Terminal" title="Terminal (Ctrl+`)" className={`flex min-h-[52px] w-[68px] flex-col items-center justify-center gap-1 rounded-md text-[12px] ${termOpen ? 'bg-[#4cc2ff]/15 text-[#4cc2ff]' : 'hover:bg-surface/60'}`}>
          <SquareTerminal size={22} aria-hidden />
          Terminal
        </button>
        <button onClick={() => setAiOpen((v) => !v)} aria-pressed={aiOpen} aria-label="Ask AI" title="Ask AI (⌘J)" className={`flex min-h-[52px] w-[68px] flex-col items-center justify-center gap-1 rounded-md border border-[#a855f7]/40 bg-gradient-to-br from-[#9333ea]/20 to-[#4cc2ff]/10 text-[12px] font-semibold text-[#b86bef] hover:border-[#a855f7] hover:brightness-110 ${aiOpen ? 'ring-1 ring-[#a855f7]' : ''}`}>
          <Sparkles size={22} aria-hidden />
          Ask AI
        </button>
        <div className="relative ml-auto">
          <Search size={13} className="absolute left-2.5 top-3 text-sub" aria-hidden />
          <input ref={searchRef} aria-label="Search commits" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search hash, message, author" className="w-72 rounded-md border border-transparent bg-surface py-2 pl-8 pr-12 outline-none placeholder:text-sub focus:border-[#4cc2ff]" />{search ? <button aria-label="Clear search" className="absolute right-1 top-1 rounded p-1.5 text-sub hover:text-text" onClick={() => setSearch('')}><X size={14} /></button> : <kbd className="absolute right-2 top-2 rounded border border-sub/40 px-1.5 text-[11px] text-sub">⌘F</kbd>}
        </div>
      </header>
      <ActivityBar />
      {detached && !operation && !loading && (
        <div role="status" className="border-b border-[#f9e2af]/25 bg-[#f9e2af]/10 px-5 py-2 text-[13px] text-[#f9e2af]">
          Detached HEAD: a commit is checked out without a branch. Double-click a local branch in the sidebar to check it out, or create a branch from this commit.
        </div>
      )}
      <PanelGroup direction="horizontal" className="min-h-0 flex-1">
        {file || workingFile || conflictFile ? <FileRail onExpand={() => { setFile(null); setWorkingFile(null); openConflict(null); }} /> : <Panel defaultSize={20} minSize={12}>{repoPath && <Sidebar onNavigate={navigateBranch} onTag={(name) => void navigateTag(name)} onStash={(stash) => { setFile(null); setWorkingFile(null); setWorkingView(false); setSelectedHashes([]); setStashView(stash); }} onContext={(kind, name, x, y) => {
          const hash = refs[kind].find((ref) => ref.name === name)?.hash;
          if (hash) setCtx({ x, y, hash, ref: { kind, name } });
          else useRepo.getState().notify('error', 'Could not locate branch', 'Refresh the repository and try again.');
        }} />}</Panel>}
        {!file && !workingFile && !conflictFile && <Handle />}
        <Panel defaultSize={55} minSize={30}>
          {/* center column: graph / diff / merge tool on top, terminal underneath */}
          <PanelGroup direction="vertical">
            <Panel minSize={20}>
              <div className="flex h-full flex-col">
                {!conflictFile && !file && <ConflictRow />}
                {repoPath && !conflictFile && !file && !workingFile && !stashView && <AgentCheckpoints key={repoPath} repo={repoPath} />}
                <div className="min-h-0 flex-1">
                  {conflictFile ? <MergeTool path={conflictFile} /> : stashView && repoPath ? <StashView repo={repoPath} stash={stashView} onClose={() => setStashView(null)} /> : workingFile && workingView && repoPath ? <DiffView repoPath={repoPath} hash="" file={workingFile} area={workingFile.area} revision={workingRevision} onClose={() => setWorkingFile(null)} /> : file && repoPath && selectedHash ? <DiffView repoPath={repoPath} hash={selectedHash} file={file} onClose={() => setFile(null)} onJumpToCommit={select} /> : graph.rows.length ? (
                    <CommitGraph
                      layout={graph}
                      selectedHash={workingView ? null : selectedHash}
                      selectedHashes={workingView ? [] : selectedHashes}
                      filter={search}
                      hasMore={hasMore}
                      loadingMore={loadingMore}
                      onLoadMore={loadMore}
                      headHash={headHash}
                      changeCount={status.length}
                      stagedCount={status.filter((f) => f.index !== ' ' && f.index !== '?' && !['DD', 'AU', 'UD', 'UA', 'DU', 'AA', 'UU'].includes(f.index + f.worktree)).length}
                      wipSelected={workingView}
                      onSelectWip={showWorking}
                      navigate={navigation}
                      onLocateCurrent={() => { if (headHash) void navigateToHash(headHash); }}
                      onSelect={(hash, hashes) => { setWorkingView(false); setWorkingFile(null); setStashView(null); setSelectedHashes(hashes); select(hash); }}
                      onContextMenu={(hash, x, y) => setCtx({ hash, x, y, hashes: selectedHashes.includes(hash) ? selectedHashes : [hash] })}
                      onDoubleClick={(r) => {
                        if (!r.current && r.kind === 'local') checkout(r.name);
                        else if (r.kind === 'remote') checkoutRemote(r.name);
                      }}
                    />
                  ) : loading ? (
                    <GraphSkeleton />
                  ) : (
                    <div className="flex h-full flex-col items-center justify-center gap-3 text-sub">
                      <GitBranch size={36} aria-hidden />
                      <div>{repoPath ? 'No commits yet' : 'Welcome to GITVerse — open a repository to see its history'}</div>
                      {!repoPath && <button className="rounded bg-[#4cc2ff] px-4 py-2 font-medium text-crust" onClick={() => setAddRepoOpen(true)}>Add repository</button>}
                    </div>
                  )}
                </div>
              </div>
            </Panel>
            {termOpen && (
              <>
                <PanelResizeHandle className="h-px bg-surface transition-colors hover:bg-[#4cc2ff]" />
                <Panel defaultSize={32} minSize={12}>
                  <TerminalPanel cwd={repoPath} onHide={() => setTermOpen(false)} />
                </Panel>
              </>
            )}
          </PanelGroup>
        </Panel>
        <Handle />
        <Panel defaultSize={25} minSize={15} className="bg-mantle">
          {operation && conflictView ? <ConflictPanel /> : stashView ? <div className="p-4"><div className="text-sm text-sub">Stash</div><div className="mt-2 font-semibold">{stashView.id}</div><p className="mt-2 break-words text-sm text-sub">{stashView.message}</p><button onClick={() => setStashView(null)} className="mt-4 rounded border border-surface px-3 py-2 text-sm hover:bg-surface/50">Back to history</button></div> : workingView && repoPath ? <WorkingChangesPanel selected={workingFile} onSelect={setWorkingFile} onClear={() => setWorkingFile(null)} onRefresh={refreshWorking} /> : <div className="flex h-full min-h-0 flex-col">
            {repoPath && status.length > 0 && <div className="flex items-center gap-2 border-b border-surface bg-[#4cc2ff]/15 px-4 py-2 text-[13px]"><span className="min-w-0 flex-1">{status.length} local file change{status.length === 1 ? '' : 's'}</span><button onClick={showWorking} className="shrink-0 rounded border border-[#4cc2ff]/50 px-2 py-1 text-[#4cc2ff] hover:bg-[#4cc2ff]/15">View changes</button></div>}
            <div className="min-h-0 flex-1"><DetailsPanel file={file} onSelectFile={setFile} /></div>
          </div>}
        </Panel>
        {aiOpen && (
          <>
            <Handle />
            <Panel defaultSize={24} minSize={16} className="bg-mantle">
              <AiPanel onClose={() => setAiOpen(false)} onOpenSettings={() => { setSettingsSection('ai'); setSettingsOpen(true); }} />
            </Panel>
          </>
        )}
      </PanelGroup>

      </>)}
      <ActivityLog />
      <DialogHost />
      {groupMenu && <div role="menu" aria-label="Repository groups" onClick={(e) => e.stopPropagation()} className="fixed z-[95] min-w-[220px] rounded-lg border border-surface bg-mantle p-1 shadow-xl" style={{ left: Math.max(8, Math.min(groupMenu.x, window.innerWidth - 240)), top: Math.max(8, Math.min(groupMenu.y, window.innerHeight - 240)) }}>
        <div className="px-3 py-2 text-xs font-semibold uppercase text-sub">Move to group</div>
        {[...new Set(Object.values(repoGroups).filter(Boolean))].map((group) => <button role="menuitem" key={group} onClick={() => { setRepoGroup(groupMenu.repo, group); setGroupMenu(null); }} className="block w-full truncate rounded px-3 py-2 text-left text-sm hover:bg-surface/60">{group}</button>)}
        {repoGroups[groupMenu.repo] && <button role="menuitem" onClick={() => { setRepoGroup(groupMenu.repo, ''); setGroupMenu(null); }} className="block w-full rounded px-3 py-2 text-left text-sm hover:bg-surface/60">Remove from group</button>}
        {newGroup === null ? <button role="menuitem" onClick={() => setNewGroup('')} className="block w-full rounded border-t border-surface px-3 py-2 text-left text-sm text-[#4cc2ff] hover:bg-surface/60">+ New group…</button> : <form onSubmit={(e) => { e.preventDefault(); const group = newGroup.trim(); if (!group) return; setRepoGroup(groupMenu.repo, group); setNewGroup(null); setGroupMenu(null); }} className="space-y-2 border-t border-surface p-2">
          <label htmlFor="new-repo-group" className="block text-xs text-sub">Group name</label>
          <input id="new-repo-group" autoFocus value={newGroup} onChange={(e) => setNewGroup(e.target.value)} placeholder="Group name" className="w-full rounded border border-surface bg-crust px-2 py-1.5 text-sm outline-none focus:border-[#4cc2ff]" />
          <button type="submit" disabled={!newGroup.trim()} className="w-full rounded bg-[#4cc2ff] px-3 py-1.5 text-sm font-medium text-crust disabled:opacity-40">Create group</button>
        </form>}
      </div>}
      {addRepoOpen && <div className="fixed inset-0 z-[90] flex items-center justify-center bg-black/60 p-4" onMouseDown={() => setAddRepoOpen(false)}>
        <section role="dialog" aria-modal="true" aria-labelledby="add-repo-title" onMouseDown={(e) => e.stopPropagation()} className="w-full max-w-[440px] rounded-xl border border-surface bg-mantle p-5 shadow-2xl">
          <div className="mb-4 flex items-start justify-between gap-4"><div><h2 id="add-repo-title" className="text-lg font-semibold">Add repository</h2><p className="mt-1 text-sm text-sub">Open a local folder or clone a remote repository.</p></div><button onClick={() => setAddRepoOpen(false)} aria-label="Close" className="rounded p-1 text-sub hover:bg-surface hover:text-text"><X size={18} /></button></div>
          <div className="space-y-2">
            <button autoFocus onClick={async () => { setAddRepoOpen(false); try { const folder = await (window as any).gitApi.openRepoDialog(); if (folder) void importFolders([folder]); } catch (error: any) { useRepo.getState().notify('error', 'Could not open folder', String(error?.message ?? error)); } }} className="flex w-full items-center gap-3 rounded-lg border border-surface px-4 py-3 text-left hover:bg-surface/50"><FolderOpen size={20} className="shrink-0 text-[#4cc2ff]" /><span><span className="block font-medium">Open local folder</span><span className="block text-sm text-sub">Choose a repository or folder containing repositories</span></span></button>
            <button onClick={() => { setAddRepoOpen(false); setCloneOpen(true); }} className="flex w-full items-center gap-3 rounded-lg border border-surface px-4 py-3 text-left hover:bg-surface/50"><Download size={20} className="shrink-0 text-[#4cc2ff]" /><span><span className="block font-medium">Clone repository</span><span className="block text-sm text-sub">Clone from an HTTPS or SSH URL</span></span></button>
          </div>
        </section>
      </div>}
      {cloneOpen && <CloneDialog onClose={() => setCloneOpen(false)} />}
      {pushRepo && <PushDialog repo={pushRepo} onClose={() => setPushRepo(null)} />}
      <Toasts />
      <BusyOverlay />
      {ctx && <CommitMenu x={ctx.x} y={ctx.y} hash={ctx.hash} hashes={ctx.hashes} current={current} targetRef={ctx.ref} onPush={() => { if (repoPath) setPushRepo(repoPath); }} onClose={() => setCtx(null)} />}
    </div>
  );
}
