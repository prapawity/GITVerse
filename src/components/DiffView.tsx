import { useEffect, useMemo, useRef, useState } from 'react';
import { Columns2, FilePen, History, Loader2, Rows2, SquareArrowOutUpRight, Trash2, UserRound, X } from 'lucide-react';
import { highlight, parseDiff, toSplit, type DiffLine } from '../lib/diff';
import { Markdown } from '../lib/markdown';
import { relTime } from './CommitGraph';
import { CodeSkeleton, ListSkeleton, Spinner } from './Loading';
import type { ChangedFile } from './DetailsPanel';
import { useRepo } from '../store/repoStore';
import { askConfirm } from './Dialogs';
import { isJsonFile, isSvgFile, JsonPreview, MediaPreview, mediaType } from './MediaPreview';
import { desktopApi } from '../platform/api';
import { useActionHistory } from '../lib/actionHistory';

const BG = { add: 'bg-[#a6e22e]/[0.13]', del: 'bg-danger/[0.14]', ctx: '' } as const;
const SIGN = { add: '+', del: '−', ctx: '' } as const;
const NUM = 'select-none pr-2 text-right text-[#6c7a89]';
// segmented controls share the .seg / .seg-item styles; the pressed look comes from aria-pressed
const seg = (_on: boolean) => 'seg-item flex items-center gap-1.5';
const grp = 'seg';

type Res<T> = { data?: T; error?: string } | null;
type Blame = { hash: string; author: string; time: number }[];
type Hist = { hash: string; author: string; date: string; subject: string; path?: string }[];

const Code = ({ text, change, plain }: { text: string; change?: [number, number]; plain?: boolean }) => {
  let offset = 0;
  return (
    <>
      {(plain ? [{ t: text, c: '' }] : highlight(text)).map((token, i) => {
        const start = offset;
        offset += token.t.length;
        if (!change || change[0] === change[1] || offset <= change[0] || start >= change[1])
          return (
            <span key={i} className={token.c}>
              {token.t}
            </span>
          );
        const from = Math.max(0, change[0] - start),
          to = Math.min(token.t.length, change[1] - start);
        return (
          <span key={i} className={token.c}>
            {token.t.slice(0, from)}
            <span className="bg-black/35" title="Changed text">
              {token.t.slice(from, to)}
            </span>
            {token.t.slice(to)}
          </span>
        );
      })}
      {!text &&
        (change ? (
          <span className="inline-block w-[1ch] bg-black/35" title="Empty changed line">
            {' '}
          </span>
        ) : (
          ' '
        ))}
    </>
  );
};

const api = () => desktopApi();
const useLoad = <T,>(enabled: boolean, load: () => Promise<T>, deps: unknown[]): Res<T> => {
  const [r, setR] = useState<Res<T>>(null);
  useEffect(() => {
    setR(null);
  }, deps); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!enabled) return;
    let on = true;
    load()
      .then((data) => on && setR({ data }))
      .catch((e: Error) => on && setR({ error: e.message }));
    return () => {
      on = false;
    };
  }, [enabled, ...deps]); // eslint-disable-line react-hooks/exhaustive-deps
  return r;
};

/** Two equal halves (old | new). Each half scrolls sideways on its own, kept in lock-step with the other. */
function SplitHunk({
  lines,
  side,
}: {
  lines: DiffLine[];
  side: (l: DiffLine | null, s: 'old' | 'new', k: string) => React.ReactNode;
}) {
  const left = useRef<HTMLDivElement>(null);
  const right = useRef<HTMLDivElement>(null);
  const syncing = useRef(false);
  const rows = useMemo(() => toSplit(lines), [lines]);
  const link = (from: React.RefObject<HTMLDivElement | null>, to: React.RefObject<HTMLDivElement | null>) => () => {
    if (syncing.current) {
      syncing.current = false;
      return;
    } // ignore the echo from our own write
    if (to.current && to.current.scrollLeft !== from.current!.scrollLeft) {
      syncing.current = true;
      to.current.scrollLeft = from.current!.scrollLeft;
    }
  };
  return (
    <div className="grid grid-cols-2">
      <div
        ref={left}
        onScroll={link(left, right)}
        className="min-w-0 overflow-x-auto border-r border-surface"
        aria-label="Before"
      >
        <div className="w-max min-w-full">{rows.map(([o], k) => side(o, 'old', `o${k}`))}</div>
      </div>
      <div ref={right} onScroll={link(right, left)} className="min-w-0 overflow-x-auto" aria-label="After">
        <div className="w-max min-w-full">{rows.map(([, n], k) => side(n, 'new', `n${k}`))}</div>
      </div>
    </div>
  );
}

/** whether the History list was left open (kept between diff views) */
let historyOpen = false;

export function DiffView({
  repoPath,
  hash: openedHash,
  file: openedFile,
  onClose,
  onJumpToCommit,
  area,
  revision,
  onRefresh,
  loadDiff,
  loadContent,
  readOnlySnapshot = false,
}: {
  repoPath: string;
  hash: string;
  file: ChangedFile;
  onClose: () => void;
  /** open the same file in another commit; `path` is its name there (it differs before a rename) */
  onJumpToCommit?: (hash: string, path?: string) => void;
  area?: 'staged' | 'unstaged' | 'untracked';
  revision?: number;
  onRefresh?: () => Promise<void>;
  loadDiff?: () => Promise<string>;
  loadContent?: () => Promise<string>;
  readOnlySnapshot?: boolean;
}) {
  // a History entry is viewed right here: only this diff changes, the graph and selection stay put
  const [historyView, setHistoryView] = useState<{ hash: string; path: string } | null>(null);
  useEffect(() => setHistoryView(null), [openedHash, openedFile.path]);
  const hash = historyView?.hash ?? openedHash;
  const file: ChangedFile = historyView
    ? { status: historyView.path === openedFile.path ? openedFile.status : 'M', path: historyView.path }
    : openedFile;
  const [mode, setMode] = useState<'diff' | 'file'>('diff');
  const [split, setSplit] = useState(false);
  const [view, setView] = useState<'code' | 'preview'>('code');
  const [blame, setBlame] = useState(false);
  // History stays open from one file / commit to the next, so stepping back through it keeps the list
  const [history, setHistoryState] = useState(historyOpen);
  const setHistory = (open: boolean) => {
    historyOpen = open;
    setHistoryState(open);
  };
  const [showWhitespace, setShowWhitespace] = useState(true);
  // back in Diff View, Blame turns off (it only annotates File View)
  useEffect(() => {
    if (mode === 'diff') setBlame(false);
  }, [mode]);
  const [discarding, setDiscarding] = useState(false);
  const [discardError, setDiscardError] = useState('');
  const [discardRevision, setDiscardRevision] = useState(0);
  const working = useRepo((state) => state.working);
  const operation = useRepo((state) => state.operation);
  const isMd = /\.(md|markdown)$/i.test(file.path);
  const isJson = isJsonFile(file.path);
  const isSvg = isSvgFile(file.path) && !readOnlySnapshot;
  const hasPreview = isMd || isJson || isSvg;
  const canPreviewMedia = !readOnlySnapshot && !!mediaType(file.path);
  const loadAfterBlob =
    file.status === 'D'
      ? null
      : () => (area ? api().workingFileBlob(repoPath, file.path) : api().fileBlobAt(repoPath, hash, file.path));
  const beforePath = file.oldPath ?? file.path;
  const loadBeforeBlob =
    file.status === 'A' || area === 'untracked' || file.untracked
      ? null
      : () => api().fileBlobAt(repoPath, area ? 'HEAD' : `${hash}^`, beforePath);
  const key = [repoPath, hash, file.path, file.oldPath, area, revision, discardRevision, readOnlySnapshot];
  const context = JSON.stringify([repoPath, file.path, area]);
  const activeContext = useRef(context);
  activeContext.current = context;

  useEffect(() => {
    setMode('diff');
    setBlame(false);
    setView(hasPreview ? 'preview' : 'code');
    setDiscardError('');
  }, [hash, file.path, hasPreview]);
  useEffect(() => {
    const h = (e: KeyboardEvent) => e.key === 'Escape' && !document.querySelector('[role="dialog"]') && onClose();
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [onClose]);

  const diff = useLoad<string>(
    true,
    () =>
      loadDiff
        ? loadDiff()
        : area
          ? api().workingFileDiff(repoPath, file.path, area)
          : api().commitFileDiff(repoPath, hash, file.path, file.oldPath),
    key,
  );
  const content = useLoad<string>(
    !area && mode === 'file',
    () => (loadContent ? loadContent() : api().fileAt(repoPath, hash, file.path)),
    key,
  );
  const blameRes = useLoad<Blame>(
    !readOnlySnapshot && !area && mode === 'file' && blame && view === 'code',
    () => api().fileBlame(repoPath, hash, file.path),
    key,
  );
  const histRes = useLoad<Hist>(
    !readOnlySnapshot && !area && history,
    () => api().fileHistory(repoPath, openedHash, openedFile.path),
    [repoPath, openedHash, openedFile.path, area, revision],
  );

  const parsed = useMemo(() => (diff?.data == null ? null : parseDiff(diff.data)), [diff]);
  // lines picked for line-level stage / unstage / discard: one hunk at a time, indices into its lines
  const [picked, setPicked] = useState<{ hunk: number; lines: Set<number>; anchor: number } | null>(null);
  useEffect(() => setPicked(null), [parsed]);
  const pickLine = (hunk: number, line: number, range: boolean) => {
    const lines = parsed?.hunks[hunk]?.lines;
    if (!lines || lines[line]?.type === 'ctx') return;
    setPicked((prev) => {
      const same = prev?.hunk === hunk ? prev : null;
      const next = new Set(same?.lines ?? []);
      if (range && same) {
        const [from, to] = same.anchor < line ? [same.anchor, line] : [line, same.anchor];
        for (let i = from; i <= to; i++) if (lines[i].type !== 'ctx') next.add(i);
      } else if (next.has(line)) next.delete(line);
      else next.add(line);
      return next.size ? { hunk, lines: next, anchor: line } : null;
    });
  };
  const staleWorkingFile =
    !!area && /This file is no longer (?:untracked|in the working changes|available)/i.test(diff?.error ?? '');
  const canDiscardFile = (area === 'unstaged' || area === 'untracked') && !!onRefresh;
  const canDiscardHunks =
    area === 'unstaged' &&
    !!onRefresh &&
    !parsed?.binary &&
    !/^(?:new file mode|deleted file mode|old mode|new mode|rename from|rename to|copy from|copy to|Binary files|GIT binary patch)/m.test(
      diff?.data ?? '',
    );
  const canStageHunks =
    (area === 'unstaged' || area === 'staged') &&
    !!onRefresh &&
    !parsed?.binary &&
    !/^(?:new file mode|deleted file mode|old mode|new mode|rename from|rename to|copy from|copy to|Binary files|GIT binary patch)/m.test(
      diff?.data ?? '',
    );
  const stageHunk = async (hunk: number, lines?: number[]) => {
    if (!canStageHunks || !area || discarding || working || operation || diff?.data == null) return;
    setDiscarding(true);
    setDiscardError('');
    try {
      await api().stageWorkingHunk(repoPath, file.path, area, diff.data, hunk, lines ?? null);
      useActionHistory.getState().markStaging();
      if (useRepo.getState().repoPath === repoPath && activeContext.current === context) {
        setDiscardRevision((value) => value + 1);
        await onRefresh?.();
      }
    } catch (e) {
      if (useRepo.getState().repoPath === repoPath && activeContext.current === context) {
        setDiscardError(
          String((e as Error)?.message ?? e).replace(/^Error invoking remote method '[^']*': (Error: )?/, ''),
        );
        setDiscardRevision((value) => value + 1);
      }
    } finally {
      setDiscarding(false);
    }
  };
  const discard = async (hunk?: number, lines?: number[]) => {
    if (!canDiscardFile || discarding || working || operation || diff?.data == null) return;
    const snapshot = diff.data;
    setDiscarding(true);
    setDiscardError('');
    try {
      if (
        !(await askConfirm(
          hunk == null
            ? 'Discard file changes?'
            : lines
              ? `Discard ${lines.length} selected line${lines.length === 1 ? '' : 's'}?`
              : 'Discard this hunk?',
          `${file.path}\n\n${hunk == null && area === 'untracked' ? 'This untracked file will be permanently deleted.' : 'These unstaged changes will be permanently lost. Staged changes are kept.'}`,
          { label: hunk == null ? 'Discard file' : lines ? 'Discard lines' : 'Discard hunk', danger: true },
        ))
      )
        return;
      if (useRepo.getState().repoPath !== repoPath || activeContext.current !== context) return;
      if (hunk == null) await api().discardWorkingFiles(repoPath, [{ path: file.path, area, diff: snapshot }]);
      else await api().discardWorkingHunk(repoPath, file.path, snapshot, hunk, lines ?? null);
      useRepo
        .getState()
        .recordActivity(
          'success',
          hunk == null ? 'Discarded file changes' : lines ? 'Discarded selected lines' : 'Discarded hunk',
          file.path,
          repoPath,
        );
      if (useRepo.getState().repoPath === repoPath && activeContext.current === context) {
        setDiscardRevision((value) => value + 1);
        await onRefresh?.();
      }
    } catch (e) {
      const message = String((e as Error)?.message ?? e).replace(
        /^Error invoking remote method '[^']*': (Error: )?/,
        '',
      );
      useRepo.getState().recordActivity('error', 'Discard failed', message, repoPath);
      if (useRepo.getState().repoPath === repoPath && activeContext.current === context) {
        setDiscardError(message);
        setDiscardRevision((value) => value + 1);
      }
    } finally {
      setDiscarding(false);
    }
  };
  const inlineChanges = useMemo(() => {
    const result = new Map<DiffLine, [number, number]>();
    for (const hunk of parsed?.hunks ?? [])
      for (const [oldLine, newLine] of toSplit(hunk.lines)) {
        if (oldLine?.type === 'del' && !newLine && !oldLine.text.trim()) result.set(oldLine, [0, oldLine.text.length]);
        if (newLine?.type === 'add' && !oldLine && !newLine.text.trim()) result.set(newLine, [0, newLine.text.length]);
        if (!oldLine || !newLine || oldLine.type !== 'del' || newLine.type !== 'add') continue;
        const a = oldLine.text,
          b = newLine.text;
        let start = 0,
          endA = a.length,
          endB = b.length;
        while (start < endA && start < endB && a[start] === b[start]) start++;
        while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
          endA--;
          endB--;
        }
        if (start !== endA || start !== endB) {
          result.set(oldLine, [start, endA]);
          result.set(newLine, [start, endB]);
        }
      }
    return result;
  }, [parsed]);
  const i = file.path.lastIndexOf('/');
  const err = (m?: string) =>
    m && (
      <div role="alert" className="whitespace-pre-wrap p-4 text-danger">
        {m}
      </div>
    );

  const canPickLines = canStageHunks || canDiscardHunks;
  /** Gutter toggle that picks a changed line; shift-click picks the range from the last pick. */
  const pick = (hi: number, li: number, l: DiffLine) => {
    if (!canPickLines) return null;
    if (l.type === 'ctx') return <span aria-hidden />;
    const on = picked?.hunk === hi && picked.lines.has(li);
    return (
      <button
        type="button"
        aria-pressed={on}
        aria-label={`Select ${l.type === 'add' ? 'added' : 'removed'} line ${(l.type === 'add' ? l.newNo : l.oldNo) ?? ''}`}
        title="Select line (Shift-click selects a range)"
        disabled={discarding || !!working || !!operation}
        onClick={(e) => pickLine(hi, li, e.shiftKey)}
        className="flex items-center justify-center hover:bg-white/10 disabled:opacity-40"
      >
        <span
          className={`h-3 w-3 rounded-sm border ${on ? 'border-accent bg-accent' : 'border-[#6c7a89]'}`}
          aria-hidden
        />
      </button>
    );
  };
  const pickedRow = (hi: number, li: number) =>
    picked?.hunk === hi && picked.lines.has(li) ? ' shadow-[inset_3px_0_0_rgb(var(--accent))]' : '';
  const unified = (hi: number) => (l: DiffLine, k: number) => (
    <div
      key={k}
      className={`grid ${canPickLines ? 'grid-cols-[20px_52px_52px_16px_1fr]' : 'grid-cols-[52px_52px_16px_1fr]'} ${BG[l.type]}${pickedRow(hi, k)}`}
    >
      {pick(hi, k, l)}
      <span className={NUM}>{l.oldNo ?? ''}</span>
      <span className={NUM}>{l.newNo ?? ''}</span>
      <span className="select-none text-[#8b96a8]">{SIGN[l.type]}</span>
      <span className="whitespace-pre pr-4">
        <Code text={l.text} plain={isMd} change={showWhitespace ? inlineChanges.get(l) : undefined} />
      </span>
    </div>
  );
  const half = (hi: number) => (l: DiffLine | null, side: 'old' | 'new', k: string) => (
    <div
      key={k}
      className={`grid ${canPickLines ? 'grid-cols-[20px_52px_1fr]' : 'grid-cols-[52px_1fr]'} ${l ? BG[l.type] : 'bg-white/[0.03]'}${l ? pickedRow(hi, parsed!.hunks[hi].lines.indexOf(l)) : ''}`}
    >
      {canPickLines && (l ? pick(hi, parsed!.hunks[hi].lines.indexOf(l), l) : <span aria-hidden />)}
      <span className={NUM}>{l ? (side === 'old' ? l.oldNo : l.newNo) : ''}</span>
      <span className="whitespace-pre pr-2">
        {l ? <Code text={l.text} plain={isMd} change={showWhitespace ? inlineChanges.get(l) : undefined} /> : ' '}
      </span>
    </div>
  );

  const lines = content?.data?.split('\n') ?? [];
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  const showBlame = blame && view === 'code' && !!blameRes?.data;

  return (
    <section className="flex h-full min-w-0 flex-col bg-[#1b1f27]" aria-label="File changes">
      <div className="glass-detail-header flex min-h-[56px] items-center gap-2 border-b border-surface bg-mantle px-4">
        <FilePen size={15} className="shrink-0 text-[#fab387]" aria-hidden />
        <span className="min-w-0 flex-1 py-1" title={file.path}>
          <span className="block truncate text-base font-semibold">{file.path.slice(i + 1)}</span>
          {i >= 0 && <span className="block truncate text-xs text-sub">{file.path.slice(0, i + 1)}</span>}
        </span>
        <span className="text-xs text-sub">UTF-8</span>
        <span
          className={`rounded-md border px-2 py-1 font-mono text-xs ${historyView ? 'border-accent/50 bg-accent/10 text-accent' : 'border-surface bg-crust/50 text-sub'}`}
          title={historyView ? 'Viewing this file in an earlier commit from History' : undefined}
        >
          {area ?? (readOnlySnapshot ? 'stash' : hash.slice(0, 7))}
        </span>
        {historyView && (
          <button
            type="button"
            onClick={() => setHistoryView(null)}
            title={`Back to ${openedHash.slice(0, 7)}`}
            className="fade-in rounded-md px-2 py-1 text-xs text-accent hover:bg-accent/10"
          >
            Back to {openedHash.slice(0, 7)}
          </button>
        )}
        {canDiscardFile && (
          <button
            onClick={() => void discard()}
            disabled={discarding || !!working || !!operation || diff?.data == null}
            aria-label={`Discard ${file.path}`}
            title="Discard file changes"
            className="shrink-0 rounded p-1.5 text-danger hover:bg-danger/15 disabled:opacity-40"
          >
            {discarding ? <Loader2 size={16} className="animate-spin" /> : <Trash2 size={16} />}
          </button>
        )}
        {area && area !== 'untracked' && (
          <button
            onClick={() =>
              void api()
                .externalTool(repoPath, 'diff', file.path, area === 'staged')
                .catch((e: Error) =>
                  useRepo
                    .getState()
                    .notify(
                      'error',
                      'Could not open the diff tool',
                      e.message.replace(/^Error invoking remote method '[^']*': (Error: )?/, ''),
                    ),
                )
            }
            aria-label="Open in external diff tool"
            title="Open in external diff tool (git difftool)"
            className="btn-ghost shrink-0 p-1.5"
          >
            <SquareArrowOutUpRight size={16} />
          </button>
        )}
        <button onClick={onClose} aria-label="Close file changes" title="Close (Esc)" className="btn-ghost p-1">
          <X size={18} />
        </button>
      </div>

      <div className="glass-detail-tools flex flex-wrap items-center gap-3 border-b border-surface/60 px-4 py-2">
        <span className="text-xs font-medium text-sub">
          {area ? 'Local changes' : readOnlySnapshot ? 'Stash snapshot · read-only' : 'Commit · read-only'}
        </span>
        <div className="mx-auto flex items-center gap-3">
          {!area && (
            <div role="group" aria-label="View" className={grp}>
              <button
                aria-pressed={mode === 'file'}
                disabled={file.status === 'D' || !!parsed?.binary}
                className={seg(mode === 'file') + ' disabled:opacity-40'}
                onClick={() => setMode('file')}
              >
                File View
              </button>
              <button aria-pressed={mode === 'diff'} className={seg(mode === 'diff')} onClick={() => setMode('diff')}>
                Diff View
              </button>
            </div>
          )}
          {mode === 'file' && hasPreview && (
            <div role="group" aria-label={isMd ? 'Markdown' : isJson ? 'JSON' : 'SVG'} className={grp}>
              <button aria-pressed={view === 'code'} className={seg(view === 'code')} onClick={() => setView('code')}>
                Code
              </button>
              <button
                aria-pressed={view === 'preview'}
                className={seg(view === 'preview')}
                onClick={() => setView('preview')}
              >
                {isJson ? 'Formatted' : 'Preview'}
              </button>
            </div>
          )}
        </div>
        <div className="flex items-center gap-2">
          {mode === 'diff' && !(canPreviewMedia && parsed?.binary) && (
            <button
              type="button"
              aria-pressed={showWhitespace}
              title="Highlight changed text and whitespace within lines"
              onClick={() => setShowWhitespace(!showWhitespace)}
              className={`${seg(showWhitespace)} !rounded-md border border-surface`}
            >
              Highlight changes
            </button>
          )}
          {mode === 'diff' && !(canPreviewMedia && parsed?.binary) && (
            <div role="group" aria-label="Layout" className={grp}>
              <button aria-pressed={!split} className={seg(!split)} onClick={() => setSplit(false)}>
                <Rows2 size={14} aria-hidden /> Unified
              </button>
              <button aria-pressed={split} className={seg(split)} onClick={() => setSplit(true)}>
                <Columns2 size={14} aria-hidden /> Split
              </button>
            </div>
          )}
          {!area && !readOnlySnapshot && (
            <div role="group" aria-label="File tools" className={grp}>
              <button
                aria-pressed={blame}
                disabled={mode === 'file' && view !== 'code'}
                title={
                  mode === 'file' && view !== 'code'
                    ? 'Blame is shown on the code, not the preview'
                    : 'Show who last changed each line (opens File View)'
                }
                className={seg(blame) + ' disabled:opacity-40'}
                onClick={() => {
                  // Blame annotates the whole file, so it switches to File View
                  if (mode !== 'file') {
                    setMode('file');
                    setView('code');
                    setBlame(true);
                  } else setBlame(!blame);
                }}
              >
                <UserRound size={14} aria-hidden /> Blame
              </button>
              <button aria-pressed={history} className={seg(history)} onClick={() => setHistory(!history)}>
                <History size={14} aria-hidden /> History
              </button>
            </div>
          )}
        </div>
      </div>

      <div className="flex min-h-0 flex-1">
        <div className="min-h-0 min-w-0 flex-1 overflow-auto font-mono text-sm leading-[22px]">
          {err(discardError)}
          {mode === 'diff' && !diff && <CodeSkeleton label="Loading changes…" />}
          {mode === 'diff' && staleWorkingFile ? (
            <div role="alert" className="m-4 rounded-md border border-warning/40 bg-warning/10 p-4 font-sans">
              <p className="text-sm font-medium text-warning">This change has moved since you opened it.</p>
              <p className="mt-1 text-sm text-sub">
                Refresh the working changes to see its current staged or unstaged status.
              </p>
              <div className="mt-3 flex gap-2">
                <button onClick={() => void onRefresh?.()} className="btn-primary min-h-[40px] px-3">
                  Refresh changes
                </button>
                <button onClick={onClose} className="btn-secondary min-h-[40px] px-3">
                  Close diff
                </button>
              </div>
            </div>
          ) : (
            mode === 'diff' && err(diff?.error)
          )}
          {mode === 'diff' && parsed?.binary && canPreviewMedia && (
            <MediaPreview path={file.path} loadAfter={loadAfterBlob} loadBefore={loadBeforeBlob} deps={key} />
          )}
          {mode === 'diff' && parsed?.binary && !canPreviewMedia && (
            <div className="p-4 text-sub">Binary file — no text diff available.</div>
          )}
          {mode === 'diff' && parsed && !parsed.binary && !parsed.hunks.length && (
            <div className="p-4 text-sub">No textual changes to display.</div>
          )}
          {mode === 'diff' &&
            parsed?.hunks.map((h, hi) => (
              <section key={hi} className="mb-3 min-w-0">
                <div className="sticky top-0 z-10 flex min-h-[32px] items-center gap-3 border-y border-surface bg-[#232a35] px-4 text-xs text-[#8b96a8]">
                  <span className="min-w-0 flex-1 truncate">{h.header}</span>
                  {picked?.hunk === hi && (
                    <>
                      <span className="shrink-0 font-sans text-[#a9e5ff]" aria-live="polite">
                        {picked.lines.size} line{picked.lines.size === 1 ? '' : 's'} selected
                      </span>
                      {canStageHunks && (
                        <button
                          type="button"
                          onClick={() =>
                            void stageHunk(
                              hi,
                              [...picked.lines].sort((a, b) => a - b),
                            )
                          }
                          disabled={discarding || !!working || !!operation}
                          className="shrink-0 rounded border border-accent/60 bg-accent/15 px-2 py-1 font-sans text-[#a9e5ff] hover:bg-accent/25 disabled:opacity-40"
                        >
                          {area === 'staged' ? 'Unstage lines' : 'Stage lines'}
                        </button>
                      )}
                      {canDiscardHunks && (
                        <button
                          type="button"
                          onClick={() =>
                            void discard(
                              hi,
                              [...picked.lines].sort((a, b) => a - b),
                            )
                          }
                          disabled={discarding || !!working || !!operation}
                          className="flex shrink-0 items-center gap-1.5 rounded px-2 py-1 font-sans text-danger hover:bg-danger/15 disabled:opacity-40"
                        >
                          <Trash2 size={13} aria-hidden /> Discard lines
                        </button>
                      )}
                      <button
                        type="button"
                        onClick={() => setPicked(null)}
                        className="shrink-0 rounded px-2 py-1 font-sans hover:bg-white/10"
                      >
                        Clear
                      </button>
                    </>
                  )}
                  {picked?.hunk !== hi && canStageHunks && (
                    <button
                      type="button"
                      onClick={() => void stageHunk(hi)}
                      disabled={discarding || !!working || !!operation}
                      aria-label={`${area === 'staged' ? 'Unstage' : 'Stage'} hunk ${hi + 1}`}
                      className="shrink-0 rounded border border-accent/40 px-2 py-1 font-sans text-[#a9e5ff] hover:bg-accent/15 disabled:opacity-40"
                    >
                      {area === 'staged' ? 'Unstage hunk' : 'Stage hunk'}
                    </button>
                  )}
                  {picked?.hunk !== hi && canDiscardHunks && (
                    <button
                      onClick={() => void discard(hi)}
                      disabled={discarding || !!working || !!operation}
                      title="Discard this hunk"
                      aria-label={`Discard hunk ${hi + 1}`}
                      className="flex shrink-0 items-center gap-1.5 rounded px-2 py-1 font-sans text-danger hover:bg-danger/15 disabled:opacity-40"
                    >
                      <Trash2 size={13} aria-hidden /> Discard hunk
                    </button>
                  )}
                </div>
                {split ? (
                  <SplitHunk lines={h.lines} side={half(hi)} />
                ) : (
                  <div className="overflow-x-auto">
                    <div className="min-w-max">{h.lines.map(unified(hi))}</div>
                  </div>
                )}
              </section>
            ))}

          {mode === 'file' && !content && <CodeSkeleton label="Loading file…" lines={18} />}
          {mode === 'file' && err(content?.error)}
          {mode === 'file' && content?.data != null && view === 'preview' && isMd && <Markdown text={content.data} />}
          {mode === 'file' && content?.data != null && view === 'preview' && isJson && (
            <JsonPreview text={content.data} />
          )}
          {mode === 'file' && view === 'preview' && isSvg && (
            <MediaPreview path={file.path} loadAfter={loadAfterBlob} deps={key} />
          )}
          {mode === 'file' && content?.data != null && !(view === 'preview' && hasPreview) && (
            <div className="min-w-max py-2">
              {blame && !blameRes && (
                <div role="status" className="flex items-center gap-2 px-4 pb-2 font-sans text-sub">
                  <Spinner size={14} /> Loading blame…
                </div>
              )}
              {blame && blameRes?.error && err(blameRes.error)}
              {lines.map((t, k) => {
                const b = showBlame ? blameRes!.data![k] : undefined;
                const first = b && blameRes!.data![k - 1]?.hash !== b.hash;
                return (
                  <div key={k} className={`grid ${showBlame ? 'grid-cols-[250px_56px_1fr]' : 'grid-cols-[56px_1fr]'}`}>
                    {showBlame && (
                      <button
                        disabled={!first}
                        onClick={() => b && onJumpToCommit?.(b.hash)}
                        title={b ? `${b.author} · ${b.hash.slice(0, 7)} — jump to commit` : ''}
                        className={`flex items-center gap-2 overflow-hidden border-r border-surface/60 px-3 text-left font-sans text-xs ${first ? 'text-[#8b96a8] hover:text-accent' : 'cursor-default'}`}
                      >
                        {first && (
                          <>
                            <span className="font-mono text-accent">{b!.hash.slice(0, 7)}</span>
                            <span className="truncate">{b!.author}</span>
                            <span className="ml-auto shrink-0">{relTime(new Date(b!.time).toISOString())}</span>
                          </>
                        )}
                      </button>
                    )}
                    <span className={NUM}>{k + 1}</span>
                    <span className="whitespace-pre pr-4">
                      <Code text={t} />
                    </span>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {history && (
          <aside
            aria-label="File history"
            className="flex w-[300px] shrink-0 flex-col border-l border-surface bg-mantle"
          >
            <div className="border-b border-surface px-4 py-2 text-sm font-semibold">History</div>
            <div className="min-h-0 flex-1 overflow-auto">
              {!histRes && <ListSkeleton label="Loading history…" />}
              {err(histRes?.error)}
              {histRes?.data?.map((h) => (
                <button
                  key={h.hash}
                  onClick={() =>
                    setHistoryView(h.hash === openedHash ? null : { hash: h.hash, path: h.path ?? openedFile.path })
                  }
                  aria-current={h.hash === hash ? 'true' : undefined}
                  className={`block w-full border-b border-surface/50 px-4 py-2 text-left font-sans hover:bg-surface/40 ${h.hash === hash ? 'bg-accent/15' : ''}`}
                >
                  <div className="truncate text-sm">{h.subject}</div>
                  <div className="mt-0.5 flex gap-2 text-xs text-sub">
                    <span className="font-mono text-accent">{h.hash.slice(0, 7)}</span>
                    <span className="truncate">{h.author}</span>
                    <span className="ml-auto shrink-0">{relTime(h.date)}</span>
                  </div>
                </button>
              ))}
              {histRes?.data && !histRes.data.length && <div className="p-4 text-sub">No history found.</div>}
            </div>
          </aside>
        )}
      </div>
    </section>
  );
}
