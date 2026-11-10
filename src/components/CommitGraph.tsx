import { useCallback, useEffect, useRef, useState } from 'react';
import { Laptop } from 'lucide-react';
import type { GraphLayout, GraphRow, RefLabel, Segment } from '../shared/types';
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
  if (d < 1) {
    const h = Math.floor(s / 3600);
    return h === 1 ? 'an hour ago' : `${h} hours ago`;
  }
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
  onContextMenu?: (hash: string, x: number, y: number, ref?: { name: string; kind: 'local' | 'remote' }) => void;
  onDoubleClick?: (ref: RefLabel) => void;
  hasMore?: boolean;
  loadingMore?: boolean;
  onLoadMore?: () => void;
  headHash?: string | null;
  changeCount: number;
  stagedCount?: number;
  wipSelected: boolean;
  onSelectWip: () => void;
  navigate?: { hash: string; id: number } | null;
  onLocateCurrent?: () => void;
  upstream?: { name: string; ahead: number; behind: number; gone: boolean };
}

const matches = (r: GraphRow, q: string) => {
  const c = r.commit;
  q = q.toLowerCase();
  return (
    c.hash.startsWith(q) ||
    c.subject.toLowerCase().includes(q) ||
    c.author.toLowerCase().includes(q) ||
    !!c.stashId?.toLowerCase().includes(q)
  );
};
const initials = (n: string) =>
  n
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0])
    .join('')
    .toUpperCase() || '?';

function fit(ctx: CanvasRenderingContext2D, text: string, max: number) {
  if (ctx.measureText(text).width <= max) return text;
  let lo = 0,
    hi = text.length;
  while (lo < hi) {
    const m = (lo + hi + 1) >> 1;
    if (ctx.measureText(text.slice(0, m) + '…').width <= max) lo = m;
    else hi = m - 1;
  }
  return text.slice(0, lo) + '…';
}

function segmentPath(segment: Segment, x1: number, x2: number, top: number) {
  const path = new Path2D();
  const mid = top + ROW_H / 2;
  const direction = Math.sign(x2 - x1);
  const radius = 6;
  if (x1 === x2) {
    path.moveTo(x1, segment.half === 'top' ? top : mid);
    path.lineTo(x2, segment.half === 'top' ? mid : top + ROW_H);
  } else if (segment.half === 'top') {
    path.moveTo(x1, top);
    path.lineTo(x1, mid - radius);
    path.quadraticCurveTo(x1, mid, x1 + direction * radius, mid);
    path.lineTo(x2, mid);
  } else {
    path.moveTo(x1, mid);
    path.lineTo(x2 - direction * radius, mid);
    path.quadraticCurveTo(x2, mid, x2, mid + radius);
    path.lineTo(x2, top + ROW_H);
  }
  return path;
}

/** Virtualised canvas modelled on GitKraken: BRANCH/TAG | GRAPH | COMMIT MESSAGE. */
export function CommitGraph({
  layout,
  selectedHash,
  selectedHashes,
  filter = '',
  onSelect,
  onContextMenu,
  onDoubleClick,
  hasMore,
  loadingMore,
  onLoadMore,
  headHash,
  changeCount,
  stagedCount = 0,
  wipSelected,
  onSelectWip,
  navigate,
  onLocateCurrent,
  upstream,
}: Props) {
  const light = useSettings((s) => s.theme === 'light');
  const scrollRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const anchor = useRef<string | null>(null);
  const [size, setSize] = useState({ w: 800, h: 600 });
  const [hover, setHover] = useState<number | null>(null);
  const [keyboardRow, setKeyboardRow] = useState<number | null>(null);
  const [graphFocused, setGraphFocused] = useState(false);
  const [hoverX, setHoverX] = useState(0);
  const [hoveredLane, setHoveredLane] = useState<{ layout: GraphLayout; color: number } | null>(null);
  const highlightedLane = hoveredLane?.layout === layout ? hoveredLane.color : null;
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
  const [colW, setColW] = useState<number | null>(null);
  const [gScroll, setGScroll] = useState(0);
  const naturalW = PAD * 2 + Math.max(2, layout.maxLanes) * LANE_W + wipOffset;
  const graphW = colW ?? Math.max(GRAPH_MIN, Math.min(naturalW, Math.max(GRAPH_MIN, size.w - REF_W - 240)));
  const maxGScroll = Math.max(0, naturalW - graphW);
  const gs = Math.min(gScroll, maxGScroll);
  const gx = (lane: number) => REF_W + PAD + wipOffset + lane * LANE_W + LANE_W / 2 - gs;
  const gL = REF_W,
    gR = REF_W + graphW;
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
    setGScroll((value) =>
      laneX < value
        ? Math.max(0, laneX - PAD)
        : laneX > value + graphW
          ? Math.min(maxGScroll, laneX - graphW + PAD)
          : value,
    );
    scrollRef.current.scrollTo({
      top: Math.max(0, (index + wipRows) * ROW_H - (scrollRef.current.clientHeight - ROW_H) / 2),
      behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth',
    });
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
      const glow = ctx.createLinearGradient(x, 0, msgX, 0);
      glow.addColorStop(0, light ? 'rgba(0,142,190,0.22)' : 'rgba(64,224,255,0.3)');
      glow.addColorStop(1, 'rgba(76,194,255,0.03)');
      ctx.fillStyle = glow;
      ctx.fillRect(x, top + 3, msgX - 6 - x, ROW_H - 6);
      ctx.fillStyle = light ? '#006a89' : '#80efff';
      ctx.font = '600 13px Inter, system-ui, sans-serif';
      ctx.fillText('// WIP', msgX, top + ROW_H / 2);
      ctx.font = FONT;
      ctx.fillStyle = light ? '#9b5a00' : '#e3ad62';
      ctx.fillText(`${changeCount} changed · ${stagedCount} staged`, msgX + 64, top + ROW_H / 2);
      if (graphFocused && keyboardRow === -1) {
        ctx.strokeStyle = light ? '#006f9e' : '#8fe8ff';
        ctx.lineWidth = 2;
        ctx.strokeRect(1, top + 1, Math.max(0, size.w - 2), ROW_H - 2);
      }
    }

    // pass 1: row highlight, node→message band, date-group separators
    for (let i = first; i <= last; i++) {
      const row = rows[i];
      const top = (i + wipRows) * ROW_H - scrollTop;
      const cx = gx(showLines ? row.col : 0);
      const lane = col(row.color, light);
      const selected = selectedHashes.includes(row.commit.hash) || row.commit.hash === selectedHash;
      if (selected || i === hover || row.commit.hash === headHash) {
        ctx.fillStyle = selected
          ? 'rgba(79,193,233,0.18)'
          : row.commit.hash === headHash
            ? 'rgba(79,193,233,0.09)'
            : 'rgba(255,255,255,0.04)';
        ctx.fillRect(0, top, size.w, ROW_H);
      }
      if (graphFocused && keyboardRow === i) {
        ctx.strokeStyle = light ? '#006f9e' : '#8fe8ff';
        ctx.lineWidth = 2;
        ctx.strokeRect(1, top + 1, Math.max(0, size.w - 2), ROW_H - 2);
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
        ctx.strokeStyle = light ? '#0089b3' : '#70efff';
        ctx.shadowColor = light ? '#009cc8' : '#39dfff';
        ctx.shadowBlur = light ? 5 : 10;
        ctx.lineWidth = 2;
        ctx.setLineDash([5, 5]);
        if (headIndex >= 0) {
          const end = (headIndex + wipRows) * ROW_H - scrollTop + ROW_H / 2;
          if (end > 0) {
            ctx.beginPath();
            ctx.moveTo(x, start);
            ctx.lineTo(x, end);
            ctx.lineTo(gx(rows[headIndex].col), end);
            ctx.lineWidth = 4;
            ctx.stroke();
            ctx.lineWidth = 1.5;
            ctx.strokeStyle = light ? '#006a89' : '#d2fbff';
            ctx.stroke();
            ctx.strokeStyle = light ? '#0089b3' : '#70efff';
            ctx.lineWidth = 2;
          }
        }
        if (start + 9 >= 0 && start - 9 <= size.h) {
          ctx.fillStyle = getComputedStyle(document.documentElement).getPropertyValue('--graph').trim() || '#1b1f27';
          ctx.beginPath();
          ctx.arc(x, start, 9, 0, Math.PI * 2);
          ctx.fill();
          ctx.setLineDash([]);
          ctx.stroke();
          ctx.beginPath();
          ctx.arc(x, start, 3, 0, Math.PI * 2);
          ctx.fillStyle = light ? '#0089b3' : '#b2f8ff';
          ctx.fill();
        }
        ctx.restore();
      }
      ctx.lineWidth = 2;
      ctx.lineCap = 'round';
      for (let i = first; i <= last; i++) {
        const row = rows[i];
        const top = (i + wipRows) * ROW_H - scrollTop;
        for (const sg of row.segments) {
          ctx.setLineDash(sg.stash ? [4, 4] : []);
          ctx.strokeStyle = col(sg.color, light);
          ctx.lineWidth = sg.color === highlightedLane ? 3 : 2;
          ctx.shadowColor = sg.color === highlightedLane ? col(sg.color, light) : 'transparent';
          ctx.shadowBlur = sg.color === highlightedLane ? 8 : 0;
          ctx.stroke(segmentPath(sg, gx(sg.x1), gx(sg.x2), top));
        }
      }
      ctx.setLineDash([]);
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
      const lane = c.stashId ? (light ? '#a86400' : '#f5a623') : col(row.color, light);

      if (c.stashId) {
        ctx.font = FONT;
        ctx.fillStyle = light ? '#fff2d5' : '#40321b';
        ctx.beginPath();
        ctx.roundRect(8, mid - 10, Math.min(REF_W - 16, ctx.measureText(c.stashId).width + 16), 20, 3);
        ctx.fill();
        ctx.fillStyle = lane;
        ctx.fillText(c.stashId, 16, mid + 0.5);
      }

      if (c.refs.length) {
        const groups = groupRefs(c.refs);
        const group = groups.find((x) => x.ref.current) ?? groups[0];
        const ref = group.ref;
        const extra = groups.length > 1 ? `+${groups.length - 1}` : '';
        ctx.font = ref.current ? '600 15.6px Inter, system-ui, sans-serif' : FONT;
        const hasLocal = ref.kind === 'local';
        const hasRemote = ref.kind === 'remote' || group.remotes.length > 0;
        const iconW = (hasLocal ? 17 : 0) + (hasRemote || ref.kind === 'tag' ? 18 : 0);
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
        if (ref.current) {
          ctx.strokeStyle = lane;
          ctx.lineWidth = 1;
          ctx.stroke();
        }
        ctx.fillStyle = light ? '#1d2939' : '#e8eef6';
        ctx.fillText(name, 16, mid + 0.5);
        let ix = 16 + ctx.measureText(name).width + 6;
        ctx.strokeStyle = light ? '#526579' : '#c8d3df';
        ctx.lineWidth = 1.3;
        if (hasLocal) {
          ctx.beginPath();
          ctx.roundRect(ix + 1, mid - 5, 10, 7, 1);
          ctx.moveTo(ix, mid + 4);
          ctx.lineTo(ix + 12, mid + 4);
          ctx.stroke();
          ix += 17;
        }
        if (hasRemote) {
          // cloud glyph
          ctx.beginPath();
          ctx.moveTo(ix + 3, mid + 4);
          ctx.arc(ix + 4, mid + 1, 3, Math.PI / 2, Math.PI * 1.5);
          ctx.arc(ix + 8, mid - 1, 4, Math.PI, 0);
          ctx.arc(ix + 12, mid + 1.5, 2.5, Math.PI * 1.5, Math.PI / 2);
          ctx.closePath();
          ctx.stroke();
          ix += 18;
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
          ix += 18;
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
      if (c.stashId) {
        ctx.strokeStyle = lane;
        ctx.lineWidth = 1.8;
        ctx.strokeRect(cx - 7, mid - 4, 14, 11);
        ctx.strokeRect(cx - 9, mid - 8, 18, 4);
        ctx.beginPath();
        ctx.moveTo(cx - 3, mid + 1);
        ctx.lineTo(cx + 3, mid + 1);
        ctx.stroke();
      } else if (c.parents.length > 1) {
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

      if (c.hash === headHash && cx >= gL && cx <= gR) {
        ctx.save();
        ctx.beginPath();
        ctx.arc(cx, mid, 12, 0, Math.PI * 2);
        ctx.strokeStyle = light ? '#0077a3' : '#9cefff';
        ctx.lineWidth = 2;
        ctx.stroke();
        ctx.restore();
      }

      // message: subject, then dim body preview
      ctx.font = FONT;
      const subjW = ctx.measureText(c.subject).width;
      const metadata = `${c.author} · ${relTime(c.date)}`;
      const total = subjW + 24 + ctx.measureText(metadata).width + (c.hash === headHash ? 44 : 0);
      if (total > maxMsgW.current + 1) {
        maxMsgW.current = total;
        grew = true;
      }
      ctx.save();
      ctx.beginPath();
      ctx.rect(msgX, top, size.w - msgX, ROW_H); // clip so scrolled text never bleeds into the graph
      ctx.clip();
      ctx.fillStyle = light ? '#1d2939' : '#e8eef6';
      const prefix = c.hash === headHash ? 'HEAD  ' : '';
      if (prefix) {
        ctx.fillStyle = light ? '#006b91' : '#8fe8ff';
        ctx.fillText(prefix, msgX - ms, mid + 0.5);
        ctx.fillStyle = light ? '#1d2939' : '#e8eef6';
      }
      const prefixW = ctx.measureText(prefix).width;
      ctx.fillText(c.subject, msgX - ms + prefixW, mid + 0.5);
      ctx.fillStyle = light ? '#586b81' : '#a2afbf';
      ctx.fillText(metadata, msgX - ms + prefixW + subjW + 24, mid + 0.5);
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
  }, [
    rows,
    size,
    scrollTop,
    selectedHash,
    selectedHashes,
    hover,
    keyboardRow,
    graphFocused,
    showLines,
    graphW,
    msgX,
    gs,
    ms,
    changeCount,
    stagedCount,
    wipSelected,
    wipRows,
    headIndex,
    light,
    highlightedLane,
  ]);

  useEffect(() => {
    const id = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(id);
  }, [draw]);

  const rowAt = (e: React.MouseEvent) => {
    const rect = scrollRef.current!.getBoundingClientRect();
    const i = Math.floor((e.clientY - rect.top + scrollTop) / ROW_H) - wipRows;
    return i >= -wipRows && i < rows.length ? i : null;
  };

  const laneAt = (e: React.MouseEvent, i: number | null) => {
    const rect = scrollRef.current!.getBoundingClientRect();
    const x = e.clientX - rect.left;
    if (!showLines || i === null || i < 0 || x < gL || x > gR) return null;
    const row = rows[i];
    const y = e.clientY - rect.top;
    const mid = (i + wipRows) * ROW_H - scrollTop + ROW_H / 2;
    if (Math.hypot(x - gx(row.col), y - mid) <= AV + 2) return row.color;
    const ctx = canvasRef.current?.getContext('2d');
    if (!ctx) return null;
    ctx.save();
    ctx.resetTransform();
    ctx.lineWidth = 10;
    ctx.lineCap = 'round';
    ctx.setLineDash([]);
    const top = mid - ROW_H / 2;
    const lane = [...row.segments]
      .reverse()
      .find((segment) => ctx.isPointInStroke(segmentPath(segment, gx(segment.x1), gx(segment.x2), top), x, y))?.color;
    ctx.restore();
    return lane ?? null;
  };

  const headCls = 'px-3 text-[11px] font-mono uppercase tracking-wider text-sub flex items-center';
  return (
    <div className="relative flex h-full w-full flex-col bg-[var(--graph)]">
      <div className="flex shrink-0 border-b border-surface bg-[var(--graph)]" style={{ height: HEAD_H }}>
        <div className={headCls} style={{ width: REF_W }}>
          Branch / Tag
        </div>
        <div className={headCls + ' relative'} style={{ width: graphW }}>
          Graph
          <div
            role="separator"
            aria-label="Resize graph column"
            aria-orientation="vertical"
            className="absolute right-0 top-0 h-full w-1.5 cursor-col-resize hover:bg-[#4cc2ff]/60"
            onMouseDown={(e) => {
              const x0 = e.clientX,
                w0 = graphW;
              const move = (ev: MouseEvent) =>
                setColW(Math.max(GRAPH_MIN, Math.min(size.w - REF_W - 200, w0 + ev.clientX - x0)));
              const up = () => {
                window.removeEventListener('mousemove', move);
                window.removeEventListener('mouseup', up);
              };
              window.addEventListener('mousemove', move);
              window.addEventListener('mouseup', up);
            }}
            onDoubleClick={() => setColW(Math.max(GRAPH_MIN, Math.min(naturalW, size.w - REF_W - 200)))}
            title="Drag to resize · double-click to fit all lanes"
          />
        </div>
        <div className={headCls + ' min-w-0 flex-1 justify-between gap-2'}>
          <span>Commit message</span>
          {upstream && (
            <span
              className="truncate normal-case tracking-normal"
              title={
                upstream.gone
                  ? `Upstream ${upstream.name} is unavailable`
                  : `Compared with ${upstream.name}: ${upstream.ahead} ahead, ${upstream.behind} behind`
              }
            >
              {upstream.gone ? `${upstream.name} · gone` : `${upstream.name}  ↑${upstream.ahead} ↓${upstream.behind}`}
            </span>
          )}
        </div>
      </div>
      <div
        ref={scrollRef}
        role="region"
        aria-label="Commit history. Use arrow keys to navigate, Enter to open details, and Shift F10 for actions."
        aria-describedby="graph-keyboard-description"
        tabIndex={0}
        className="relative min-h-0 flex-1 overflow-y-auto overflow-x-hidden"
        onFocus={(event) => {
          if (event.target !== event.currentTarget) return;
          setGraphFocused(true);
          const selectedIndex = rows.findIndex((row) => row.commit.hash === selectedHash);
          const visibleStart = Math.max(-wipRows, Math.floor(event.currentTarget.scrollTop / ROW_H) - wipRows);
          const next =
            keyboardRow !== null && keyboardRow >= -wipRows && keyboardRow < rows.length
              ? keyboardRow
              : selectedIndex >= 0
                ? selectedIndex
                : rows.length || wipRows
                  ? visibleStart
                  : null;
          if (next !== null) {
            const top = (next + wipRows) * ROW_H;
            if (
              top < event.currentTarget.scrollTop ||
              top + ROW_H > event.currentTarget.scrollTop + event.currentTarget.clientHeight
            )
              event.currentTarget.scrollTop = top;
          }
          setKeyboardRow(next);
        }}
        onBlur={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setGraphFocused(false);
        }}
        onKeyDown={(event) => {
          if (event.target !== event.currentTarget || keyboardRow === null) return;
          const scrollToRow = (index: number) => {
            const el = scrollRef.current;
            if (!el) return;
            const top = (index + wipRows) * ROW_H;
            if (top < el.scrollTop) el.scrollTop = top;
            else if (top + ROW_H > el.scrollTop + el.clientHeight) el.scrollTop = top + ROW_H - el.clientHeight;
          };
          if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
            event.preventDefault();
            const next =
              event.key === 'Home'
                ? -wipRows
                : event.key === 'End'
                  ? rows.length - 1
                  : Math.max(-wipRows, Math.min(rows.length - 1, keyboardRow + (event.key === 'ArrowDown' ? 1 : -1)));
            if (next >= -wipRows && next < rows.length) {
              setKeyboardRow(next);
              scrollToRow(next);
            }
          } else if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            if (keyboardRow === -1) onSelectWip();
            else if (rows[keyboardRow]) {
              const hash = rows[keyboardRow].commit.hash;
              anchor.current = hash;
              onSelect(hash, [hash]);
            }
          } else if ((event.key === 'F10' && event.shiftKey) || event.key === 'ContextMenu') {
            if (keyboardRow < 0 || !rows[keyboardRow] || rows[keyboardRow].commit.stashId) return;
            event.preventDefault();
            const hash = rows[keyboardRow].commit.hash;
            if (!selectedHashes.includes(hash)) onSelect(hash, [hash]);
            const bounds = event.currentTarget.getBoundingClientRect();
            onContextMenu?.(
              hash,
              bounds.left + Math.min(bounds.width - 8, msgX),
              Math.max(
                bounds.top,
                Math.min(
                  bounds.bottom - 8,
                  bounds.top + (keyboardRow + wipRows) * ROW_H - event.currentTarget.scrollTop + ROW_H,
                ),
              ),
            );
          }
        }}
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
        onMouseMove={(e) => {
          const i = rowAt(e);
          setHover(i);
          setHoverX(e.clientX - e.currentTarget.getBoundingClientRect().left);
          const color = laneAt(e, i);
          setHoveredLane((current) =>
            color === null ? null : current?.layout === layout && current.color === color ? current : { layout, color },
          );
        }}
        onMouseLeave={(e) => {
          if (e.relatedTarget instanceof Element && e.relatedTarget.closest('[data-branch-tooltip]')) return;
          setHover(null);
          setHoveredLane(null);
        }}
        onClick={(e) => {
          const i = rowAt(e);
          if (i === -1) {
            setKeyboardRow(-1);
            anchor.current = null;
            onSelectWip();
            return;
          }
          if (i === null) return;
          setKeyboardRow(i);
          const hash = rows[i].commit.hash;
          if (rows[i].commit.stashId) {
            anchor.current = hash;
            onSelect(hash, [hash]);
            return;
          }
          const start = rows.findIndex((row) => row.commit.hash === anchor.current);
          if (e.shiftKey && start >= 0)
            onSelect(
              hash,
              rows.slice(Math.min(start, i), Math.max(start, i) + 1).map((row) => row.commit.hash),
            );
          else {
            anchor.current = hash;
            onSelect(hash, [hash]);
          }
        }}
        onDoubleClick={(e) => {
          const i = rowAt(e);
          if (e.clientX - e.currentTarget.getBoundingClientRect().left >= REF_W || i === null || i < 0) return;
          const groups = groupRefs(rows[i].commit.refs);
          const ref = (groups.find((g) => g.ref.current) ?? groups[0])?.ref;
          if (ref) onDoubleClick?.(ref);
        }}
        onContextMenu={(e) => {
          const i = rowAt(e);
          if (i === null || i < 0) return;
          e.preventDefault();
          const hash = rows[i].commit.hash;
          if (rows[i].commit.stashId) {
            onSelect(hash, [hash]);
            return;
          }
          if (!selectedHashes.includes(hash)) {
            anchor.current = hash;
            onSelect(hash, [hash]);
          }
          onContextMenu?.(hash, e.clientX, e.clientY);
        }}
      >
        <div id="graph-keyboard-description" className="sr-only" aria-live="polite">
          {graphFocused && keyboardRow === -1
            ? `Local changes, ${changeCount} files, ${stagedCount} staged`
            : graphFocused && keyboardRow !== null && rows[keyboardRow]
              ? `${rows[keyboardRow].commit.subject}, ${rows[keyboardRow].commit.author}, ${relTime(rows[keyboardRow].commit.date)}, commit ${rows[keyboardRow].commit.hash.slice(0, 7)}${rows[keyboardRow].commit.hash === headHash ? ', current HEAD' : ''}${rows[keyboardRow].commit.stashId ? `, ${rows[keyboardRow].commit.stashId}` : ''}`
              : ''}
        </div>
        <div style={{ height: totalRows * ROW_H }} />
        {rows.map(
          (row, index) =>
            row.commit.stashId && (
              <button
                key={row.commit.hash}
                type="button"
                aria-label={`${row.commit.stashId}: ${row.commit.subject}`}
                aria-pressed={selectedHash === row.commit.hash}
                onClick={(event) => {
                  event.stopPropagation();
                  onSelect(row.commit.hash, [row.commit.hash]);
                }}
                onContextMenu={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  onSelect(row.commit.hash, [row.commit.hash]);
                }}
                className="absolute left-0 z-10 h-7 w-full cursor-pointer bg-transparent focus-visible:outline focus-visible:outline-2 focus-visible:outline-[#f5a623]"
                style={{ top: (index + wipRows) * ROW_H }}
              />
            ),
        )}
        {wipRows > 0 && (
          <button
            type="button"
            aria-label={`Local changes, ${changeCount} changed files, ${stagedCount} staged`}
            aria-pressed={wipSelected}
            onClick={(e) => {
              e.stopPropagation();
              onSelectWip();
            }}
            className="absolute left-0 top-0 z-10 h-7 w-full cursor-pointer bg-transparent focus-visible:outline focus-visible:outline-2 focus-visible:outline-[#4cc2ff]"
          />
        )}
        {maxMsgScroll > 0 &&
          (() => {
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
                  onClick={stop}
                  onDoubleClick={stop}
                  onContextMenu={stop}
                  onPointerDown={(e) => {
                    e.stopPropagation();
                    e.currentTarget.setPointerCapture(e.pointerId);
                    const x0 = e.clientX,
                      s0 = ms;
                    const el = e.currentTarget;
                    const move = (ev: PointerEvent) =>
                      setMsgScroll(
                        Math.max(
                          0,
                          Math.min(maxMsgScroll, s0 + ((ev.clientX - x0) / Math.max(1, track - thumb)) * maxMsgScroll),
                        ),
                      );
                    const up = () => {
                      el.removeEventListener('pointermove', move);
                      el.removeEventListener('pointerup', up);
                    };
                    el.addEventListener('pointermove', move);
                    el.addEventListener('pointerup', up);
                  }}
                />
              </div>
            );
          })()}
        {maxGScroll > 0 && (
          <div className="pointer-events-none sticky z-10 h-0" style={{ bottom: 8 }}>
            <div
              className="absolute h-1.5 rounded-full bg-white/25"
              style={{ left: REF_W + (gs / naturalW) * graphW, width: (graphW / naturalW) * graphW }}
            />
          </div>
        )}
        <canvas
          ref={canvasRef}
          style={{
            position: 'sticky',
            top: 0,
            width: size.w,
            height: size.h,
            marginTop: -totalRows * ROW_H,
            pointerEvents: 'none',
          }}
        />
      </div>
      {headHash &&
        (headIndex < 0 ||
          (headIndex + wipRows + 1) * ROW_H <= scrollTop ||
          (headIndex + wipRows) * ROW_H >= scrollTop + size.h) && (
          <button
            onClick={onLocateCurrent}
            className={`absolute right-4 z-20 rounded-full border border-[#4cc2ff]/50 bg-[#26374a] px-3 py-1.5 text-xs font-medium text-[#bdeaff] shadow-lg hover:bg-[#34526e] ${headIndex >= 0 && (headIndex + wipRows + 1) * ROW_H <= scrollTop ? 'top-9' : 'bottom-4'}`}
          >
            {headIndex < 0
              ? filter
                ? 'Current hidden by search'
                : 'Current not in loaded history'
              : (headIndex + wipRows + 1) * ROW_H <= scrollTop
                ? '↑ Current above'
                : '↓ Current below'}{' '}
            · Go to current
          </button>
        )}
      {/* hovering the branch/tag column of any commit that has refs lists all of them with their full names */}
      {hover !== null &&
        hoverX < REF_W &&
        rows[hover]?.commit.refs.length > 0 &&
        (() => {
          const shown = rows[hover].commit.refs;
          const h = Math.min(
            window.innerHeight * 0.6,
            shown.reduce((n, ref) => n + 8 + 19 * Math.max(1, Math.ceil(ref.name.length / 44)), 16),
          );
          const rowTop = HEAD_H + (hover + wipRows) * ROW_H - scrollTop;
          const top = rowTop + ROW_H + h > size.h + HEAD_H ? Math.max(HEAD_H, rowTop - h) : rowTop + ROW_H;
          const glyph = { remote: '☁', tag: '◆', local: '', head: '●' } as const;
          return (
            <div
              role="group"
              aria-label="Branches and tags on this commit"
              data-branch-tooltip
              className="absolute z-30 max-h-[60vh] min-w-[220px] max-w-[min(480px,60vw)] overflow-y-auto rounded-lg border border-surface bg-mantle py-2 shadow-2xl"
              style={{ left: 8, top }}
              onMouseLeave={(e) => {
                if (e.relatedTarget instanceof Node && scrollRef.current?.contains(e.relatedTarget)) return;
                setHover(null);
                setHoveredLane(null);
              }}
            >
              {shown.map((r) => {
                const content = (
                  <>
                    <span aria-hidden className="mt-px w-4 shrink-0 text-center text-[11px] text-sub">
                      {r.kind === 'local' ? <Laptop size={14} /> : glyph[r.kind]}
                    </span>
                    <span className="min-w-0 break-all">{r.kind === 'head' ? 'Detached HEAD' : r.name}</span>
                    <span className="ml-auto shrink-0 pl-3 text-[11px] text-sub">{r.current ? 'current' : r.kind}</span>
                  </>
                );
                return r.kind === 'local' || r.kind === 'remote' ? (
                  <button
                    key={r.kind + r.name}
                    type="button"
                    aria-label={`Open actions for ${r.kind} branch ${r.name}`}
                    className={`flex w-full items-start gap-2 px-3 py-[4px] text-left text-[13px] leading-[19px] hover:bg-[#4cc2ff]/15 ${r.current ? 'font-semibold text-[#4cc2ff]' : ''}`}
                    onClick={(e) => {
                      e.stopPropagation();
                      onContextMenu?.(rows[hover].commit.hash, e.clientX, e.clientY, {
                        name: r.name,
                        kind: r.kind as 'local' | 'remote',
                      });
                    }}
                    onContextMenu={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      onContextMenu?.(rows[hover].commit.hash, e.clientX, e.clientY, {
                        name: r.name,
                        kind: r.kind as 'local' | 'remote',
                      });
                    }}
                  >
                    {content}
                  </button>
                ) : (
                  <div
                    key={r.kind + r.name}
                    className="flex items-start gap-2 px-3 py-[4px] text-[13px] leading-[19px]"
                  >
                    {content}
                  </div>
                );
              })}
            </div>
          );
        })()}
      {(loadingMore || (filter && hasMore)) && (
        <div className="pointer-events-none absolute inset-x-0 bottom-4 z-20 flex justify-center">
          <div
            role="status"
            className="pointer-events-auto rounded-full border border-surface bg-mantle px-4 py-1.5 text-[13px] shadow-lg"
          >
            {loadingMore ? (
              <span className="flex items-center gap-2">
                <Spinner size={14} className="text-[#4cc2ff]" /> Loading more commits…
              </span>
            ) : (
              <>
                Searching {layout.rows.length} loaded commits ·{' '}
                <button className="text-[#4cc2ff] underline" onClick={onLoadMore}>
                  Load more
                </button>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
