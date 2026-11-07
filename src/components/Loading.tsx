import { useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { useRepo } from '../store/repoStore';

/** True only after `flag` has stayed on for `ms` — avoids flashing a spinner for instant operations. */
export function useDelayed(flag: boolean, ms = 180) {
  const [on, setOn] = useState(false);
  useEffect(() => {
    if (!flag) {
      setOn(false);
      return;
    }
    const t = setTimeout(() => setOn(true), ms);
    return () => clearTimeout(t);
  }, [flag, ms]);
  return on;
}

export const Spinner = ({ size = 16, className = '' }: { size?: number; className?: string }) => (
  <Loader2 size={size} aria-hidden className={`animate-spin ${className}`} />
);

export const Skeleton = ({ className = '', style }: { className?: string; style?: React.CSSProperties }) => (
  <div aria-hidden className={`skeleton ${className}`} style={style} />
);

/** Deterministic pseudo-random widths so skeletons look organic but never jump between renders. */
const w = (i: number, min = 30, max = 90) => `${min + ((i * 37 + 11) % (max - min))}%`;

/** Whole-app activity: thin indeterminate bar + a small status pill naming what is running. */
export function ActivityBar() {
  const working = useRepo((s) => s.working);
  const loading = useRepo((s) => s.loading);
  const active = !!working || loading;
  const show = useDelayed(active);
  return (
    <>
      {/* always reserves its 2px so the layout never shifts */}
      <div className={show ? 'progress-bar' : 'h-[2px]'} aria-hidden />
      {show && (
        <div
          role="status"
          aria-live="polite"
          className="fixed bottom-6 left-6 z-[110] flex items-center gap-2 rounded-full border border-surface bg-[#2a2f3a] px-4 py-2 shadow-xl"
        >
          <Spinner size={15} className="text-[#4cc2ff]" />
          <span>{working ?? 'Loading repository…'}</span>
        </div>
      )}
    </>
  );
}

export function GraphSkeleton() {
  return (
    <div
      role="status"
      aria-busy="true"
      aria-label="Loading commit history"
      className="flex h-full flex-col overflow-hidden bg-[#1b1f27]"
    >
      <div className="flex h-[28px] shrink-0 items-center border-b border-surface px-3 text-[11px] uppercase tracking-wider text-[#8b96a8]">
        <span className="w-[150px]">Branch / Tag</span>
        <span className="w-[240px]">Graph</span>
        <span>Commit message</span>
      </div>
      <div className="relative flex-1 overflow-hidden">
        <div className="absolute bottom-0 top-0 w-[2px] bg-white/[0.06]" style={{ left: 150 + 26 }} />
        {Array.from({ length: 28 }, (_, i) => (
          <div key={i} className="flex h-[28px] items-center">
            <div className="w-[150px] pl-2">
              {i % 6 === 0 && <Skeleton className="h-[18px]" style={{ width: 90 }} />}
            </div>
            <div className="flex w-[240px] items-center pl-[18px]">
              <Skeleton className={i % 3 === 0 ? 'h-2 w-2 !rounded-full' : 'h-[18px] w-[18px] !rounded-full'} />
            </div>
            <div className="flex-1 pr-6">
              <Skeleton className="h-[10px]" style={{ width: w(i, 25, 80) }} />
            </div>
          </div>
        ))}
      </div>
      <span className="sr-only">Loading commit history…</span>
    </div>
  );
}

export function SidebarSkeleton() {
  return (
    <div role="status" aria-busy="true" aria-label="Loading branches" className="space-y-1 p-4">
      <Skeleton className="mb-4 h-9 w-full" />
      {[5, 3, 2].map((rows, s) => (
        <div key={s} className="pb-3">
          <Skeleton className="mb-3 h-4" style={{ width: 90 + s * 14 }} />
          {Array.from({ length: rows }, (_, i) => (
            <Skeleton key={i} className="mb-2 ml-5 h-3.5" style={{ width: w(i + s * 3, 40, 85) }} />
          ))}
        </div>
      ))}
      <span className="sr-only">Loading branches…</span>
    </div>
  );
}

export function DetailsSkeleton() {
  return (
    <div role="status" aria-busy="true" aria-label="Loading commit details" className="flex h-full flex-col">
      <div className="flex justify-between border-b border-surface px-4 py-3">
        <Skeleton className="h-4 w-28" />
        <Skeleton className="h-4 w-24" />
      </div>
      <div className="m-4 space-y-2 rounded-lg border border-surface bg-crust p-4">
        <Skeleton className="h-5 w-[85%]" />
        <Skeleton className="h-5 w-[60%]" />
        <Skeleton className="mt-4 h-3.5 w-[70%]" />
      </div>
      <div className="flex items-center gap-3 px-4 pb-3">
        <Skeleton className="h-11 w-11" />
        <div className="flex-1 space-y-2">
          <Skeleton className="h-4 w-40" />
          <Skeleton className="h-3.5 w-52" />
        </div>
      </div>
      <div className="space-y-3 border-t border-surface px-4 pt-4">
        <Skeleton className="h-4 w-36" />
        {Array.from({ length: 5 }, (_, i) => (
          <div key={i} className="flex items-center gap-2">
            <Skeleton className="h-4 w-4" />
            <Skeleton className="h-3.5" style={{ width: w(i, 45, 90) }} />
          </div>
        ))}
      </div>
      <span className="sr-only">Loading commit details…</span>
    </div>
  );
}

/** Placeholder for code areas (diff, file view): faint lines with a gutter. */
export function CodeSkeleton({ label, lines = 14 }: { label: string; lines?: number }) {
  return (
    <div role="status" aria-busy="true" aria-label={label} className="py-3">
      {Array.from({ length: lines }, (_, i) => (
        <div key={i} className="flex h-[22px] items-center gap-4 px-4">
          <Skeleton className="h-2.5 w-8 shrink-0" />
          <Skeleton className="h-2.5" style={{ width: w(i, 20, 85), marginLeft: (i % 4) * 14 }} />
        </div>
      ))}
      <div className="mt-3 flex items-center gap-2 px-4 font-sans text-sub">
        <Spinner size={14} /> {label}
      </div>
    </div>
  );
}

export const ListSkeleton = ({ label, rows = 5 }: { label: string; rows?: number }) => (
  <div role="status" aria-busy="true" aria-label={label} className="space-y-3 p-4">
    {Array.from({ length: rows }, (_, i) => (
      <div key={i} className="space-y-1.5">
        <Skeleton className="h-3.5" style={{ width: w(i, 55, 95) }} />
        <Skeleton className="h-3" style={{ width: w(i + 3, 35, 65) }} />
      </div>
    ))}
    <span className="sr-only">{label}</span>
  </div>
);
