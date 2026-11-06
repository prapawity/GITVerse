import { useCallback, useEffect, useRef, useState } from 'react';
import type { GraphLayout, GraphRow, RefLabel } from '../shared/types';
import { groupRefs } from '../lib/refGroups';
import { Spinner } from './Loading';
import { useSettings } from '../store/settingsStore';

const ROW_H = 28;
const LANE_W = 16;
const PAD = 12;
const AV = 9; // avatar radius
const DOT = 3.5; // merge-commit dot radius
const REF_W = 150;
const GRAPH_MIN = 80;
const HEAD_H = 28;
const PALETTE = ['#4fc1e9', '#a855f7', '#a6e22e', '#f5a623', '#ec4899', '#2dd4bf', '#f97316', '#3b82f6'];
const LIGHT_PALETTE = ['#087eaa', '#8334c8', '#628b08', '#a86400', '#ba2675', '#008e81', '#c64f08', '#2563c5'];
const col = (i: number, light: boolean) => (light ? LIGHT_PALETTE : PALETTE)[i % PALETTE.length];
const FONT = '13px Inter, system-ui, sans-serif';

export const relTime = (iso: string) => {
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 3600) return 'just now';
  const d = s / 86400;
  if (d < 1) { const h = Math.floor(s / 3600); return h === 1 ? 'an hour ago' : `${h} hours ago`; }
  if (d < 2) return 'yesterday';
  if (d < 7) return `${Math.floor(d)} days ago`;
  if (d < 14) return 'a week ago';
  if (d < 30) return `${Math.floor(d / 7)} weeks ago`;
  if (d < 60) return 'a month ago';
  if (d < 365) return `${Math.floor(d / 30)} months ago`;
  return Math.floor(d / 365) < 2 ? 'a year ago' : `${Math.floor(d / 365)} years ago`;
};

interface Props {
  layout: GraphLayout;
  selectedHash: string | null;
  selectedHashes: string[];
  filter?: string;
  onSelect: (hash: string, hashes: string[]) => void;
  onContextMenu?: (hash: string, x: number, y: number) => void;
  onDoubleClick?: (ref: RefLabel) => void;
  hasMore?: boolean;
  loadingMore?: boolean;
  onLoadMore?: () => void;
  headHash?: string | null;
  changeCount: number;
  wipSelected: boolean;
  onSelectWip: () => void;
  navigate?: { hash: string; id: number } | null;
  onLocateCurrent?: () => void;
}

const matches = (r: GraphRow, q: string) => {
  const c = r.commit;
  q = q.toLowerCase();
  return c.hash.startsWith(q) || c.subject.toLowerCase().includes(q) || c.author.toLowerCase().includes(q);
};
const initials = (n: string) => n.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join('').toUpperCase() || '?';

function fit(ctx: CanvasRenderingContext2D, text: string, max: number) {
  if (ctx.measureText(text).width <= max) return text;
  let lo = 0, hi = text.length;
  while (lo < hi) {
    const m = (lo + hi + 1) >> 1;
    if (ctx.measureText(text.slice(0, m) + '…').width <= max) lo = m;
    else hi = m - 1;
  }
  return text.slice(0, lo) + '…';
}

/** Virtualised canvas modelled on GitKraken: BRANCH/TAG | GRAPH | COMMIT MESSAGE. */
export function CommitGraph({ layout, selectedHash, selectedHashes, filter = '', onSelect, onContextMenu, onDoubleClick, hasMore, loadingMore, onLoadMore, headHash, changeCount, wipSelected, onSelectWip, navigate, onLocateCurrent }: Props) {
  const light = useSettings((s) => s.theme === 'light');
  const scrollRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const anchor = useRef<string | null>(null);
  const [size, setSize] = useState({ w: 800, h: 600 });
  const [hover, setHover] = useState<number | null>(null);
  const [hoverX, setHoverX] = useState(0);
  const [scrollTop, setScrollTop] = useState(0);
  const [msgScroll, setMsgScroll] = useState(0);
  const maxMsgW = useRef(0); // widest message drawn so far; drives the horizontal scroll range
  const [, setMsgVer] = useState(0); // re-render once the range grows so the scrollbar appears

  const rows = filter ? layout.rows.filter((r) => matches(r, filter)) : layout.rows;
  const headIndex = headHash ? rows.findIndex((row) => row.commit.hash === headHash) : -1;
  const showLines = !filter;
  const wipRows = changeCount > 0 && showLines ? 1 : 0;
  const wipOffset = wipRows * LANE_W;
  const totalRows = rows.length + wipRows;
  // GitKraken keeps the graph column a fixed (user-resizable) width and lets wide histories scroll sideways
  const [colW, setColW] = useState(240);
  const [gScroll, setGScroll] = useState(0);
  const naturalW = PAD * 2 + Math.max(2, layout.maxLanes) * LANE_W + wipOffset;
  const graphW = colW;
  const maxGScroll = Math.max(0, naturalW - graphW);
  const gs = Math.min(gScroll, maxGScroll);
  const gx = (lane: number) => REF_W + PAD + wipOffset + lane * LANE_W + LANE_W / 2 - gs;
  const gL = REF_W, gR = REF_W + graphW;
  const clampX = (x: number) => Math.max(gL, Math.min(gR, x));
  const msgX = REF_W + graphW + 10;
  const availMsg = Math.max(0, size.w - msgX - 12);
  const maxMsgScroll = Math.max(0, maxMsgW.current - availMsg + 110); // +110 so the end clears the date badge
  const ms = Math.min(msgScroll, maxMsgScroll);

  useEffect(() => {
    const el = scrollRef.current!;
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    if (!navigate) return;
    const index = rows.findIndex((row) => row.commit.hash === navigate.hash);
    if (index < 0 || !scrollRef.current) return;
    const laneX = PAD + wipOffset + rows[index].col * LANE_W + LANE_W / 2;
    setGScroll((value) => laneX < value ? Math.max(0, laneX - PAD) : laneX > value + graphW ? Math.min(maxGScroll, laneX - graphW + PAD) : value);
    scrollRef.current.scrollTo({ top: Math.max(0, (index + wipRows) * ROW_H - (scrollRef.current.clientHeight - ROW_H) / 2), behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
  }, [navigate, layout.rows, filter]); // eslint-disable-line react-hooks/exhaustive-deps

  // Lazy history: ask for the next page when the user scrolls near the end of what is loaded.
  useEffect(() => {
    if (!hasMore || loadingMore || filter) return;
    if (scrollTop + size.h > totalRows * ROW_H - ROW_H * 40) onLoadMore?.();
  }, [scrollTop, size.h, totalRows, hasMore, loadingMore, filter, onLoadMore]);

  const draw = useCallback(() => {
    const cv = canvasRef.current;
    if (!cv) return;
    const dpr = window.devicePixelRatio || 1;
    cv.width = size.w * dpr;
    cv.height = size.h * dpr;
    const ctx = cv.getContext('2d')!;
    ctx.scale(dpr, dpr);
    ctx.font = FONT;
    ctx.textBaseline = 'middle';

    const first = Math.max(0, Math.floor(scrollTop / ROW_H) - 1 - wipRows);
    const last = Math.min(rows.length - 1, Math.ceil((scrollTop + size.h) / ROW_H) + 1 - wipRows);
    const label = (i: number) => (rows[i] ? relTime(rows[i].commit.date) : '');

    if (wipRows && scrollTop < ROW_H) {
      const top = -scrollTop;
      const x = clampX(REF_W + PAD + LANE_W / 2 - gs);
      if (wipSelected || hover === -1) {
        ctx.fillStyle = wipSelected ? 'rgba(79,193,233,0.14)' : 'rgba(255,255,255,0.04)';
        ctx.fillRect(0, top, size.w, ROW_H);
      }
      ctx.fillStyle = 'rgba(76,194,255,0.18)';
      ctx.fillRect(x, top + 3, msgX - 6 - x, ROW_H - 6);
      ctx.fillStyle = light ? '#536478' : '#9eacbe';
      ctx.fillText('// WIP', msgX, top + ROW_H / 2);
      ctx.fillStyle = light ? '#9b5a00' : '#e3ad62';
      ctx.fillText(`✎ ${changeCount}`, msgX + 64, top + ROW_H / 2);
    }

    // pass 1: row highlight, node→message band, date-group separators
    for (let i = first; i <= last; i++) {
      const row = rows[i];
      const top = (i + wipRows) * ROW_H - scrollTop;
      const cx = gx(showLines ? row.col : 0);
      const lane = col(row.color, light);
      const selected = selectedHashes.includes(row.commit.hash) || row.commit.hash === selectedHash;
      if (selected || i === hover) {
        ctx.fillStyle = selected ? 'rgba(79,193,233,0.14)' : 'rgba(255,255,255,0.04)';
        ctx.fillRect(0, top, size.w, ROW_H);
      }
      // band from the node across to the message column, ending in a lane-coloured bar
      const bx = clampX(cx);
      ctx.fillStyle = lane + (selected ? '40' : '1f');
      ctx.fillRect(bx, top + 3, msgX - 6 - bx, ROW_H - 6);
      ctx.fillStyle = lane;
      ctx.fillRect(msgX - 8, top + 3, 3, ROW_H - 6);
      // separator where the relative-date bucket changes
      if (i > 0 && label(i) !== label(i - 1)) {
        ctx.fillStyle = light ? 'rgba(0,0,0,0.10)' : 'rgba(255,255,255,0.08)';
        ctx.fillRect(4, top, size.w - 8, 1);
      }
    }

    // pass 2: lane lines
    ctx.save();
    ctx.beginPath();
    ctx.rect(gL, 0, graphW, size.h);
    ctx.clip();
    if (showLines) {
      if (wipRows) {
        const x = REF_W + PAD + LANE_W / 2 - gs;
        const start = ROW_H / 2 - scrollTop;
        ctx.save();
        ctx.strokeStyle = '#4cc2ff';
        ctx.lineWidth = 2;
        ctx.setLineDash([2, 4]);
        if (headIndex >= 0) {
          const end = (headIndex + wipRows) * ROW_H - scrollTop + ROW_H / 2;
          if (end > 0) {
            ctx.beginPath();
            ctx.moveTo(x, start);
            ctx.lineTo(x, end);
            ctx.lineTo(gx(rows[headIndex].col), end);
            ctx.stroke();
          }
        }
        if (start + 9 >= 0 && start - 9 <= size.h) {
          ctx.fillStyle = getComputedStyle(document.documentElement).getPropertyValue('--graph').trim() || '#1b1f27';
          ctx.beginPath();
          ctx.arc(x, start, 9, 0, Math.PI * 2);
          ctx.fill();
          ctx.stroke();
        }
        ctx.restore();
      }
      ctx.lineWidth = 2;
      ctx.lineCap = 'round';
      const r = 6;
      for (let i = first; i <= last; i++) {
        const row = rows[i];
        const top = (i + wipRows) * ROW_H - scrollTop;
        const mid = top + ROW_H / 2;
        for (const sg of row.segments) {
          ctx.strokeStyle = col(sg.color, light);
          ctx.beginPath();
          const x1 = gx(sg.x1), x2 = gx(sg.x2), d = Math.sign(x2 - x1);
          if (sg.x1 === sg.x2) {
            const [y1, y2] = sg.half === 'top' ? [top, mid] : [mid, top + ROW_H];
            ctx.moveTo(x1, y1);
            ctx.lineTo(x2, y2);
          } else if (sg.half === 'top') {
            ctx.moveTo(x1, top);
            ctx.lineTo(x1, mid - r);
            ctx.quadraticCurveTo(x1, mid, x1 + d * r, mid);
            ctx.lineTo(x2, mid);
          } else {
            ctx.moveTo(x1, mid);
            ctx.lineTo(x2 - d * r, mid);
            ctx.quadraticCurveTo(x2, mid, x2, mid + r);
            ctx.lineTo(x2, top + ROW_H);
          }
          ctx.stroke();
        }
      }
    }

    ctx.restore();

    let grew = false;
    // pass 3: refs, nodes, text, date badges
    for (let i = first; i <= last; i++) {
      const row = rows[i];
      const c = row.commit;
      const top = (i + wipRows) * ROW_H - scrollTop;
      const mid = top + ROW_H / 2;
      const cx = gx(showLines ? row.col : 0);
      const lane = col(row.color, light);

      if (c.refs.length) {
        const groups = groupRefs(c.refs);
        const group = groups.find((x) => x.ref.current) ?? groups[0];
        const ref = group.ref;
        const extra = groups.length > 1 ? `+${groups.length - 1}` : '';
        ctx.font = ref.current ? '600 15.6px Inter, system-ui, sans-serif' : FONT;
        const iconW = ref.kind === 'remote' || ref.kind === 'tag' || group.remotes.length ? 18 : 0;
        const extraW = extra ? ctx.measureText(extra).width + 8 : 0;
        const name = fit(ctx, ref.kind === 'head' ? 'Detached HEAD' : ref.name, REF_W - 30 - iconW - extraW);
        const w = ctx.measureText(name).width + 16 + iconW + extraW;
        const dim = !ref.current && c.hash !== selectedHash;
        ctx.globalAlpha = dim ? 0.75 : 1;
        // connector from chip to node
        ctx.strokeStyle = lane + '99';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(8 + w, mid);
        ctx.lineTo(clampX(cx), mid);
        ctx.stroke();
        ctx.fillStyle = ref.current ? lane + '55' : light ? '#d9e7f1' : '#233847';
        ctx.beginPath();
        const chipHeight = ref.current ? 26.4 : 22;
        ctx.roundRect(8, mid - chipHeight / 2, w, chipHeight, 3);
        ctx.fill();
        if (ref.current) { ctx.strokeStyle = lane; ctx.lineWidth = 1; ctx.stroke(); }
        ctx.fillStyle = light ? '#1d2939' : '#e8eef6';
        ctx.fillText(name, 16, mid + 0.5);
        let ix = 16 + ctx.measureText(name).width + 6;
        ctx.strokeStyle = light ? '#526579' : '#c8d3df';
        ctx.lineWidth = 1.3;
        if (ref.kind === 'remote' || group.remotes.length) {
          // cloud glyph
          ctx.beginPath();
          ctx.moveTo(ix + 3, mid + 4);
          ctx.arc(ix + 4, mid + 1, 3, Math.PI / 2, Math.PI * 1.5);
          ctx.arc(ix + 8, mid - 1, 4, Math.PI, 0);
          ctx.arc(ix + 12, mid + 1.5, 2.5, Math.PI * 1.5, Math.PI / 2);
          ctx.closePath();
          ctx.stroke();
          ix += iconW;
        } else if (ref.kind === 'tag') {
          // tag glyph
          ctx.beginPath();
          ctx.moveTo(ix, mid - 4);
          ctx.lineTo(ix + 7, mid - 4);
          ctx.lineTo(ix + 12, mid + 1);
          ctx.lineTo(ix + 7, mid + 6);
          ctx.lineTo(ix, mid + 1);
          ctx.closePath();
          ctx.stroke();
          ix += iconW;
        }
        if (extra) {
          ctx.fillStyle = light ? '#536478' : '#9aa7b8';
          ctx.fillText(extra, ix, mid + 0.5);
        }
        ctx.globalAlpha = 1;
        ctx.font = FONT;
      }

      // node (clipped to the graph column)
      ctx.save();
      ctx.beginPath();
      ctx.rect(gL, top, graphW, ROW_H);
      ctx.clip();
      if (c.parents.length > 1) {
        ctx.beginPath();
        ctx.arc(cx, mid, DOT, 0, Math.PI * 2);
        ctx.fillStyle = lane;
        ctx.fill();
      } else {
        ctx.beginPath();
        ctx.arc(cx, mid, AV + 1, 0, Math.PI * 2);
        ctx.fillStyle = lane;
        ctx.fill();
        ctx.beginPath();
        ctx.arc(cx, mid, AV - 1.5, 0, Math.PI * 2);
        ctx.fillStyle = light ? '#f4f7fb' : '#1b2633';
        ctx.fill();
        ctx.fillStyle = lane;
        ctx.font = 'bold 8px Inter, system-ui, sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText(initials(c.author), cx, mid + 0.5);
        ctx.textAlign = 'left';
      }
      ctx.restore();

      // message: subject, then dim body preview (GitKraken shows this for merges)
      ctx.font = FONT;
      const subjW = ctx.measureText(c.subject).width;
      const total = c.body ? subjW + 24 + ctx.measureText(c.body).width : subjW;
      if (total > maxMsgW.current + 1) { maxMsgW.current = total; grew = true; }
      ctx.save();
      ctx.beginPath();
      ctx.rect(msgX, top, size.w - msgX, ROW_H); // clip so scrolled text never bleeds into the graph
      ctx.clip();
      ctx.fillStyle = light ? '#1d2939' : '#e8eef6';
      ctx.fillText(c.subject, msgX - ms, mid + 0.5);
      if (c.body) {
        ctx.fillStyle = light ? '#586b81' : '#8b96a8';
        ctx.fillText(c.body, msgX - ms + subjW + 24, mid + 0.5);
      }
      ctx.restore();

      // date badge on the last row of each relative-date bucket
      if (label(i) !== label(i + 1)) {
        ctx.font = '11px Inter, system-ui, sans-serif';
        const t = label(i);
        const tw = ctx.measureText(t).width + 12;
        ctx.fillStyle = light ? '#d9e2ed' : '#2b3442';
        ctx.beginPath();
        ctx.roundRect(size.w - tw - 14, top + ROW_H - 9, tw, 16, 3);
        ctx.fill();
        ctx.fillStyle = light ? '#43546a' : '#c5cdd8';
        ctx.fillText(t, size.w - tw - 8, top + ROW_H - 0.5);
        ctx.font = FONT;
      }
    }
    if (grew) setMsgVer((v) => v + 1);
  }, [rows, size, scrollTop, selectedHash, selectedHashes, hover, showLines, graphW, msgX, gs, ms, changeCount, wipSelected, wipRows, headIndex, light]);

  useEffect(() => {
    const id = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(id);
  }, [draw]);

  const rowAt = (e: React.MouseEvent) => {
    const rect = scrollRef.current!.getBoundingClientRect();
    const i = Math.floor((e.clientY - rect.top + scrollTop) / ROW_H) - wipRows;
    return i >= -wipRows && i < rows.length ? i : null;
  };

  const headCls = 'px-3 text-[11px] font-mono uppercase tracking-wider text-sub flex items-center';
  return (
    <div className="relative flex h-full w-full flex-col bg-[var(--graph)]">
      <div className="flex shrink-0 border-b border-surface bg-[var(--graph)]" style={{ height: HEAD_H }}>
        <div className={headCls} style={{ width: REF_W }}>Branch / Tag</div>
        <div className={headCls + ' relative'} style={{ width: graphW }}>
          Graph
          <div
            role="separator"
            aria-label="Resize graph column"
            aria-orientation="vertical"
            className="absolute right-0 top-0 h-full w-1.5 cursor-col-resize hover:bg-[#4cc2ff]/60"
            onMouseDown={(e) => {
              const x0 = e.clientX, w0 = colW;
              const move = (ev: MouseEvent) => setColW(Math.max(GRAPH_MIN, Math.min(size.w - REF_W - 200, w0 + ev.clientX - x0)));
              const up = () => { window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up); };
              window.addEventListener('mousemove', move);
              window.addEventListener('mouseup', up);
            }}
            onDoubleClick={() => setColW(Math.max(GRAPH_MIN, Math.min(naturalW, size.w - REF_W - 200)))}
            title="Drag to resize · double-click to fit all lanes"
          />
        </div>
        <div className={headCls + ' flex-1'}>Commit message</div>
      </div>
      <div
        ref={scrollRef}
        className="relative min-h-0 flex-1 overflow-y-auto overflow-x-hidden"
        onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
        onWheel={(e) => {
          const dx = e.shiftKey ? e.deltaY : e.deltaX;
          if (!dx) return;
          // sideways scroll acts on whichever column the pointer is over
          const x = e.clientX - e.currentTarget.getBoundingClientRect().left;
          const maxNow = Math.max(0, maxMsgW.current - availMsg + 110); // read live: render may be a frame behind
          if (x > msgX) setMsgScroll(Math.max(0, Math.min(maxNow, ms + dx)));
          else if (maxGScroll) setGScroll((v) => Math.max(0, Math.min(maxGScroll, v + dx)));
        }}
        onMouseMove={(e) => { setHover(rowAt(e)); setHoverX(e.clientX - e.currentTarget.getBoundingClientRect().left); }}
        onMouseLeave={() => setHover(null)}
        onClick={(e) => {
          const i = rowAt(e);
          if (i === -1) { anchor.current = null; onSelectWip(); return; }
          if (i === null) return;
          const hash = rows[i].commit.hash;
          const start = rows.findIndex((row) => row.commit.hash === anchor.current);
          if (e.shiftKey && start >= 0) onSelect(hash, rows.slice(Math.min(start, i), Math.max(start, i) + 1).map((row) => row.commit.hash));
          else { anchor.current = hash; onSelect(hash, [hash]); }
        }}
        onDoubleClick={(e) => { const i = rowAt(e); if (e.clientX - e.currentTarget.getBoundingClientRect().left >= REF_W || i === null || i < 0) return; const groups = groupRefs(rows[i].commit.refs); const ref = (groups.find((g) => g.ref.current) ?? groups[0])?.ref; if (ref) onDoubleClick?.(ref); }}
        onContextMenu={(e) => {
          const i = rowAt(e);
          if (i === null || i < 0) return;
          e.preventDefault();
          const hash = rows[i].commit.hash;
          if (!selectedHashes.includes(hash)) { anchor.current = hash; onSelect(hash, [hash]); }
          onContextMenu?.(hash, e.clientX, e.clientY);
        }}
      >
        <div style={{ height: totalRows * ROW_H }} />
        {wipRows > 0 && <button type="button" aria-label={`Local changes, ${changeCount} files`} aria-pressed={wipSelected} onClick={(e) => { e.stopPropagation(); onSelectWip(); }} className="absolute left-0 top-0 z-10 h-7 w-full cursor-pointer bg-transparent focus-visible:outline focus-visible:outline-2 focus-visible:outline-[#4cc2ff]" />}
        {maxMsgScroll > 0 && (() => {
          const track = availMsg;
          const thumb = Math.max(36, (track * track) / (track + maxMsgScroll));
          const left = msgX + (ms / maxMsgScroll) * (track - thumb);
          const stop = (e: React.SyntheticEvent) => e.stopPropagation();
          return (
            <div className="pointer-events-none sticky z-10 h-0" style={{ bottom: 8 }}>
              <div
                role="scrollbar"
                aria-orientation="horizontal"
                aria-label="Scroll commit messages"
                aria-valuenow={Math.round(ms)}
                aria-valuemin={0}
                aria-valuemax={Math.round(maxMsgScroll)}
                className="pointer-events-auto absolute h-2 cursor-grab rounded-full bg-white/30 hover:bg-white/50 active:cursor-grabbing"
                style={{ left, width: thumb, top: -8 }}
                onClick={stop} onDoubleClick={stop} onContextMenu={stop}
                onPointerDown={(e) => {
                  e.stopPropagation();
                  e.currentTarget.setPointerCapture(e.pointerId);
                  const x0 = e.clientX, s0 = ms;
                  const el = e.currentTarget;
                  const move = (ev: PointerEvent) => setMsgScroll(Math.max(0, Math.min(maxMsgScroll, s0 + ((ev.clientX - x0) / Math.max(1, track - thumb)) * maxMsgScroll)));
                  const up = () => { el.removeEventListener('pointermove', move); el.removeEventListener('pointerup', up); };
                  el.addEventListener('pointermove', move);
                  el.addEventListener('pointerup', up);
                }}
              />
            </div>
          );
        })()}
        {maxGScroll > 0 && (
          <div className="pointer-events-none sticky z-10 h-0" style={{ bottom: 8 }}>
            <div className="absolute h-1.5 rounded-full bg-white/25" style={{ left: REF_W + (gs / naturalW) * graphW, width: (graphW / naturalW) * graphW }} />
          </div>
        )}
        <canvas
          ref={canvasRef}
          style={{ position: 'sticky', top: 0, width: size.w, height: size.h, marginTop: -totalRows * ROW_H, pointerEvents: 'none' }}
        />
      </div>
      {headHash && (headIndex < 0 || (headIndex + wipRows + 1) * ROW_H <= scrollTop || (headIndex + wipRows) * ROW_H >= scrollTop + size.h) && (
        <button onClick={onLocateCurrent} className={`absolute right-4 z-20 rounded-full border border-[#4cc2ff]/50 bg-[#26374a] px-3 py-1.5 text-xs font-medium text-[#bdeaff] shadow-lg hover:bg-[#34526e] ${headIndex >= 0 && (headIndex + wipRows + 1) * ROW_H <= scrollTop ? 'top-9' : 'bottom-4'}`}>
          {headIndex < 0 ? (filter ? 'Current hidden by search' : 'Current not in loaded history') : (headIndex + wipRows + 1) * ROW_H <= scrollTop ? '↑ Current above' : '↓ Current below'} · Go to current
        </button>
      )}
      {/* hovering the branch/tag column of any commit that has refs lists all of them with their full names */}
      {hover !== null && hoverX < REF_W && rows[hover]?.commit.refs.length > 0 && (() => {
        const refs = groupRefs(rows[hover].commit.refs);
        const shown = refs.slice(0, 14);
        // long names wrap onto extra lines, so estimate the height from the text length instead of a fixed row
        const h = shown.reduce((n, g) => n + 8 + 19 * Math.max(1, Math.ceil((g.ref.name.length + g.remotes.join(', ').length) / 44)), 16) + (refs.length > shown.length ? 24 : 0);
        const rowTop = HEAD_H + (hover + wipRows) * ROW_H - scrollTop;
        const top = rowTop + ROW_H + h > size.h + HEAD_H ? Math.max(HEAD_H, rowTop - h) : rowTop + ROW_H;
        const glyph = { remote: '☁', tag: '◆', local: '●', head: '●' } as const;
        return (
          <div role="tooltip" className="pointer-events-none absolute z-30 min-w-[220px] max-w-[min(480px,60vw)] rounded-lg border border-surface bg-mantle py-2 shadow-2xl" style={{ left: 8, top }}>
            {shown.map(({ ref: r, remotes }) => (
              <div key={r.kind + r.name} className={`flex items-start gap-2 px-3 py-[4px] text-[13px] leading-[19px] ${r.current ? 'font-semibold text-[#4cc2ff]' : ''}`}>
                <span aria-hidden className="mt-px w-4 shrink-0 text-center text-[11px] text-sub">{glyph[r.kind]}</span>
                <span className="min-w-0 break-all">{r.kind === 'head' ? 'Detached HEAD' : r.name}{remotes.length > 0 && <span className="ml-2 text-[11px] font-normal text-sub">☁ {remotes.join(', ')}</span>}</span>
                <span className="ml-auto shrink-0 pl-3 text-[11px] text-sub">{r.current ? 'current' : r.kind}</span>
              </div>
            ))}
            {refs.length > shown.length && <div className="px-3 pt-1 text-[12px] text-sub">+{refs.length - shown.length} more</div>}
          </div>
        );
      })()}
      {(loadingMore || (filter && hasMore)) && (
        <div className="pointer-events-none absolute inset-x-0 bottom-4 z-20 flex justify-center">
          <div role="status" className="pointer-events-auto rounded-full border border-surface bg-mantle px-4 py-1.5 text-[13px] shadow-lg">
            {loadingMore ? <span className="flex items-center gap-2"><Spinner size={14} className="text-[#4cc2ff]" /> Loading more commits…</span> : (
              <>Searching {layout.rows.length} loaded commits · <button className="text-[#4cc2ff] underline" onClick={onLoadMore}>Load more</button></>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
