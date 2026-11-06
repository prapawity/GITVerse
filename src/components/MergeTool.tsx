import { useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, ChevronDown, ChevronUp, Loader2, RotateCcw, Sparkles, X } from 'lucide-react';
import { useSettings } from '../store/settingsStore';
import { providerLabel } from '../shared/aiTypes';
import { buildOutput, conflictPrompt, hasMarkers, matchResolution, parseConflicts, piece, type Pick, type Seg } from '../lib/conflicts';
import { highlight } from '../lib/diff';
import { CodeSkeleton } from './Loading';
import { useRepo } from '../store/repoStore';
import { askConfirm } from './Dialogs';

const api = () => (window as any).gitApi;
const LH = 21; // output line height in px — gutter, bands and textarea must agree
const OUT_PAD = 8;
const BAND = { a: '#4fc1e9', b: '#a855f7', ab: '#34d399', ai: '#f472b6', none: '#f5a623' } as const;
const BAND_NAME = { a: 'from A', b: 'from B', ab: 'A + B', ai: 'by AI', none: 'undecided' } as const;
const Code = ({ text }: { text: string }) => <>{highlight(text).map((k, i) => <span key={i} className={k.c}>{k.t}</span>)}{text === '' && ' '}</>;

/** One side (A or B) of the file: shared text plus that side's version of every conflict, each with a checkbox. */
function Side({ label, tone, segs, side, picks, onToggle, focus, disabled, unknown }: { label: string; tone: string; segs: Seg[]; side: 'a' | 'b'; picks: Pick[]; onToggle: (k: number) => void; focus: number; disabled: boolean; unknown: boolean }) {
  let k = -1;
  return (
    <div className="flex min-h-0 min-w-0 flex-col">
      <div className="flex items-center gap-2 border-b border-surface bg-mantle px-3 py-1.5 text-[13px]">
        <span className="rounded px-1.5 font-semibold text-crust" style={{ background: tone }}>{side.toUpperCase()}</span>
        <span className="truncate">{label}</span>
      </div>
      <div data-pane={side} className="relative min-h-0 flex-1 overflow-auto font-mono text-[13px] leading-[21px]">
        <div className="w-max min-w-full py-1">
          {segs.map((s, i) => {
            if (s.kind === 'text') return s.text.split('\n').map((l, j) => <div key={`${i}-${j}`} className="whitespace-pre px-3 text-text/70"><Code text={l} /></div>);
            k++;
            const idx = k;
            const on = picks[idx]?.[side];
            const pick = picks[idx];
            const state = unknown ? 'selection unknown' : pick?.manual != null ? 'edited manually' : pick?.a && pick?.b ? 'A + B' : pick?.a ? 'A' : pick?.b ? 'B' : pick?.ai != null ? 'custom AI result' : 'undecided';
            const body = side === 'a' ? s.ours : s.theirs;
            return (
              <div key={i} data-conflict={idx} className={`my-1 border-y ${focus === idx ? 'outline outline-2 -outline-offset-2 outline-[#f5a623]' : ''}`} style={{ borderColor: tone + '66', background: tone + (on ? '33' : '14') }}>
                <label className="sticky left-0 flex cursor-pointer items-center gap-2 px-3 py-1 font-sans text-[12px]">
                  <input type="checkbox" ref={(el) => { if (el) el.indeterminate = unknown; }} checked={!unknown && !!on} disabled={disabled} onChange={() => onToggle(idx)} aria-label={`Use ${side.toUpperCase()} for conflict ${idx + 1}`} />
                  Conflict {idx + 1} — use {side.toUpperCase()} <span className="text-sub">({state})</span>
                </label>
                {(body === '' ? [''] : body.split('\n')).map((l, j) => <div key={j} className="whitespace-pre px-3"><Code text={l} /></div>)}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

export function MergeTool({ path }: { path: string }) {
  const { repoPath, operation: op, exec, openConflict, track } = useRepo();
  const [src, setSrc] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [picks, setPicks] = useState<Pick[]>([]);
  const [output, setOutput] = useState('');
  const [edited, setEdited] = useState(false);
  const [focus, setFocus] = useState(0);
  const [aiBusy, setAiBusy] = useState(false);
  const [aiNotes, setAiNotes] = useState<Record<number, string>>({}); // the conflict the user is working on: every pane scrolls to it
  const autoScroll = useSettings((s) => s.conflictAutoScroll);
  const panes = useRef<HTMLDivElement>(null);
  const outBox = useRef<HTMLDivElement>(null);
  const editRanges = useRef<{ start: number; end: number }[] | null>(null);
  const [editMapped, setEditMapped] = useState(true);
  const activeFile = useRef({ repoPath, path });
  const fileVersion = useRef(0);
  activeFile.current = { repoPath, path };

  useEffect(() => {
    let on = true;
    fileVersion.current++;
    setSrc(null); setErr(null); setEdited(false); setFocus(0); setAiNotes({}); setAiBusy(false); setEditMapped(true); editRanges.current = null;
    api().readWorkFile(repoPath, path).then((t: string) => on && setSrc(t)).catch((e: Error) => on && setErr(e.message));
    return () => { on = false; fileVersion.current++; };
  }, [repoPath, path]);

  useEffect(() => {
    const h = (e: KeyboardEvent) => e.key === 'Escape' && !(e.target instanceof HTMLTextAreaElement) && openConflict(null);
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [openConflict]);

  const segs = useMemo(() => (src == null ? [] : parseConflicts(src)), [src]);
  const count = segs.filter((s) => s.kind === 'conflict').length;
  const conflicts = useMemo(() => segs.filter((s): s is Extract<Seg, { kind: 'conflict' }> => s.kind === 'conflict'), [segs]);
  useEffect(() => setPicks(Array.from({ length: count }, () => ({ a: false, b: false }))), [count, src]);
  useEffect(() => { if (!edited) setOutput(buildOutput(segs, picks)); }, [segs, picks, edited]);

  // In a rebase git's "ours" is the branch being rebased onto and "theirs" is your commit being replayed.
  const aLabel = op?.kind === 'rebase' ? `${op.onto} (rebasing onto)` : `${op?.head ?? 'HEAD'} (current)`;
  const bLabel = op?.kind === 'rebase' ? `${op.head} (your commit)` : `${op?.onto ?? 'incoming'} (incoming)`;
  // Where each conflict landed in the merged output (line index + length) and which side supplied it.
  // Only exact while the output is generated from the picks; once hand-edited the line map no longer holds.
  const ranges = useMemo(() => {
    const out: { k: number; start: number; n: number; kind: keyof typeof BAND }[] = [];
    let line = 0, k = -1;
    for (const sg of segs) {
      if (sg.kind === 'text') { line += sg.text.split('\n').length; continue; }
      k++;
      const p = picks[k] ?? { a: false, b: false };
      const n = piece(sg, p).split('\n').length;
      out.push({ k, start: line, n, kind: p.ai != null ? 'ai' : p.a && p.b ? 'ab' : p.a ? 'a' : p.b ? 'b' : 'none' });
      line += n;
    }
    return out;
  }, [segs, picks]);
  const decided = picks.filter((p) => p.a || p.b || p.ai != null || p.manual != null).length;
  const aiPicks = picks.flatMap((p, i) => p.ai != null ? [i] : []);
  const unresolved = hasMarkers(output) || decided < count || (edited && !editMapped);
  const idx = op?.files.indexOf(path) ?? -1;

  const go = (d: 1 | -1) => setFocus((f) => (f + d + count) % count);
  const nextUndecided = () => {
    for (let i = 1; i <= count; i++) {
      const k = (focus + i) % count;
      if (!(picks[k]?.a || picks[k]?.b || picks[k]?.ai != null || picks[k]?.manual != null)) { setFocus(k); return; }
    }
  };
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (!e.altKey || !count || (e.key !== 'ArrowDown' && e.key !== 'ArrowUp')) return;
      e.preventDefault();
      go(e.key === 'ArrowDown' ? 1 : -1);
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }); // eslint-disable-line react-hooks/exhaustive-deps

  // Auto-scroll: bring the focused conflict into view in both panes (a third of the way down, not pinned to the edge)
  useEffect(() => {
    if (!autoScroll || !count) return;
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    panes.current?.querySelectorAll<HTMLElement>('[data-pane]').forEach((box) => {
      const el = box.querySelector<HTMLElement>(`[data-conflict="${focus}"]`);
      if (el) box.scrollTo({ top: Math.max(0, el.offsetTop - box.clientHeight * 0.3), behavior: reduce ? 'auto' : 'smooth' });
    });
  }, [focus, count, src, autoScroll]);

  // ...and bring the matching lines of the merged result into view too
  useEffect(() => {
    const box = outBox.current;
    const r = ranges[focus];
    if (!autoScroll || !box || edited || !r) return;
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    box.scrollTo({ top: Math.max(0, OUT_PAD + r.start * LH - box.clientHeight * 0.3), behavior: reduce ? 'auto' : 'smooth' });
  }, [focus, output, autoScroll, edited, ranges]);

  const toggle = (side: 'a' | 'b') => (k: number) => {
    setFocus(k);
    const next = { a: picks[k].a, b: picks[k].b, [side]: !picks[k][side] };
    if (edited) {
      const rs = editRanges.current;
      if (!rs) return;
      const { start, end } = rs[k];
      const replacement = piece(conflicts[k], next);
      const delta = replacement.length - (end - start);
      setOutput(output.slice(0, start) + replacement + output.slice(end));
      editRanges.current = rs.map((r, i) => i === k ? { start, end: start + replacement.length } : i > k ? { start: r.start + delta, end: r.end + delta } : r);
    }
    setPicks((ps) => ps.map((p, i) => i === k ? next : p));
  };

  const editOutput = (value: string) => {
    let rs = editRanges.current;
    if (!edited) {
      let pos = 0, k = 0;
      rs = [];
      segs.forEach((s, i) => {
        if (i) pos++;
        const text = s.kind === 'text' ? s.text : piece(s, picks[k]);
        if (s.kind === 'conflict') { rs!.push({ start: pos, end: pos + text.length }); k++; }
        pos += text.length;
      });
    }
    if (rs) {
      let start = 0;
      while (start < output.length && start < value.length && output[start] === value[start]) start++;
      let oldEnd = output.length, newEnd = value.length;
      while (oldEnd > start && newEnd > start && output[oldEnd - 1] === value[newEnd - 1]) { oldEnd--; newEnd--; }
      const affected = rs.findIndex((r) => start >= r.start && oldEnd <= r.end);
      const overlaps = rs.some((r, i) => i !== affected && (start < r.end && oldEnd > r.start || start === oldEnd && start === r.start));
      if (overlaps || (affected < 0 && rs.some((r) => start < r.end && oldEnd > r.start))) {
        rs = null;
      } else {
        const delta = newEnd - oldEnd;
        rs = rs.map((r, i) => i === affected ? { ...r, end: r.end + delta } : start <= r.start ? { start: r.start + delta, end: r.end + delta } : r);
        if (affected >= 0) {
          const r = rs[affected];
          setPicks((ps) => ps.map((p, i) => i === affected ? matchResolution(conflicts[i], value.slice(r.start, r.end)) : p));
          setFocus(affected);
        }
      }
    }
    editRanges.current = rs;
    setEditMapped(rs !== null);
    setEdited(true);
    setOutput(value);
  };
  // Ask the chosen AI (Claude / ChatGPT / Copilot) for a resolution of every conflict; the result is only proposed — the user reviews it and saves
  const aiProvider = useSettings((s) => s.aiProvider);
  const aiName = providerLabel(aiProvider);
  const autoResolve = async () => {
    if (edited && !(await askConfirm('Replace edited output?', 'AI suggestions will replace your manual edits in the output. Continue?', { label: 'Continue' }))) return;
    const version = fileVersion.current;
    let proposed = 0;
    let current = true;
    await track(`Asking ${aiName} to resolve conflicts…`, async () => {
      setAiBusy(true);
      try {
        const prompt = conflictPrompt(path, segs, aLabel, bLabel, op ? `${op.kind} of ${op.head} onto ${op.onto}` : 'merge');
        const st = useSettings.getState();
        const model = (aiProvider === 'openai' ? st.openaiModel : aiProvider === 'copilot' ? st.copilotModel : '') || undefined;
        const res = await api().ai.resolveConflict(aiProvider, model, prompt, count);
        current = fileVersion.current === version && activeFile.current.repoPath === repoPath && activeFile.current.path === path;
        if (!current) return;
        if (!res.ok) throw new Error(res.error.message);
        const valid = res.resolutions.filter((r: { index: number }) => Number.isInteger(r.index) && r.index >= 0 && r.index < count);
        proposed = new Set(valid.map((r: { index: number }) => r.index)).size;
        if (!proposed) throw new Error('AI did not return a usable resolution. Your current output was kept.');
        setEdited(false);
        setPicks((ps) => ps.map((p, i) => { const r = valid.find((x: { index: number }) => x.index === i); if (!r) return p; const match = matchResolution(conflicts[i], r.resolved); return { a: match.a, b: match.b, ai: r.resolved }; }));
        setAiNotes(Object.fromEntries(valid.map((r: { index: number; explanation: string }) => [r.index, r.explanation])));
        setFocus(valid[0].index);
      } finally {
        if (fileVersion.current === version && activeFile.current.repoPath === repoPath && activeFile.current.path === path) setAiBusy(false);
      }
    }, { done: () => current ? `${aiName} proposed ${proposed} of ${count} resolutions — review before saving` : null, fail: 'AI auto-resolve failed' });
  };

  const all = async (side: 'a' | 'b') => {
    if (edited && !(await askConfirm('Replace edited output?', 'Taking one side for every conflict will discard your manual edits. Continue?', { label: 'Continue' }))) return;
    setEdited(false); setEditMapped(true); editRanges.current = null;
    setPicks((ps) => ps.map(() => ({ a: side === 'a', b: side === 'b' })));
  };
  const save = () =>
    track('Saving resolution…', async () => {
      await api().writeWorkFile(repoPath, path, output);
      await exec('resolveFile', path, 'mark');
      const next = useRepo.getState().operation?.files.find((f) => f !== path) ?? null;
      openConflict(next); // move on to the next conflicted file, GitKraken-style
    }, { done: `Resolved ${path.split('/').pop()}`, fail: 'Could not save the resolution' });

  return (
    <section aria-label={`Resolve conflicts in ${path}`} className="flex h-full min-h-0 min-w-0 flex-col overflow-hidden bg-[#1b1f27]">
      <div className="flex min-h-[48px] items-center gap-2 border-b border-surface bg-mantle px-4">
        <AlertTriangle size={15} className="shrink-0 text-[#f5a623]" aria-hidden />
        <span className="min-w-0 flex-1 truncate text-[15px]" title={path}>{path}</span>
        {idx >= 0 && op && <span className="text-[12px] text-sub">file {idx + 1} of {op.files.length}</span>}
        <button onClick={() => openConflict(null)} aria-label="Close merge tool" title="Close (Esc)" className="rounded p-1 text-sub hover:bg-surface hover:text-text"><X size={18} /></button>
      </div>

      {err && <div role="alert" className="p-4 text-[#f38ba8]">{err}</div>}
      {src == null && !err && <CodeSkeleton label="Loading conflicted file…" />}

      {src != null && count === 0 && (
        <div className="space-y-3 p-6">
          <p>This file has no conflict markers — it may be binary, or one side deleted it. Pick which version to keep:</p>
          <div className="flex gap-2">
            <button className="min-h-[36px] rounded-md border border-surface px-3 hover:bg-surface/60" onClick={() => exec('resolveFile', path, 'ours')}>Keep A — {aLabel}</button>
            <button className="min-h-[36px] rounded-md border border-surface px-3 hover:bg-surface/60" onClick={() => exec('resolveFile', path, 'theirs')}>Keep B — {bLabel}</button>
          </div>
        </div>
      )}

      {src != null && count > 0 && (
        <>
          <div className="flex flex-wrap items-center gap-2 border-b border-surface/60 px-4 py-2 text-[13px]">
            <div className="flex items-center gap-1" role="group" aria-label="Conflict navigation">
              <button onClick={() => go(-1)} aria-label="Previous conflict" title="Previous conflict (Alt+↑)" className="rounded p-1.5 text-sub hover:bg-surface hover:text-text"><ChevronUp size={16} /></button>
              <span aria-live="polite" className="min-w-[120px] text-center">Conflict {focus + 1} of {count}</span>
              <button onClick={() => go(1)} aria-label="Next conflict" title="Next conflict (Alt+↓)" className="rounded p-1.5 text-sub hover:bg-surface hover:text-text"><ChevronDown size={16} /></button>
              <button onClick={nextUndecided} disabled={decided === count} className="ml-1 min-h-[30px] rounded-md border border-surface px-3 hover:bg-surface/60 disabled:opacity-40">Next undecided</button>
            </div>
            <span className="text-sub">{decided} of {count} decided</span>
            <div className="ml-auto flex flex-wrap gap-2">
              <button onClick={autoResolve} disabled={aiBusy} title={`${aiName} proposes a merged version of every conflict; nothing is saved until you press Save`} className="flex min-h-[30px] items-center gap-1.5 rounded-md bg-gradient-to-r from-[#9333ea] to-[#6366f1] px-3 font-semibold text-white shadow-sm hover:brightness-110 disabled:opacity-50">{aiBusy ? <Loader2 size={14} className="animate-spin" aria-hidden /> : <Sparkles size={14} aria-hidden />} Auto-resolve with AI</button>
              <button onClick={() => all('a')} disabled={aiBusy} className="min-h-[30px] rounded-md border border-surface px-3 hover:bg-surface/60 disabled:opacity-40">Take all A</button>
              <button onClick={() => all('b')} disabled={aiBusy} className="min-h-[30px] rounded-md border border-surface px-3 hover:bg-surface/60 disabled:opacity-40">Take all B</button>
            </div>
          </div>
          <div className="grid min-h-0 min-w-0 flex-1 grid-rows-[minmax(0,1fr)_minmax(0,1fr)]">
            <div ref={panes} className="grid min-h-0 min-w-0 grid-cols-2 grid-rows-[minmax(0,1fr)] divide-x divide-surface border-b border-surface">
              <Side label={aLabel} tone="#4fc1e9" segs={segs} side="a" picks={picks} onToggle={toggle('a')} focus={focus} disabled={aiBusy || !editMapped} unknown={!editMapped} />
              <Side label={bLabel} tone="#a855f7" segs={segs} side="b" picks={picks} onToggle={toggle('b')} focus={focus} disabled={aiBusy || !editMapped} unknown={!editMapped} />
            </div>
            <div className="flex min-h-0 min-w-0 flex-col">
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-surface bg-mantle px-3 py-1.5 text-[13px]">
                <span className="font-semibold">Output</span>
                {edited ? (
                  <>
                    <span className="text-sub">{editMapped ? 'edited by hand' : 'selection unknown — edit crossed conflict boundaries'}</span>
                    <button onClick={async () => { if (await askConfirm('Reset output?', 'Discard manual edits and rebuild the output from the current selections?', { label: 'Reset' })) { setEdited(false); setEditMapped(true); editRanges.current = null; } }} disabled={aiBusy} className="flex items-center gap-1 text-sub hover:text-text disabled:opacity-40"><RotateCcw size={13} aria-hidden /> Reset to picks</button>
                  </>
                ) : (
                  <span className="flex flex-wrap items-center gap-3 text-[12px] text-sub" aria-label="Colour legend">
                    {(['a', 'b', 'ab', 'ai', 'none'] as const).map((k) => (
                      <span key={k} className="flex items-center gap-1"><span aria-hidden className="inline-block h-2.5 w-2.5 rounded-sm" style={{ background: BAND[k] }} />{BAND_NAME[k]}</span>
                    ))}
                  </span>
                )}
                <div className="ml-auto flex items-center gap-1" role="group" aria-label="Output conflict navigation">
                  <span aria-live="polite" className="text-accent text-[#4cc2ff]">conflict {focus + 1} of {count}</span>
                  <button onClick={() => go(-1)} aria-label="Previous conflict" title="Previous conflict (Alt+↑)" className="rounded border border-[#4cc2ff]/60 p-1 text-[#4cc2ff] hover:bg-[#4cc2ff]/15"><ChevronUp size={15} /></button>
                  <button onClick={() => go(1)} aria-label="Next conflict" title="Next conflict (Alt+↓)" className="rounded border border-[#4cc2ff]/60 p-1 text-[#4cc2ff] hover:bg-[#4cc2ff]/15"><ChevronDown size={15} /></button>
                </div>
              </div>
              {aiPicks.length > 0 && !edited && (
                <div className="min-h-0 min-w-0 max-h-[50%] shrink-0 overflow-auto border-b border-[#f472b6]/30 bg-[#f472b6]/10 px-3 py-2 text-[13px]" role="region" aria-label="AI resolution suggestions">
                  <div className="flex flex-wrap items-center gap-2">
                    <Sparkles size={14} className="shrink-0 text-[#f472b6]" aria-hidden />
                    <span className="font-semibold text-[#f5b5d8]">AI suggestions · {aiPicks.length} of {count} conflicts</span>
                    <span className="text-sub">Not saved — review before saving</span>
                  </div>
                  <div className="mt-2 flex flex-wrap gap-1.5" aria-label="AI suggestions">
                    {aiPicks.map((i) => <button key={i} onClick={() => setFocus(i)} aria-pressed={focus === i} className={`rounded border px-2 py-0.5 ${focus === i ? 'border-[#f472b6] bg-[#f472b6]/20 text-text' : 'border-surface text-sub hover:text-text'}`}>Conflict {i + 1}</button>)}
                  </div>
                  {picks[focus]?.ai != null && <div className="mt-2">
                    {aiNotes[focus] && <p className="mb-1 break-words text-sub">{aiNotes[focus]}</p>}
                    <pre className="max-h-28 overflow-auto rounded border border-[#f472b6]/20 bg-crust/70 p-2 font-mono text-xs text-text">{picks[focus].ai || '(empty resolution)'}</pre>
                  </div>}
                </div>
              )}
              <div ref={outBox} className="relative min-h-0 min-w-0 flex-1 overflow-auto bg-[#161a21] font-mono text-[13px]" style={{ lineHeight: `${LH}px` }}>
                <div className="flex min-h-full w-max min-w-full">
                  <div aria-hidden className="sticky left-0 z-10 shrink-0 select-none bg-[#161a21] pr-2 text-right text-[#6c7a89]" style={{ width: 52, paddingTop: OUT_PAD }}>
                    {output.split('\n').map((_, i) => <div key={i}>{i + 1}</div>)}
                  </div>
                  <div className="relative flex-1 border-l border-surface/60">
                    {!edited && ranges.map((r) => (
                      <div
                        key={r.k}
                        aria-hidden
                        className="pointer-events-none absolute inset-x-0"
                        style={{
                          top: OUT_PAD + r.start * LH, height: r.n * LH,
                          background: BAND[r.kind] + (r.k === focus ? '40' : '22'),
                          boxShadow: `inset 3px 0 0 ${BAND[r.kind]}${r.k === focus ? '' : '99'}`,
                        }}
                      />
                    ))}
                    <textarea
                      aria-label="Merged output"
                      value={output}
                      disabled={aiBusy}
                      rows={Math.max(1, output.split('\n').length)}
                      cols={output.split('\n').reduce((width, line) => Math.max(width, line.length + 2), 40)}
                      wrap="off"
                      spellCheck={false}
                      onChange={(e) => editOutput(e.target.value)}
                      className="relative block min-h-full min-w-full resize-none overflow-hidden whitespace-pre bg-transparent px-3 outline-none"
                      style={{ fieldSizing: 'content', lineHeight: `${LH}px`, paddingTop: OUT_PAD, paddingBottom: OUT_PAD } as React.CSSProperties}
                    />
                  </div>
                </div>
              </div>
            </div>
          </div>
          <div className="flex items-center gap-3 border-t border-surface px-4 py-2.5">
            <span className="text-[13px] text-sub">{!editMapped ? 'Cannot map edits to conflicts. Reset to picks to continue.' : unresolved ? (hasMarkers(output) ? 'Output still contains conflict markers' : 'Choose A, B or edit every conflict') : 'Ready to save'}</span>
            <button onClick={save} disabled={unresolved || aiBusy} className="ml-auto min-h-[38px] rounded-md bg-[#4cc2ff] px-4 font-medium text-crust disabled:opacity-40">Save & mark resolved</button>
          </div>
        </>
      )}
    </section>
  );
}
