import { useEffect, useState } from 'react';
import { ChevronRight } from 'lucide-react';

const DURATION = 200;

/**
 * Animated expand/collapse. Height animates via grid-template-rows (0fr ↔ 1fr), so no
 * measuring is needed. Content stays mounted while closing, then unmounts.
 */
export function Collapse({
  open,
  children,
  className = '',
  keepMounted = false,
}: {
  open: boolean;
  children: React.ReactNode;
  className?: string;
  /** keep children mounted (and inert) while closed, so they can keep loading data */
  keepMounted?: boolean;
}) {
  const [mounted, setMounted] = useState(open);
  const [expanded, setExpanded] = useState(open);
  // once fully open, stop clipping so menus/tooltips inside are not cut off
  const [settled, setSettled] = useState(open);
  useEffect(() => {
    setSettled(false);
    if (open) {
      setMounted(true);
      // next frame so the closed state paints first and the transition runs
      const frame = requestAnimationFrame(() => requestAnimationFrame(() => setExpanded(true)));
      return () => cancelAnimationFrame(frame);
    }
    setExpanded(false);
    const timer = setTimeout(() => setMounted(false), DURATION);
    return () => clearTimeout(timer);
  }, [open]);
  if (!mounted && !keepMounted) return null;
  return (
    <div
      className={`collapse-wrap ${expanded ? 'collapse-open' : ''} ${settled && open ? 'collapse-settled' : ''}`}
      aria-hidden={!open || undefined}
      inert={!open || undefined}
      onTransitionEnd={(event) => {
        if (event.target === event.currentTarget && open) setSettled(true);
      }}
    >
      <div className={`collapse-inner ${className}`}>{children}</div>
    </div>
  );
}

/** Chevron that rotates between right (closed) and down (open). */
export function Chevron({ open, size = 14, className = '' }: { open: boolean; size?: number; className?: string }) {
  return (
    <ChevronRight size={size} aria-hidden className={`chevron shrink-0 ${open ? 'chevron-open' : ''} ${className}`} />
  );
}
