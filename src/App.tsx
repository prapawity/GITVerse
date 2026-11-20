import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Sparkles,
  Settings as GearIcon,
  SquareTerminal,
  GitPullRequest,
  ArchiveRestore,
  Archive,
  ArrowDownToLine,
  ChevronDown,
  Download,
  FolderOpen,
  GitBranch,
  GitFork,
  History,
  Plus,
  Redo2,
  Search,
  Undo2,
  Upload,
  X,
  ListOrdered,
} from 'lucide-react';
import { Panel, Group, Separator } from 'react-resizable-panels';
import { CommitGraph } from './components/CommitGraph';
import { CommitMenu } from './components/CommitMenu';
import { askConfirm, askFlow, askText, DialogHost } from './components/Dialogs';
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
import { reorderRepoTabs } from './lib/reorderRepoTabs';
import { checkoutRemoteWithSparseRecovery } from './lib/checkoutRemoteFlow';
import { ActivityBar, GraphSkeleton, Spinner } from './components/Loading';
import { FileRail } from './components/FileRail';
import { Sidebar } from './components/Sidebar';
import { RepoBranchDropdown } from './components/RepoBranchDropdown';
import { PushDialog } from './components/PushDialog';
import { PullRequestDialog } from './components/PullRequestDialog';
import { GraphFilterBar } from './components/GraphFilterBar';
import { CombinedChanges, consecutiveRange } from './components/CombinedChanges';
import { CommandPalette, ShortcutList, type PaletteCommand } from './components/CommandPalette';
import { CloneDialog } from './components/CloneDialog';
import { RepoGroup } from './components/RepoGroup';
import { ActivityLog } from './components/ActivityLog';
import { StashView } from './components/StashView';
import { ProfilePicker } from './components/ProfilePicker';
import { WorkingChangesPanel, type WorkingFile } from './components/WorkingChangesPanel';
import { OPEN_PUSH_DIALOG, OPEN_REQUEST_AFTER_PUSH, useRepo } from './store/repoStore';
import { useResolvedTheme } from './lib/theme';
import { stepZoom, useAppZoom } from './lib/zoom';
import { replay, snapshot, useActionHistory } from './lib/actionHistory';
import { AgentCheckpoints } from './components/AgentCheckpoints';
import { RecoveryPanel } from './components/RecoveryPanel';
import { RebasePreview } from './components/RebasePreview';
import { WorkspaceInspectionPanel } from './components/WorkspaceInspectionPanel';
import type { ScanProgress, ScanResult } from './shared/repositoryScan';
import type { StashRef } from './shared/types';
import { platformApi, desktopApi } from './platform/api';

let restored = false;
const shortcutModifier = /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘' : 'Ctrl+';
const Handle = () => <Separator className="w-px bg-surface transition-colors hover:bg-accent" />;

function ToolBtn({
  icon,
  label,
  onClick,
  disabled,
  busy,
}: {
  icon: React.ReactNode;
  label: string;
  onClick?: () => void;
  disabled?: boolean;
  busy?: boolean;
}) {
  return (
    <button
      disabled={disabled || busy}
      onClick={onClick}
      aria-label={label}
      aria-busy={busy}
      title={label}
      className={`ui-tool flex min-h-[44px] w-10 flex-col min-[1400px]:min-h-[52px] min-[1400px]:w-[60px] items-center justify-center gap-1 rounded-md text-xs ${disabled ? 'text-sub/40' : 'hover:bg-surface/60'}`}
    >
      {busy ? <Spinner size={22} className="text-accent" /> : icon}
      <span className="ui-label hidden min-[1400px]:block">{label}</span>
    </button>
  );
}

export default function App() {
  const {
    repoPath,
    recentRepos,
    graph,
    status,
    selectedHash,
    search,
    refs,
    busy,
    working,
    loading,
    operation,
    conflictView,
    conflictFile,
    openConflict,
    hasMore,
    loadingMore,
    loadMore,
    openRepo,
    closeRepo,
    select,
    setSearch,
    checkout,
    action,
    exec,
    refreshStatus,
    ensureCommitVisible,
  } = useRepo();
  const [ctx, setCtx] = useState<{
    x: number;
    y: number;
    hash: string;
    hashes?: string[];
    ref?: { name: string; kind: 'local' | 'remote' };
  } | null>(null);
  const [selectedHashes, setSelectedHashes] = useState<string[]>([]);
  // two or more consecutive commits selected: show their combined changes
  const range = useMemo(() => consecutiveRange(selectedHashes, graph.rows), [selectedHashes, graph.rows]);
  const [file, setFile] = useState<ChangedFile | null>(null);
  const [workingView, setWorkingView] = useState(true);
  const [stashView, setStashView] = useState<StashRef | null>(null);
  const [workingFile, setWorkingFile] = useState<WorkingFile | null>(null);
  const [workingRevision, setWorkingRevision] = useState(0);
  const [navigation, setNavigation] = useState<{ hash: string; id: number } | null>(null);
  const navigationSeq = useRef(0);
  const openedHead = useRef<string | null>(null);
  const [termOpen, setTermOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [recoveryOpen, setRecoveryOpen] = useState(false);
  const [workspaceInspectionOpen, setWorkspaceInspectionOpen] = useState(false);
  // Esc closes the Recovery / Workspace side panel, unless a dialog or menu handled it first
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      if (document.querySelector('[role="dialog"], [role="menu"]')) return;
      setRecoveryOpen(false);
      setWorkspaceInspectionOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  const [rebasePreviewOpen, setRebasePreviewOpen] = useState(false);
  const [settingsSection, setSettingsSection] = useState<Section>('general');
  const [aiOpen, setAiOpen] = useState(false);
  useEffect(() => {
    if (!aiOpen) return;
    setRecoveryOpen(false);
    setWorkspaceInspectionOpen(false);
  }, [aiOpen]);
  const [cloneOpen, setCloneOpen] = useState(false);
  const [addRepoOpen, setAddRepoOpen] = useState(false);
  const addRepoDialogRef = useRef<HTMLElement>(null);
  const addRepoOpenerRef = useRef<HTMLElement | null>(null);
  const openAddRepo = () => {
    addRepoOpenerRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setAddRepoOpen(true);
  };
  const closeAddRepo = (restoreFocus = true) => {
    setAddRepoOpen(false);
    if (restoreFocus) requestAnimationFrame(() => addRepoOpenerRef.current?.focus());
  };
  useEffect(() => {
    if (addRepoOpen) addRepoDialogRef.current?.querySelector<HTMLElement>('button:not([disabled])')?.focus();
  }, [addRepoOpen]);
  const [draggingFolders, setDraggingFolders] = useState(false);
  const [scanningFolders, setScanningFolders] = useState(false);
  const [scanProgress, setScanProgress] = useState<ScanProgress | null>(null);
  const [cancellingScan, setCancellingScan] = useState(false);
  const scanRequest = useRef<{ id: string; cancelled: boolean } | null>(null);
  const dragDepth = useRef(0);
  const draggedTab = useRef<string | null>(null);
  const [dropTab, setDropTab] = useState<{ target: string; after: boolean } | null>(null);
  const suppressTabClick = useRef(false);
  const [groupMenu, setGroupMenu] = useState<{ repo: string; x: number; y: number } | null>(null);
  const [newGroup, setNewGroup] = useState<string | null>(null);
  const [pushRepo, setPushRepo] = useState<string | null>(null);
  const [pullRequestRepo, setPullRequestRepo] = useState<string | null>(null);
  // reload history when refs are hidden / soloed for the open repository
  const graphHiddenKey = useSettings((s) => (repoPath ? (s.graphHidden[repoPath] ?? []).join('\n') : ''));
  const graphSoloKey = useSettings((s) => (repoPath ? (s.graphSolo[repoPath] ?? []).join('\n') : ''));
  const firstScope = useRef(true);
  useEffect(() => {
    if (firstScope.current) {
      firstScope.current = false;
      return;
    }
    if (repoPath) void useRepo.getState().refresh(true);
  }, [graphHiddenKey, graphSoloKey]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const openAfterPush = (event: Event) => setPullRequestRepo((event as CustomEvent<string>).detail);
    const openPush = (event: Event) => setPushRepo((event as CustomEvent<string>).detail);
    window.addEventListener(OPEN_REQUEST_AFTER_PUSH, openAfterPush);
    window.addEventListener(OPEN_PUSH_DIALOG, openPush);
    return () => {
      window.removeEventListener(OPEN_REQUEST_AFTER_PUSH, openAfterPush);
      window.removeEventListener(OPEN_PUSH_DIALOG, openPush);
    };
  }, []);
  const autoFetchMinutes = useSettings((s) => s.autoFetchMinutes);
  const fetchMode = useSettings((s) => s.fetchMode);
  const { indexUndo, indexRedo, moveIndexHistory } = useRepo();
  const theme = useResolvedTheme();
  useAppZoom();
  const fontSize = useSettings((s) => s.fontSize);
  const uiMode = useSettings((s) => s.uiMode);
  const repoGroups = useSettings((s) => s.repoGroups);
  const syncingGroups = useRepo((s) => s.syncingGroups);
  const repoGroupRoots = useSettings((s) => s.repoGroupRoots);
  const setRepoGroupRoot = useSettings((s) => s.setRepoGroupRoot);
  const setRepoGroup = useSettings((s) => s.setRepoGroup);
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);
  useEffect(() => {
    document.documentElement.dataset.ui = uiMode;
  }, [uiMode]);
  useEffect(() => {
    document.documentElement.style.setProperty('--ui-font-scale', String(fontSize / 14));
  }, [fontSize]);
  useEffect(() => {
    const syncGroups = async () => {
      if (document.hidden) return;
      const settings = useSettings.getState();
      const groups = new Set(
        useRepo
          .getState()
          .recentRepos.map((repo) => settings.repoGroups[repo])
          .filter(Boolean),
      );
      for (const group of groups) await useRepo.getState().syncRepoGroup(group, false);
    };
    window.addEventListener('focus', syncGroups);
    document.addEventListener('visibilitychange', syncGroups);
    return () => {
      window.removeEventListener('focus', syncGroups);
      document.removeEventListener('visibilitychange', syncGroups);
    };
  }, []);

  // reopen last session's tabs, then keep the saved list in sync (via subscribe, so the first render can't overwrite it)
  useEffect(() => {
    if (restored) return;
    restored = true;
    try {
      const raw = storage.getItem('gitverse.tabs');
      if (useSettings.getState().rememberTabs && raw) {
        const { repos, active } = JSON.parse(raw) as { repos?: string[]; active?: string | null };
        if (repos?.length) {
          useRepo.setState({ recentRepos: repos });
          if (active) useRepo.getState().openRepo(active);
        }
      }
    } catch {
      /* corrupt or unavailable storage: start fresh */
    }
    useRepo.subscribe((s, p) => {
      if (s.recentRepos === p.recentRepos && s.repoPath === p.repoPath) return;
      try {
        if (useSettings.getState().rememberTabs)
          storage.setItem('gitverse.tabs', JSON.stringify({ repos: s.recentRepos, active: s.repoPath }));
        else storage.removeItem('gitverse.tabs');
      } catch {
        /* ignore */
      }
    });
  }, []);

  // background auto-fetch
  useEffect(() => {
    if (!autoFetchMinutes || !repoPath) return;
    const t = setInterval(() => {
      if (!document.hidden) useRepo.getState().autoFetch();
    }, autoFetchMinutes * 60_000);
    return () => clearInterval(t);
  }, [autoFetchMinutes, repoPath]);
  useEffect(() => {
    setFile(null);
  }, [repoPath, selectedHash]);
  useEffect(() => {
    setWorkingView(true);
    setWorkingFile(null);
    setStashView(null);
    setSelectedHashes([]);
  }, [repoPath]);
  useEffect(() => {
    if (!repoPath) return;
    const refresh = () => {
      const state = useRepo.getState();
      if (!document.hidden && !state.working && !state.loading && !state.loadingMore) void refreshStatus();
    };
    window.addEventListener('focus', refresh);
    document.addEventListener('visibilitychange', refresh);
    const timer = window.setInterval(refresh, 5000);
    return () => {
      window.removeEventListener('focus', refresh);
      document.removeEventListener('visibilitychange', refresh);
      window.clearInterval(timer);
    };
  }, [repoPath, refreshStatus]);
  const showWorking = () => {
    setFile(null);
    setWorkingFile(null);
    setSelectedHashes([]);
    setStashView(null);
    setWorkingView(true);
    useRepo.setState({ conflictView: false, conflictFile: null });
    void refreshStatus();
  };
  const showStash = (stash: StashRef) => {
    setFile(null);
    setWorkingFile(null);
    setWorkingView(false);
    setSelectedHashes([]);
    setCtx(null);
    setStashView(stash);
    useRepo.setState({ selectedHash: stash.hash ?? null, detail: null, conflictView: false, conflictFile: null });
    if (stash.hash) setNavigation({ hash: stash.hash, id: ++navigationSeq.current });
  };
  useEffect(() => {
    if (!stashView) return;
    const live = refs.stashes.find((stash) =>
      stashView.hash ? stash.hash === stashView.hash : stash.id === stashView.id,
    );
    if (live && live !== stashView) setStashView(live);
    else if (!live) {
      setStashView(null);
      setFile(null);
      setSelectedHashes([]);
      useRepo.setState({ selectedHash: null, detail: null });
    }
  }, [refs.stashes, stashView]);
  const refreshWorking = async () => {
    const cwd = repoPath;
    await refreshStatus();
    if (useRepo.getState().repoPath !== cwd) return;
    setWorkingRevision((v) => v + 1);
    setWorkingFile((current) => {
      if (!current) return null;
      const entry = useRepo.getState().status.find((file) => file.path === current.path);
      if (!entry) return null;
      if (current.area === 'untracked' && entry.index !== '?') return null;
      if (current.area === 'staged' && (entry.index === ' ' || entry.index === '?')) return null;
      if (current.area === 'unstaged' && entry.worktree === ' ') return null;
      return current;
    });
  };
  const currentBranch = refs.local.find((b) => b.current);
  const branch = currentBranch?.name;
  const headHash =
    refs.headHash ?? graph.rows.find((r) => r.commit.refs.some((ref) => ref.current))?.commit.hash ?? null;
  const detached =
    !branch && graph.rows.some((row) => row.commit.refs.some((ref) => ref.kind === 'head' && ref.current));
  const current =
    branch ?? (operation?.head && operation.head !== 'HEAD' ? operation.head : detached ? 'Detached HEAD' : '—');
  const dis = !repoPath;

  const navigateToHash = async (hash: string) => {
    const stash = useRepo.getState().refs.stashes.find((entry) => entry.hash === hash);
    if (stash) {
      setSearch('');
      showStash(stash);
      return true;
    }
    const id = ++navigationSeq.current;
    const cwd = repoPath;
    setFile(null);
    setWorkingFile(null);
    setStashView(null);
    if (!(await ensureCommitVisible(hash)) || id !== navigationSeq.current || useRepo.getState().repoPath !== cwd)
      return false;
    setSearch('');
    setWorkingView(false);
    setSelectedHashes([hash]);
    select(hash);
    setNavigation({ hash, id });
    return true;
  };
  useEffect(() => {
    openedHead.current = null;
  }, [repoPath]);

  useEffect(() => {
    if (!repoPath) return;
    if (loading || loadingMore || !headHash || !graph.rows.length || openedHead.current === repoPath) return;
    openedHead.current = repoPath;
    const id = ++navigationSeq.current;
    void ensureCommitVisible(headHash).then((found) => {
      if (found && id === navigationSeq.current && useRepo.getState().repoPath === repoPath)
        setNavigation({ hash: headHash, id });
    });
  }, [repoPath, loading, loadingMore, headHash, graph.rows, ensureCommitVisible]);

  const navigateBranch = (kind: 'local' | 'remote', name: string) => {
    const ref = refs[kind].find((item) => item.name === name);
    const hash =
      ref?.hash ??
      graph.rows.find((row) => row.commit.refs.some((item) => item.kind === kind && item.name === name))?.commit.hash;
    if (hash) void navigateToHash(hash);
    else useRepo.getState().notify('error', 'Could not locate branch', 'Refresh the repository and try again.');
  };

  const navigateTag = async (name: string) => {
    const cwd = repoPath;
    if (!cwd) return;
    try {
      const hash: string = await desktopApi().tagCommit(cwd, name);
      if (useRepo.getState().repoPath === cwd) await navigateToHash(hash);
    } catch (error: any) {
      useRepo
        .getState()
        .notify(
          'error',
          'Could not locate tag',
          String(error?.message ?? error).replace(/^Error invoking remote method '[^']*': (Error: )?/, ''),
        );
    }
  };

  const searchRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'f') {
        e.preventDefault();
        searchRef.current?.focus();
      }
      if (e.key === 'Escape') {
        setCtx(null);
        setAddRepoOpen(false);
        setGroupMenu(null);
      }
      if (e.ctrlKey && e.key === '`') {
        e.preventDefault();
        setTermOpen((v) => !v);
      }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'j') {
        e.preventDefault();
        setAiOpen((v) => !v);
      }
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, []);
  const newBranch = async () => {
    const name = await askFlow(
      refs.local.map((b) => b.name),
      current === '—' ? 'the current checkout' : current,
    );
    if (name) exec('createBranch', name);
  };

  // ---- command palette (Cmd/Ctrl+P) and shortcut list (Cmd/Ctrl+/) ----
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [editorList, setEditorList] = useState<{ id: string; name: string }[]>([]);
  useEffect(() => {
    if (paletteOpen)
      void platformApi()
        ?.editors?.()
        .then(setEditorList)
        .catch(() => {});
  }, [paletteOpen]);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.altKey) return;
      if (e.key.toLowerCase() === 'p') {
        e.preventDefault();
        setShortcutsOpen(false);
        setPaletteOpen((v) => !v);
      } else if (e.key === '/') {
        e.preventDefault();
        setPaletteOpen(false);
        setShortcutsOpen((v) => !v);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  const shortcuts: [string, string][] = [
    [`${shortcutModifier}P`, 'Command palette'],
    [`${shortcutModifier}/`, 'Keyboard shortcuts'],
    [`${shortcutModifier}F`, 'Search commits'],
    [`${shortcutModifier}J`, 'Ask AI'],
    [`${shortcutModifier}Z / ${shortcutModifier}⇧Z`, 'Undo / redo the last action or staging change'],
    [`${shortcutModifier}= / ${shortcutModifier}- / ${shortcutModifier}0`, 'Zoom in / out / actual size'],
    ['Ctrl+`', 'Toggle terminal'],
    ['Enter / Shift+Enter', 'Locate / check out the focused branch in the sidebar'],
    ['Esc', 'Close menus and side panels'],
  ];
  const openSettingsAt = (section: Section) => {
    setSettingsSection(section);
    setSettingsOpen(true);
  };
  // Undo / Redo: the most recent of a Git action (commit, checkout, reset…) or a staging change
  const actionStacks = useActionHistory((s) => (repoPath ? s.stacks[repoPath] : undefined));
  const lastStagingAt = useActionHistory((s) => s.lastStagingAt);
  const gitUndo = actionStacks?.undo.at(-1);
  const gitRedo = actionStacks?.redo.at(-1);
  const preferGit = (entry: { at: number } | undefined, index: boolean) =>
    !!entry && (!index || entry.at > lastStagingAt);
  const undoTarget = preferGit(gitUndo, indexUndo) ? gitUndo!.label : indexUndo ? 'staging' : null;
  const redoTarget = preferGit(gitRedo, indexRedo) ? gitRedo!.label : indexRedo ? 'staging' : null;
  const runUndo = async (direction: 'undo' | 'redo') => {
    const entry = direction === 'undo' ? gitUndo : gitRedo;
    const index = direction === 'undo' ? indexUndo : indexRedo;
    if (!repoPath) return;
    if (!preferGit(entry, index)) {
      await moveIndexHistory(direction);
      setWorkingFile(null);
      return;
    }
    const state = useRepo.getState();
    try {
      const label = await replay(repoPath, direction, snapshot(state.refs), state.status.length > 0);
      await state.refresh();
      state.notify('success', `${direction === 'undo' ? 'Undid' : 'Redid'} ${label}`);
    } catch (error) {
      state.notify('error', `Could not ${direction}`, String((error as Error)?.message ?? error));
    }
  };
  useEffect(() => {
    // native Edit menu (Electron): undo text in a focused field, otherwise the last action
    const stop = platformApi()?.onEditKey?.((key) => {
      const focused = document.activeElement as HTMLElement | null;
      if (focused?.closest('input, textarea, [contenteditable="true"]')) {
        document.execCommand(key);
        return;
      }
      if (!document.querySelector('[role="dialog"]')) void runUndo(key);
    });
    return () => stop?.();
  });
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.altKey || e.key.toLowerCase() !== 'z') return;
      const target = e.target as HTMLElement | null;
      // text fields keep their own undo
      if (target && (target.closest('input, textarea, [contenteditable="true"]') || target.closest('.xterm'))) return;
      if (document.querySelector('[role="dialog"]')) return;
      e.preventDefault();
      void runUndo(e.shiftKey ? 'redo' : 'undo');
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });
  const paletteCommands = (): PaletteCommand[] => {
    const noRepo = !repoPath;
    const blocked = noRepo || !!working;
    const settings = useSettings.getState();
    const list: PaletteCommand[] = [
      {
        id: 'fetch',
        group: 'Remote',
        title: 'Fetch all remotes',
        disabled: blocked,
        run: () => void action('fetch', 'all'),
      },
      {
        id: 'pull',
        group: 'Remote',
        title: 'Pull (fast-forward only)',
        disabled: blocked,
        run: () => void action('fetch', 'ff-only'),
      },
      {
        id: 'pull-rebase',
        group: 'Remote',
        title: 'Pull (rebase)',
        disabled: blocked,
        run: () => void action('fetch', 'rebase'),
      },
      { id: 'push', group: 'Remote', title: 'Push…', disabled: blocked, run: () => repoPath && setPushRepo(repoPath) },
      {
        id: 'push-tags',
        group: 'Remote',
        title: 'Push all tags to origin',
        disabled: blocked,
        run: () => void exec('pushTag', 'origin', null),
      },
      {
        id: 'pr',
        group: 'Remote',
        title: 'Create pull / merge request…',
        keywords: 'pr mr',
        disabled: noRepo,
        run: () => repoPath && setPullRequestRepo(repoPath),
      },
      { id: 'branch', group: 'Branch', title: 'New branch…', disabled: blocked, run: () => void newBranch() },
      {
        id: 'stash',
        group: 'Changes',
        title: 'Stash changes…',
        disabled: blocked,
        run: async () => {
          const m = await askText('Name this stash', 'e.g. Before refactoring');
          if (m) await action('stash', m);
        },
      },
      {
        id: 'pop',
        group: 'Changes',
        title: 'Pop latest stash',
        disabled: blocked || !refs.stashes.length,
        run: () => void action('stashPop'),
      },
      {
        id: 'undo',
        group: 'Changes',
        title: `Undo ${undoTarget ?? ''}`.trim(),
        shortcut: `${shortcutModifier}Z`,
        disabled: blocked || !undoTarget,
        run: () => void runUndo('undo'),
      },
      {
        id: 'redo',
        group: 'Changes',
        title: `Redo ${redoTarget ?? ''}`.trim(),
        shortcut: `${shortcutModifier}⇧Z`,
        disabled: blocked || !redoTarget,
        run: () => void runUndo('redo'),
      },
      {
        id: 'maintenance',
        group: 'Repository',
        title: 'Run repository maintenance',
        keywords: 'gc clean compact',
        disabled: blocked,
        run: () => setWorkspaceInspectionOpen(true),
      },
      {
        id: 'lfs-pull',
        group: 'Repository',
        title: 'Git LFS: pull files',
        disabled: blocked,
        run: () => void exec('lfsAction', 'pull'),
      },
      {
        id: 'submodules',
        group: 'Repository',
        title: 'Update all submodules',
        disabled: blocked,
        run: () => void exec('submoduleUpdate', null),
      },
      {
        id: 'patch',
        group: 'Repository',
        title: 'Apply patch…',
        disabled: blocked,
        run: () => setWorkspaceInspectionOpen(true),
      },
      {
        id: 'tools',
        group: 'Settings',
        title: 'External diff / merge tools',
        disabled: noRepo,
        run: () => openSettingsAt('tools'),
      },
      { id: 'zoom-in', group: 'View', title: 'Zoom in', shortcut: `${shortcutModifier}=`, run: () => stepZoom('in') },
      {
        id: 'zoom-out',
        group: 'View',
        title: 'Zoom out',
        shortcut: `${shortcutModifier}-`,
        run: () => stepZoom('out'),
      },
      {
        id: 'zoom-reset',
        group: 'View',
        title: 'Actual size',
        shortcut: `${shortcutModifier}0`,
        run: () => stepZoom('reset'),
      },
      ...editorList.map((editor) => ({
        id: `open-in-${editor.id}`,
        group: 'Open in',
        title: `Open repository in ${editor.name}`,
        keywords: 'editor ide',
        disabled: noRepo,
        run: () =>
          repoPath &&
          void desktopApi()
            .openIn(editor.id, repoPath)
            .catch((e: Error) => useRepo.getState().notify('error', `Could not open ${editor.name}`, e.message)),
      })),
      {
        id: 'show-all',
        group: 'Graph',
        title: 'Show all hidden branches and tags',
        disabled: noRepo,
        run: () => repoPath && settings.resetRefVisibility(repoPath),
      },
      {
        id: 'search',
        group: 'Graph',
        title: 'Search commits',
        shortcut: `${shortcutModifier}F`,
        disabled: noRepo,
        run: () => searchRef.current?.focus(),
      },
      {
        id: 'terminal',
        group: 'View',
        title: 'Toggle terminal',
        shortcut: 'Ctrl+`',
        run: () => setTermOpen((v) => !v),
      },
      { id: 'ai', group: 'View', title: 'Ask AI', shortcut: `${shortcutModifier}J`, run: () => setAiOpen(true) },
      { id: 'recovery', group: 'View', title: 'Recovery history', disabled: noRepo, run: () => setRecoveryOpen(true) },
      {
        id: 'workspace',
        group: 'View',
        title: 'Remotes and worktrees',
        keywords: 'remote add remove',
        disabled: noRepo,
        run: () => setWorkspaceInspectionOpen(true),
      },
      {
        id: 'shortcuts',
        group: 'View',
        title: 'Keyboard shortcuts',
        shortcut: `${shortcutModifier}/`,
        run: () => setShortcutsOpen(true),
      },
      { id: 'clone', group: 'Repository', title: 'Clone repository…', run: () => setCloneOpen(true) },
      { id: 'open', group: 'Repository', title: 'Open / add repository…', run: () => openAddRepo() },
      { id: 'settings', group: 'Settings', title: 'Settings', run: () => openSettingsAt('general') },
      {
        id: 'appearance',
        group: 'Settings',
        title: 'Appearance',
        keywords: 'theme font',
        run: () => openSettingsAt('appearance'),
      },
      {
        id: 'signing',
        group: 'Settings',
        title: 'Commit signing',
        keywords: 'gpg ssh sign',
        disabled: noRepo,
        run: () => openSettingsAt('signing'),
      },
      ...(['system', 'dark', 'light', 'midnight', 'graphite'] as const).map((theme) => ({
        id: `theme-${theme}`,
        group: 'Settings',
        title: `Theme: ${theme[0].toUpperCase()}${theme.slice(1)}`,
        run: () => settings.set('theme', theme),
      })),
      {
        id: 'ui-minimal',
        group: 'Settings',
        title: 'Interface: Minimal',
        run: () => settings.set('uiMode', 'minimal'),
      },
      {
        id: 'ui-standard',
        group: 'Settings',
        title: 'Interface: Standard',
        run: () => settings.set('uiMode', 'standard'),
      },
      ...refs.local
        .filter((b) => !b.current)
        .map((b) => ({
          id: `checkout-${b.name}`,
          group: 'Check out branch',
          title: b.name,
          keywords: 'checkout switch branch',
          disabled: blocked,
          run: () => void checkout(b.name),
        })),
      ...recentRepos
        .filter((r) => r !== repoPath)
        .map((r) => ({
          id: `repo-${r}`,
          group: 'Switch repository',
          title: r.split(/[\\/]/).pop() || r,
          keywords: `repository ${r}`,
          run: () => void openRepo(r),
        })),
    ];
    return list;
  };

  const importFolders = async (paths: string[]) => {
    if (scanRequest.current) return;
    const api = desktopApi();
    if (!paths.length) {
      useRepo
        .getState()
        .notify('error', 'Could not read dropped folders', 'Please drop folders from your file manager.');
      return;
    }
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
          if (result.skipped)
            useRepo
              .getState()
              .notify(
                'warning',
                'Some folders could not be scanned',
                `${result.skipped} folders could not be read or verified as repositories.`,
              );
          const nested = result.repos.filter((repo) => repo !== result.root);
          if (nested.length) {
            const existing = useSettings.getState().repoGroups;
            let group = result.group || 'Repositories';
            const base = group;
            let suffix = 2;
            const belongsToRoot = (repo: string) =>
              repo === result.root ||
              repo.startsWith(result.root.replace(/[\\/]+$/, '') + (result.root.includes('\\') ? '\\' : '/'));
            while (Object.entries(existing).some(([repo, name]) => name === group && !belongsToRoot(repo)))
              group = `${base} (${suffix++})`;
            setRepoGroupRoot(group, result.root);
            for (const repo of result.repos) setRepoGroup(repo, group);
          }
          if (request.cancelled)
            useRepo
              .getState()
              .notify(
                'info',
                'Folder scan cancelled',
                'Results from the interrupted folder were not added. Completed folders are kept.',
              );
          found.push(...result.repos);
        } catch (error: any) {
          useRepo
            .getState()
            .notify(
              'error',
              'Could not scan folder',
              String(error?.message ?? error).replace(/^Error invoking remote method '[^']*': (Error: )?/, ''),
            );
        }
      }
      const repos = [...new Set(found)];
      if (repos.length) {
        useRepo.setState((state) => ({ recentRepos: [...new Set([...state.recentRepos, ...repos])] }));
        await openRepo(repos[0]);
        useRepo.getState().notify('success', `Added ${repos.length} repositor${repos.length === 1 ? 'y' : 'ies'}`);
      }
    } finally {
      unsubscribe();
      scanRequest.current = null;
      setScanningFolders(false);
      setScanProgress(null);
      setCancellingScan(false);
    }
  };
  const cancelFolderScan = () => {
    const request = scanRequest.current;
    if (!request || request.cancelled) return;
    request.cancelled = true;
    setCancellingScan(true);
    desktopApi().cancelScan(request.id);
  };
  // Tauri reports dropped files natively (with paths); the DOM drop events below cover Electron
  const importRef = useRef(importFolders);
  importRef.current = importFolders;
  useEffect(
    () =>
      platformApi()?.onFileDrop?.((event) => {
        if (draggedTab.current) return;
        if (event.type === 'enter') setDraggingFolders(true);
        else {
          dragDepth.current = 0;
          setDraggingFolders(false);
          if (event.type === 'drop' && event.paths.length) void importRef.current(event.paths);
        }
      }),
    [],
  );
  const dropFolders = (event: React.DragEvent) => {
    event.preventDefault();
    dragDepth.current = 0;
    setDraggingFolders(false);
    const api = platformApi();
    const paths = Array.from(event.dataTransfer.files)
      .map((file) => api?.pathForFile?.(file))
      .filter(Boolean) as string[];
    void importFolders(paths);
  };
  const chooseFolder = async () => {
    try {
      const api = platformApi();
      if (typeof api?.openRepoDialog !== 'function') {
        useRepo
          .getState()
          .notify(
            'error',
            'Desktop connection unavailable',
            'The folder picker is only available in the installed desktop app. Restart GITVerse by PRAPAWITY; if the problem persists, reinstall it.',
          );
        return;
      }
      const folder = await api.openRepoDialog();
      if (folder) void importFolders([folder]);
    } catch (error: any) {
      useRepo.getState().notify('error', 'Could not open folder', String(error?.message ?? error));
    }
  };

  return (
    <div
      className="flex h-full flex-col"
      onClick={() => {
        setCtx(null);
        setGroupMenu(null);
      }}
      onDragEnter={(e) => {
        if (!draggedTab.current && e.dataTransfer.types.includes('Files')) {
          e.preventDefault();
          dragDepth.current++;
          setDraggingFolders(true);
        }
      }}
      onDragOver={(e) => {
        if (!draggedTab.current && e.dataTransfer.types.includes('Files')) {
          e.preventDefault();
          e.dataTransfer.dropEffect = 'copy';
        }
      }}
      onDragLeave={(e) => {
        e.preventDefault();
        if (--dragDepth.current <= 0) {
          dragDepth.current = 0;
          setDraggingFolders(false);
        }
      }}
      onDrop={(e) => {
        if (!draggedTab.current && e.dataTransfer.types.includes('Files')) void dropFolders(e);
      }}
    >
      {(draggingFolders || scanningFolders) && (
        <div
          className={`fixed inset-0 z-[80] flex items-center justify-center bg-crust/80 ${scanningFolders ? '' : 'pointer-events-none'}`}
        >
          <div className="mx-4 w-full max-w-[560px] rounded-xl border-2 border-dashed border-accent bg-mantle p-8 text-center shadow-2xl">
            <div role="status" aria-live="polite">
              <h2 className="text-lg font-semibold">
                {scanningFolders ? 'Finding repositories…' : 'Drop folders to open repositories'}
              </h2>
              {scanningFolders && (
                <>
                  <p className="mt-3 text-sm text-sub">
                    {(scanProgress?.scanned ?? 0).toLocaleString()} folders scanned ·{' '}
                    {(scanProgress?.repositories ?? 0).toLocaleString()} repositories found
                  </p>
                  <p className="mt-2 break-all text-xs text-sub">{scanProgress?.folder}</p>
                  <p className="mt-3 text-sm text-sub">
                    No folder or depth limit. Hidden, dependency and symlink folders are skipped.
                  </p>
                </>
              )}
            </div>
            {scanningFolders && (
              <button
                autoFocus
                disabled={cancellingScan}
                onClick={cancelFolderScan}
                className="btn-secondary mt-5 min-h-[44px] px-5"
              >
                {cancellingScan ? 'Cancelling…' : 'Cancel scan'}
              </button>
            )}
          </div>
        </div>
      )}
      {/* repo tabs */}
      {!settingsOpen && (
        <nav
          aria-label="Open repositories"
          className="glass-tabs flex min-w-0 items-center gap-1 border-b border-surface bg-crust px-2 py-1"
        >
          <div
            className="flex shrink-0 items-center gap-2 px-2 pr-4 text-sm font-bold"
            aria-label="GITVerse by PRAPAWITY"
          >
            <img src={new URL('./assets/gitverse-mark.svg', import.meta.url).href} width={24} height={24} alt="" />
            <span>
              GIT<span className="font-medium text-[#a78bfa]">Verse</span>{' '}
              <small className="block text-2xs font-normal text-sub">by PRAPAWITY</small>
            </span>
          </div>
          <button
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-sub hover:bg-white/10 hover:text-text"
            title="Add repository"
            aria-label="Add repository"
            onClick={openAddRepo}
          >
            <Plus size={17} />
          </button>
          <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">
            {recentRepos.map((r, index) => {
              const group = repoGroups[r] || '';
              if (group && recentRepos.findIndex((path) => repoGroups[path] === group) !== index) return null;
              const repos = group ? recentRepos.filter((path) => repoGroups[path] === group) : [r];
              return (
                <div
                  key={group || r}
                  data-repo-tab={r}
                  className={`relative flex shrink-0 items-center ${draggedTab.current === r ? 'opacity-40' : ''}`}
                  onDragStart={(e) => e.preventDefault()}
                  onClickCapture={(e) => {
                    if (suppressTabClick.current) {
                      e.preventDefault();
                      e.stopPropagation();
                      suppressTabClick.current = false;
                    }
                  }}
                  onPointerDown={(e) => {
                    if (e.button !== 0 || (e.target as HTMLElement).closest('[aria-label^="Close "]')) return;
                    const x = e.clientX,
                      y = e.clientY,
                      source = r;
                    let active = false;
                    let target: { target: string; after: boolean } | null = null;
                    const move = (event: PointerEvent) => {
                      if (!active && Math.hypot(event.clientX - x, event.clientY - y) < 5) return;
                      if (!active) {
                        active = true;
                        draggedTab.current = source;
                        setDraggingFolders(false);
                      }
                      const node = document
                        .elementFromPoint(event.clientX, event.clientY)
                        ?.closest<HTMLElement>('[data-repo-tab]');
                      if (node && node.dataset.repoTab !== source) {
                        const bounds = node.getBoundingClientRect();
                        target = {
                          target: node.dataset.repoTab!,
                          after: event.clientX >= bounds.left + bounds.width / 2,
                        };
                      } else target = null;
                      setDropTab(target);
                    };
                    const end = (event: PointerEvent) => {
                      window.removeEventListener('pointermove', move);
                      window.removeEventListener('pointerup', end);
                      window.removeEventListener('pointercancel', end);
                      if (active) {
                        suppressTabClick.current = true;
                        setTimeout(() => {
                          suppressTabClick.current = false;
                        }, 0);
                        if (target && event.type !== 'pointercancel') {
                          const destination = target;
                          useRepo.setState((state) => ({
                            recentRepos: reorderRepoTabs(
                              state.recentRepos,
                              useSettings.getState().repoGroups,
                              source,
                              destination.target,
                              destination.after,
                            ),
                          }));
                        }
                      }
                      draggedTab.current = null;
                      setDropTab(null);
                    };
                    window.addEventListener('pointermove', move);
                    window.addEventListener('pointerup', end);
                    window.addEventListener('pointercancel', end);
                  }}
                >
                  {dropTab?.target === r && !dropTab.after && (
                    <span
                      aria-hidden
                      className="pointer-events-none absolute -left-0.5 top-1 z-10 h-8 w-1 rounded-full bg-accent"
                    />
                  )}
                  {group ? (
                    <RepoGroup
                      name={group}
                      repos={repos}
                      root={repoGroupRoots[group]}
                      syncing={syncingGroups.includes(group)}
                      onSync={(manual) => void useRepo.getState().syncRepoGroup(group, manual)}
                      current={repoPath}
                      onOpen={(path) => void openRepo(path)}
                      onCloseRepo={closeRepo}
                      onContext={(repo, x, y) => {
                        setNewGroup(null);
                        setGroupMenu({ repo, x, y });
                      }}
                      onDelete={async () => {
                        if (
                          !(await askConfirm(
                            'Delete group',
                            `Remove “${group}” and close its repositories? No files will be deleted from disk.`,
                            { label: 'Delete group' },
                          ))
                        )
                          return;
                        const state = useRepo.getState();
                        const members = state.recentRepos.filter(
                          (repo) => useSettings.getState().repoGroups[repo] === group,
                        );
                        for (const repo of members) if (repo !== state.repoPath) state.closeRepo(repo);
                        if (state.repoPath && members.includes(state.repoPath)) state.closeRepo(state.repoPath);
                        useSettings.getState().deleteRepoGroup(group);
                      }}
                    />
                  ) : (
                    <div
                      onContextMenu={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        setNewGroup(null);
                        setGroupMenu({ repo: r, x: e.clientX, y: e.clientY });
                      }}
                      title={`${r} — right-click to organize groups`}
                      className={`repo-tab group relative my-1 flex min-h-[36px] min-w-0 max-w-[220px] items-center gap-1 rounded-lg px-2 text-sm ${r === repoPath ? 'repo-tab-active text-text' : 'text-sub hover:bg-white/5 hover:text-text'}`}
                    >
                      <button
                        type="button"
                        aria-current={r === repoPath ? 'page' : undefined}
                        onClick={() => void openRepo(r)}
                        className="flex min-h-[36px] min-w-0 items-center gap-2 rounded-md px-1 text-left"
                      >
                        <GitBranch size={15} className="shrink-0" aria-hidden />
                        <span className="truncate">{r.split(/[\\/]/).filter(Boolean).pop() || r}</span>
                      </button>
                      <button
                        aria-label={`Close ${r.split(/[\\/]/).filter(Boolean).pop() || r}`}
                        className="shrink-0 rounded p-1 text-sub hover:bg-surface hover:text-danger"
                        onClick={(e) => {
                          e.stopPropagation();
                          closeRepo(r);
                        }}
                      >
                        <X size={14} />
                      </button>
                    </div>
                  )}
                  {dropTab?.target === r && dropTab.after && (
                    <span
                      aria-hidden
                      className="pointer-events-none absolute -right-0.5 top-1 z-10 h-8 w-1 rounded-full bg-accent"
                    />
                  )}
                </div>
              );
            })}
          </div>
          <ProfilePicker
            onManage={() => {
              setSettingsSection('profiles');
              setSettingsOpen(true);
            }}
          />
          <button
            onClick={() => {
              setSettingsSection('general');
              setSettingsOpen((v) => !v);
            }}
            aria-pressed={settingsOpen}
            aria-label="Preferences"
            title="Preferences"
            className={`mr-2 flex h-9 w-9 items-center justify-center rounded-md ${settingsOpen ? 'bg-accent/20 text-accent' : 'text-sub hover:bg-surface hover:text-text'}`}
          >
            <GearIcon size={18} aria-hidden />
          </button>
        </nav>
      )}

      {settingsOpen ? (
        <div className="min-h-0 flex-1">
          <SettingsPage
            initial={settingsSection}
            onExit={() => {
              setSettingsOpen(false);
              setSettingsSection('general');
            }}
          />
        </div>
      ) : !repoPath && !loading ? (
        <main className="flex min-h-0 flex-1 overflow-y-auto bg-canvas px-6 py-12 sm:px-12">
          <div className="m-auto w-full max-w-3xl">
            <div className="mb-9 flex items-center gap-4">
              <div className="flex h-14 w-14 shrink-0 items-center justify-center rounded-xl border border-accent/25 bg-mantle">
                <GitBranch size={26} className="text-accent" aria-hidden />
              </div>
              <div>
                <h1 className="text-2xl font-semibold tracking-tight">Your repositories, in one place</h1>
                <p className="mt-1 text-sm text-sub">Open a project to explore its history and work with changes.</p>
              </div>
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <button
                onClick={() => void chooseFolder()}
                className="flex min-h-[112px] items-start gap-4 rounded-lg border border-accent/40 bg-mantle p-5 text-left hover:border-accent hover:bg-surface/30"
              >
                <FolderOpen size={22} className="mt-0.5 shrink-0 text-accent" aria-hidden />
                <span>
                  <span className="block font-semibold">Open a local folder</span>
                  <span className="mt-1 block text-sm text-sub">
                    Choose a repository or scan a folder for projects.
                  </span>
                </span>
              </button>
              <button
                onClick={() => setCloneOpen(true)}
                className="flex min-h-[112px] items-start gap-4 rounded-lg border border-surface bg-mantle p-5 text-left hover:border-accent/60 hover:bg-surface/30"
              >
                <Download size={22} className="mt-0.5 shrink-0 text-accent" aria-hidden />
                <span>
                  <span className="block font-semibold">Clone a repository</span>
                  <span className="mt-1 block text-sm text-sub">Get a project from an HTTPS or SSH URL.</span>
                </span>
              </button>
            </div>
            {recentRepos.length > 0 ? (
              <section className="mt-10" aria-labelledby="open-repositories-title">
                <h2 id="open-repositories-title" className="mb-3 text-sm font-semibold">
                  Open repositories
                </h2>
                <div className="divide-y divide-surface overflow-hidden rounded-lg border border-surface bg-mantle">
                  {recentRepos.map((repo) => (
                    <button
                      key={repo}
                      onClick={() => void openRepo(repo)}
                      className="flex min-h-[58px] w-full items-center gap-3 px-4 py-2 text-left hover:bg-surface/40"
                    >
                      <GitBranch size={17} className="shrink-0 text-sub" aria-hidden />
                      <span className="min-w-0">
                        <span className="block truncate font-medium">{repo.split(/[\\/]/).filter(Boolean).pop()}</span>
                        <span className="block truncate text-xs text-sub">{repo}</span>
                      </span>
                    </button>
                  ))}
                </div>
              </section>
            ) : (
              <p className="mt-6 text-sm text-sub">You can also drag a folder into this window.</p>
            )}
          </div>
        </main>
      ) : (
        <>
          {/* toolbar */}
          <header className="glass-toolbar flex shrink-0 flex-wrap items-center gap-x-1 gap-y-1 border-b border-surface bg-mantle px-3 py-2 sm:px-5">
            <RepoBranchDropdown current={current} />
            <div className="mx-2 hidden h-9 w-px shrink-0 bg-surface xl:block xl:mx-5" aria-hidden />
            <div className="flex shrink-0" role="group" aria-label="Undo and redo">
              <span title={undoTarget ? `Undo ${undoTarget}` : 'Nothing to undo'}>
                <ToolBtn
                  icon={<Undo2 size={22} />}
                  label="Undo"
                  disabled={!undoTarget || !!working}
                  onClick={() => void runUndo('undo')}
                />
              </span>
              <span title={redoTarget ? `Redo ${redoTarget}` : 'Nothing to redo'}>
                <ToolBtn
                  icon={<Redo2 size={22} />}
                  label="Redo"
                  disabled={!redoTarget || !!working}
                  onClick={() => void runUndo('redo')}
                />
              </span>
            </div>
            <div className="mx-2 hidden h-9 w-px shrink-0 bg-surface xl:block" aria-hidden />
            <div className="flex shrink-0 items-center gap-1" role="group" aria-label="Remote and branch actions">
              <div className="flex items-stretch rounded-md border border-surface">
                <ToolBtn
                  icon={<ArrowDownToLine size={22} />}
                  label={fetchMode === 'all' ? 'Fetch' : 'Pull'}
                  disabled={dis}
                  busy={busy === 'fetch' || busy === 'pull'}
                  onClick={() => action('fetch', fetchMode)}
                />
                <details className="group relative">
                  <summary
                    aria-label="Choose fetch or pull mode"
                    className="flex h-full min-h-[44px] w-6 cursor-pointer min-[1400px]:min-h-[52px] min-[1400px]:w-7 list-none items-center justify-center rounded-r-md border-l border-surface hover:bg-surface/60 focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
                  >
                    <ChevronDown size={14} aria-hidden />
                  </summary>
                  <div
                    role="menu"
                    className="absolute left-0 top-full z-50 w-64 rounded border border-surface bg-mantle p-1 shadow-xl"
                  >
                    {(
                      [
                        ['all', 'Fetch All'],
                        ['ff', 'Pull (fast-forward if possible)'],
                        ['ff-only', 'Pull (fast-forward only)'],
                        ['rebase', 'Pull (rebase)'],
                      ] as const
                    ).map(([mode, label]) => (
                      <button
                        key={mode}
                        role="menuitemradio"
                        aria-checked={fetchMode === mode}
                        onClick={(event) => {
                          useSettings.getState().set('fetchMode', mode);
                          event.currentTarget.closest('details')?.removeAttribute('open');
                        }}
                        className={`block w-full rounded px-3 py-2 text-left text-sm hover:bg-surface ${fetchMode === mode ? 'bg-success/20' : ''}`}
                      >
                        {fetchMode === mode ? '● ' : '○ '}
                        {label}
                      </button>
                    ))}
                  </div>
                </details>
              </div>
              <ToolBtn
                icon={<Upload size={22} />}
                label="Push"
                disabled={dis}
                busy={working === 'Pushing…'}
                onClick={() => setPushRepo(repoPath)}
              />
              <ToolBtn
                icon={<GitBranch size={22} />}
                label="Branch"
                disabled={dis}
                busy={working === 'Creating branch…'}
                onClick={newBranch}
              />
              <ToolBtn
                icon={<Archive size={22} />}
                label="Stash"
                disabled={dis}
                busy={busy === 'stash'}
                onClick={async () => {
                  const message = await askText('Name this stash', 'e.g. Before refactoring');
                  if (message) await action('stash', message);
                }}
              />
              <ToolBtn
                icon={<ArchiveRestore size={22} />}
                label="Pop"
                disabled={dis || !refs.stashes.length}
                busy={busy === 'stashPop'}
                onClick={() => action('stashPop')}
              />
              <span
                title={
                  operation
                    ? 'Finish the current Git operation first'
                    : selectedHash
                      ? 'Plan a rebase onto the selected commit'
                      : 'Select a commit to plan a rebase'
                }
              >
                <ToolBtn
                  icon={<ListOrdered size={21} />}
                  label="Rebase"
                  disabled={dis || !selectedHash || !!operation}
                  onClick={() => setRebasePreviewOpen(true)}
                />
              </span>
            </div>
            <div className="mx-2 hidden h-9 w-px shrink-0 bg-surface xl:block" aria-hidden />
            <button
              onClick={() => {
                setWorkspaceInspectionOpen(false);
                setAiOpen(false);
                setRecoveryOpen((value) => !value);
              }}
              aria-pressed={recoveryOpen}
              aria-label="Recovery"
              title="Recovery history"
              className={`ui-tool flex min-h-[44px] w-10 flex-col min-[1400px]:min-h-[52px] min-[1400px]:w-[68px] items-center justify-center gap-1 rounded-md text-xs ${recoveryOpen ? 'bg-accent/15 text-accent' : 'hover:bg-surface/60'}`}
            >
              <History size={21} aria-hidden />
              <span className="ui-label hidden min-[1400px]:block">Recovery</span>
            </button>
            <button
              onClick={() => {
                setRecoveryOpen(false);
                setAiOpen(false);
                setWorkspaceInspectionOpen((value) => !value);
              }}
              aria-pressed={workspaceInspectionOpen}
              aria-label="Workspace"
              title="Remotes and worktrees"
              className={`ui-tool flex min-h-[44px] w-10 flex-col min-[1400px]:min-h-[52px] min-[1400px]:w-[68px] items-center justify-center gap-1 rounded-md text-xs ${workspaceInspectionOpen ? 'bg-accent/15 text-accent' : 'hover:bg-surface/60'}`}
            >
              <GitFork size={21} aria-hidden />
              <span className="ui-label hidden min-[1400px]:block">Workspace</span>
            </button>
            <button
              onClick={() => repoPath && setPullRequestRepo(repoPath)}
              disabled={!repoPath}
              aria-label="Pull request"
              title="Create a pull / merge request"
              className="ui-tool flex min-h-[44px] w-10 flex-col min-[1400px]:min-h-[52px] min-[1400px]:w-[68px] items-center justify-center gap-1 rounded-md text-xs hover:bg-surface/60 disabled:opacity-40"
            >
              <GitPullRequest size={21} aria-hidden />
              <span className="ui-label hidden min-[1400px]:block">PR / MR</span>
            </button>
            <button
              onClick={() => setTermOpen((v) => !v)}
              aria-pressed={termOpen}
              aria-label="Terminal"
              title="Terminal (Ctrl+`)"
              className={`ui-tool flex min-h-[44px] w-10 flex-col min-[1400px]:min-h-[52px] min-[1400px]:w-[68px] items-center justify-center gap-1 rounded-md text-xs ${termOpen ? 'bg-accent/15 text-accent' : 'hover:bg-surface/60'}`}
            >
              <SquareTerminal size={22} aria-hidden />
              <span className="ui-label hidden min-[1400px]:block">Terminal</span>
            </button>
            <div className="mx-2 hidden h-9 w-px shrink-0 bg-surface xl:block" aria-hidden />
            <button
              onClick={() => setAiOpen((v) => !v)}
              aria-pressed={aiOpen}
              aria-label="Ask AI"
              title={`Ask AI (${shortcutModifier}J)`}
              className={`ui-tool flex min-h-[44px] w-10 flex-col min-[1400px]:min-h-[52px] min-[1400px]:w-[68px] items-center justify-center gap-1 rounded-md text-xs font-semibold text-ai hover:bg-ai/10 ${aiOpen ? 'bg-ai/15 ring-1 ring-ai/60' : ''}`}
            >
              <Sparkles size={22} aria-hidden />
              <span className="ui-label hidden min-[1400px]:block">Ask AI</span>
            </button>
            <div className="relative ml-auto min-w-[120px] flex-1 sm:max-w-72">
              <Search size={13} className="absolute left-2.5 top-3 text-sub" aria-hidden />
              <input
                ref={searchRef}
                aria-label="Search commits"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search commits"
                className="w-full rounded-md border border-transparent bg-surface py-2 pl-8 pr-3 min-[1600px]:pr-16 outline-none placeholder:text-sub focus:border-accent focus-visible:ring-2 focus-visible:ring-accent"
              />
              {search ? (
                <button
                  aria-label="Clear search"
                  className="absolute right-1 top-1 rounded p-1.5 text-sub hover:text-text"
                  onClick={() => setSearch('')}
                >
                  <X size={14} />
                </button>
              ) : (
                <kbd className="absolute right-2 top-2 hidden rounded border border-sub/40 px-1.5 text-2xs text-sub min-[1600px]:block">
                  {shortcutModifier}F
                </kbd>
              )}
            </div>
          </header>
          <ActivityBar />
          {detached && !operation && !loading && (
            <div role="status" className="border-b border-warning/25 bg-warning/10 px-5 py-2 text-sm text-warning">
              Detached HEAD: a commit is checked out without a branch. Double-click a local branch in the sidebar to
              check it out, or create a branch from this commit.
            </div>
          )}
          {!detached &&
            !operation &&
            !loading &&
            currentBranch?.upstream &&
            (currentBranch.gone || !!currentBranch.behind || !!currentBranch.ahead) && (
              <div
                role="status"
                className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-accent/25 bg-accent/10 px-5 py-2 text-sm"
              >
                <span className="min-w-0 flex-1">
                  {currentBranch.gone
                    ? `Upstream ${currentBranch.upstream} is unavailable. Fetch and check your remote branch.`
                    : `${currentBranch.name} is ${[currentBranch.ahead ? `${currentBranch.ahead} ahead` : '', currentBranch.behind ? `${currentBranch.behind} behind` : ''].filter(Boolean).join(' and ')} ${currentBranch.upstream}.`}
                  {!currentBranch.gone && <span className="ml-1 text-sub">Based on the last fetch.</span>}
                  {!currentBranch.gone && !!currentBranch.behind && status.length > 0 && (
                    <span className="ml-1 text-sub">Local changes may prevent a pull if files overlap.</span>
                  )}
                </span>
                {!currentBranch.gone && !!currentBranch.behind && (
                  <button
                    type="button"
                    disabled={!!working}
                    onClick={() => void action('fetch', 'ff-only')}
                    className="min-h-[32px] rounded-md border border-accent/50 px-3 font-medium text-accent hover:bg-accent/10 disabled:opacity-50"
                    title="Pull using fast-forward only; Git will stop if histories have diverged"
                  >
                    Pull fast-forward
                  </button>
                )}
                {currentBranch.gone && (
                  <button
                    type="button"
                    disabled={!!working}
                    onClick={() => void action('fetch', 'all')}
                    className="min-h-[32px] rounded-md border border-accent/50 px-3 font-medium text-accent hover:bg-accent/10 disabled:opacity-50"
                  >
                    Fetch remotes
                  </button>
                )}
              </div>
            )}
          <Group orientation="horizontal" className="min-h-0 flex-1">
            {file || workingFile || conflictFile ? (
              <FileRail
                onExpand={() => {
                  setFile(null);
                  setWorkingFile(null);
                  openConflict(null);
                }}
              />
            ) : (
              <Panel defaultSize="20%" minSize="12%">
                {repoPath && (
                  <Sidebar
                    onCreatePullRequest={() => repoPath && setPullRequestRepo(repoPath)}
                    onNavigate={navigateBranch}
                    onTag={(name) => void navigateTag(name)}
                    onStash={showStash}
                    selectedStashHash={stashView?.hash}
                    onContext={(kind, name, x, y) => {
                      const hash = refs[kind].find((ref) => ref.name === name)?.hash;
                      if (hash) setCtx({ x, y, hash, ref: { kind, name } });
                      else
                        useRepo
                          .getState()
                          .notify('error', 'Could not locate branch', 'Refresh the repository and try again.');
                    }}
                  />
                )}
              </Panel>
            )}
            {!file && !workingFile && !conflictFile && <Handle />}
            <Panel defaultSize="55%" minSize="30%">
              {/* center column: graph / diff / merge tool on top, terminal underneath */}
              <Group orientation="vertical">
                <Panel minSize="20%">
                  <div className="flex h-full flex-col">
                    {!conflictFile && !file && <ConflictRow />}
                    {repoPath && !conflictFile && !file && !workingFile && !stashView && (
                      <AgentCheckpoints key={repoPath} repo={repoPath} />
                    )}
                    {repoPath && !conflictFile && !file && !workingFile && !stashView && (
                      <GraphFilterBar repo={repoPath} />
                    )}
                    <div className="min-h-0 flex-1">
                      {conflictFile ? (
                        <MergeTool path={conflictFile} />
                      ) : stashView && file && repoPath ? (
                        <StashView repo={repoPath} stash={stashView} file={file} onClose={() => setFile(null)} />
                      ) : workingFile && workingView && repoPath ? (
                        <DiffView
                          repoPath={repoPath}
                          hash=""
                          file={workingFile}
                          area={workingFile.area}
                          revision={workingRevision}
                          onRefresh={refreshWorking}
                          onClose={() => setWorkingFile(null)}
                        />
                      ) : file && repoPath && range ? (
                        <DiffView
                          key={`${range.oldest}..${range.newest}:${file.path}`}
                          repoPath={repoPath}
                          hash={range.newest}
                          file={file}
                          onClose={() => setFile(null)}
                          loadDiff={() =>
                            desktopApi().rangeFileDiff(repoPath, range.oldest, range.newest, file.path, file.oldPath)
                          }
                          readOnlySnapshot
                        />
                      ) : file && repoPath && selectedHash ? (
                        <DiffView
                          repoPath={repoPath}
                          hash={selectedHash}
                          file={file}
                          onClose={() => setFile(null)}
                          onJumpToCommit={select}
                        />
                      ) : graph.rows.length ? (
                        <CommitGraph
                          layout={graph}
                          selectedHash={workingView ? null : selectedHash}
                          selectedHashes={workingView ? [] : selectedHashes}
                          filter={search}
                          hasMore={hasMore}
                          loadingMore={loadingMore}
                          onLoadMore={loadMore}
                          headHash={headHash}
                          upstream={
                            currentBranch?.upstream
                              ? {
                                  name: currentBranch.upstream,
                                  ahead: currentBranch.ahead ?? 0,
                                  behind: currentBranch.behind ?? 0,
                                  gone: currentBranch.gone ?? false,
                                }
                              : undefined
                          }
                          changeCount={status.length}
                          stagedCount={
                            status.filter(
                              (f) =>
                                f.index !== ' ' &&
                                f.index !== '?' &&
                                !['DD', 'AU', 'UD', 'UA', 'DU', 'AA', 'UU'].includes(f.index + f.worktree),
                            ).length
                          }
                          wipSelected={workingView}
                          onSelectWip={showWorking}
                          navigate={navigation}
                          onLocateCurrent={() => {
                            if (headHash) void navigateToHash(headHash);
                          }}
                          onSelect={(hash, hashes) => {
                            const stash = refs.stashes.find((entry) => entry.hash === hash);
                            if (stash) {
                              showStash(stash);
                              return;
                            }
                            setWorkingView(false);
                            setWorkingFile(null);
                            setStashView(null);
                            setSelectedHashes(hashes.filter((id) => !refs.stashes.some((entry) => entry.hash === id)));
                            select(hash);
                          }}
                          onContextMenu={(hash, x, y, ref) => {
                            const stash = refs.stashes.find((entry) => entry.hash === hash);
                            if (stash) {
                              setCtx({ hash, x, y });
                            } else {
                              setCtx({
                                hash,
                                x,
                                y,
                                ref,
                                hashes: selectedHashes.includes(hash) ? selectedHashes : [hash],
                              });
                            }
                          }}
                          onDoubleClick={(r) => {
                            if (!r.current && r.kind === 'local') checkout(r.name);
                            else if (r.kind === 'remote') void checkoutRemoteWithSparseRecovery(r.name);
                          }}
                        />
                      ) : loading ? (
                        <GraphSkeleton />
                      ) : (
                        <div className="flex h-full flex-col items-center justify-center gap-3 text-sub">
                          <GitBranch size={36} aria-hidden />
                          <div>
                            {repoPath
                              ? 'No commits yet'
                              : 'Welcome to GITVerse by PRAPAWITY — open a repository to see its history'}
                          </div>
                          {!repoPath && (
                            <button className="btn-primary px-4 py-2" onClick={openAddRepo}>
                              Add repository
                            </button>
                          )}
                        </div>
                      )}
                    </div>
                  </div>
                </Panel>
                {termOpen && (
                  <>
                    <Separator className="h-px bg-surface transition-colors hover:bg-accent" />
                    <Panel defaultSize="32%" minSize="12%">
                      <TerminalPanel cwd={repoPath} onHide={() => setTermOpen(false)} />
                    </Panel>
                  </>
                )}
              </Group>
            </Panel>
            <Handle />
            <Panel defaultSize="25%" minSize="15%" className="glass-panel bg-mantle">
              {recoveryOpen && repoPath ? (
                <RecoveryPanel
                  repoPath={repoPath}
                  onClose={() => setRecoveryOpen(false)}
                  onNavigate={async (hash) => {
                    const found = await navigateToHash(hash);
                    if (found) setRecoveryOpen(false);
                    return !!found;
                  }}
                />
              ) : workspaceInspectionOpen && repoPath ? (
                <WorkspaceInspectionPanel repoPath={repoPath} onClose={() => setWorkspaceInspectionOpen(false)} />
              ) : operation && conflictView ? (
                <ConflictPanel />
              ) : stashView ? (
                <DetailsPanel stash={stashView} file={file} onSelectFile={setFile} />
              ) : workingView && repoPath ? (
                <WorkingChangesPanel
                  selected={workingFile}
                  onSelect={setWorkingFile}
                  onClear={() => setWorkingFile(null)}
                  onRefresh={refreshWorking}
                />
              ) : (
                <div className="flex h-full min-h-0 flex-col">
                  {repoPath && status.length > 0 && (
                    <div className="flex items-center gap-2 border-b border-surface bg-accent/15 px-4 py-2 text-sm">
                      <span className="min-w-0 flex-1">
                        {status.length} local file change{status.length === 1 ? '' : 's'}
                      </span>
                      <button
                        onClick={showWorking}
                        className="shrink-0 rounded border border-accent/50 px-2 py-1 text-accent hover:bg-accent/15"
                      >
                        View changes
                      </button>
                    </div>
                  )}
                  <div className="min-h-0 flex-1">
                    {range ? (
                      <CombinedChanges {...range} file={file} onSelectFile={setFile} />
                    ) : (
                      <DetailsPanel file={file} onSelectFile={setFile} />
                    )}
                  </div>
                </div>
              )}
            </Panel>
            {aiOpen && (
              <>
                <Handle />
                <Panel defaultSize="24%" minSize="16%" className="glass-panel bg-mantle">
                  <AiPanel
                    onClose={() => setAiOpen(false)}
                    onOpenSettings={() => {
                      setSettingsSection('ai');
                      setSettingsOpen(true);
                    }}
                  />
                </Panel>
              </>
            )}
          </Group>
        </>
      )}
      <ActivityLog />
      <DialogHost />
      {rebasePreviewOpen && repoPath && selectedHash && (
        <RebasePreview repo={repoPath} base={selectedHash} onClose={() => setRebasePreviewOpen(false)} />
      )}
      {groupMenu && (
        <div
          role="menu"
          aria-label="Repository groups"
          onClick={(e) => e.stopPropagation()}
          className="glass-context-menu fixed z-[95] max-h-[calc(100vh-16px)] min-w-[240px] overflow-y-auto rounded-xl p-1.5"
          style={{
            left: Math.max(8, Math.min(groupMenu.x, window.innerWidth - 240)),
            top: Math.max(8, Math.min(groupMenu.y, window.innerHeight - 240)),
          }}
        >
          <div className="px-3 py-2 text-xs font-semibold uppercase text-sub">Move to group</div>
          {[...new Set(Object.values(repoGroups).filter(Boolean))].map((group) => (
            <button
              role="menuitem"
              key={group}
              onClick={() => {
                setRepoGroup(groupMenu.repo, group);
                setGroupMenu(null);
              }}
              className="block w-full truncate rounded px-3 py-2 text-left text-sm hover:bg-surface/60"
            >
              {group}
            </button>
          ))}
          {repoGroups[groupMenu.repo] && (
            <button
              role="menuitem"
              onClick={() => {
                setRepoGroup(groupMenu.repo, '');
                setGroupMenu(null);
              }}
              className="block w-full rounded px-3 py-2 text-left text-sm hover:bg-surface/60"
            >
              Remove from group
            </button>
          )}
          {newGroup === null ? (
            <button
              role="menuitem"
              onClick={() => setNewGroup('')}
              className="block w-full rounded border-t border-surface px-3 py-2 text-left text-sm text-accent hover:bg-surface/60"
            >
              + New group…
            </button>
          ) : (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                const group = newGroup.trim();
                if (!group) return;
                setRepoGroup(groupMenu.repo, group);
                setNewGroup(null);
                setGroupMenu(null);
              }}
              className="space-y-2 border-t border-surface p-2"
            >
              <label htmlFor="new-repo-group" className="block text-xs text-sub">
                Group name
              </label>
              <input
                id="new-repo-group"
                autoFocus
                value={newGroup}
                onChange={(e) => setNewGroup(e.target.value)}
                placeholder="Group name"
                className="w-full rounded border border-surface bg-crust px-2 py-1.5 text-sm outline-none focus:border-accent"
              />
              <button type="submit" disabled={!newGroup.trim()} className="btn-primary w-full px-3 py-1.5">
                Create group
              </button>
            </form>
          )}
        </div>
      )}
      {addRepoOpen && (
        <div
          className="fixed inset-0 z-[90] flex items-center justify-center bg-black/60 p-4"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) closeAddRepo();
          }}
        >
          <section
            ref={addRepoDialogRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby="add-repo-title"
            onMouseDown={(e) => e.stopPropagation()}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                e.preventDefault();
                closeAddRepo();
                return;
              }
              if (e.key !== 'Tab') return;
              const items = [
                ...(addRepoDialogRef.current?.querySelectorAll<HTMLElement>(
                  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
                ) ?? []),
              ].filter((item) => item.getClientRects().length > 0);
              if (!items.length) {
                e.preventDefault();
                return;
              }
              const first = items[0];
              const last = items[items.length - 1];
              if (
                e.shiftKey &&
                (document.activeElement === first || !addRepoDialogRef.current?.contains(document.activeElement))
              ) {
                e.preventDefault();
                last.focus();
              } else if (
                !e.shiftKey &&
                (document.activeElement === last || !addRepoDialogRef.current?.contains(document.activeElement))
              ) {
                e.preventDefault();
                first.focus();
              }
            }}
            className="w-full max-w-[440px] rounded-xl border border-surface bg-mantle p-5 shadow-2xl"
          >
            <div className="mb-4 flex items-start justify-between gap-4">
              <div>
                <h2 id="add-repo-title" className="text-lg font-semibold">
                  Add repository
                </h2>
                <p className="mt-1 text-sm text-sub">Open a local folder or clone a remote repository.</p>
              </div>
              <button
                onClick={() => closeAddRepo()}
                aria-label="Close"
                className="rounded p-1 text-sub hover:bg-surface hover:text-text"
              >
                <X size={18} />
              </button>
            </div>
            <div className="space-y-2">
              <button
                autoFocus
                onClick={async () => {
                  closeAddRepo();
                  await chooseFolder();
                }}
                className="flex w-full items-center gap-3 rounded-lg border border-surface px-4 py-3 text-left hover:bg-surface/50"
              >
                <FolderOpen size={20} className="shrink-0 text-accent" />
                <span>
                  <span className="block font-medium">Open local folder</span>
                  <span className="block text-sm text-sub">Choose a repository or folder containing repositories</span>
                </span>
              </button>
              <button
                onClick={() => {
                  closeAddRepo(false);
                  setCloneOpen(true);
                }}
                className="flex w-full items-center gap-3 rounded-lg border border-surface px-4 py-3 text-left hover:bg-surface/50"
              >
                <Download size={20} className="shrink-0 text-accent" />
                <span>
                  <span className="block font-medium">Clone repository</span>
                  <span className="block text-sm text-sub">Clone from an HTTPS or SSH URL</span>
                </span>
              </button>
            </div>
          </section>
        </div>
      )}
      {cloneOpen && <CloneDialog onClose={() => setCloneOpen(false)} />}
      {pushRepo && <PushDialog repo={pushRepo} onClose={() => setPushRepo(null)} />}
      {paletteOpen && <CommandPalette commands={paletteCommands()} onClose={() => setPaletteOpen(false)} />}
      {shortcutsOpen && <ShortcutList shortcuts={shortcuts} onClose={() => setShortcutsOpen(false)} />}
      {pullRequestRepo && !pushRepo && (
        <PullRequestDialog
          repo={pullRequestRepo}
          onClose={() => setPullRequestRepo(null)}
          onPush={() => setPushRepo(pullRequestRepo)}
        />
      )}
      <Toasts />
      <BusyOverlay />
      {ctx && (
        <CommitMenu
          x={ctx.x}
          y={ctx.y}
          hash={ctx.hash}
          hashes={ctx.hashes}
          current={current}
          targetRef={ctx.ref}
          onPush={() => {
            if (repoPath) setPushRepo(repoPath);
          }}
          onClose={() => setCtx(null)}
        />
      )}
    </div>
  );
}
