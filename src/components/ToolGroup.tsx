import { useEffect, useRef, useState } from 'react';
import { ChevronDown } from 'lucide-react';

export interface ToolChild {
  id: string;
  label: string;
  icon: React.ReactNode;
  hint?: string;
  pressed?: boolean;
  disabled?: boolean;
  onClick: () => void;
}

/**
 * Toolbar group: one button that opens its child actions on hover (after a short delay) or click.
 * Keeps the toolbar short; arrow keys move between children, Escape closes.
 */
export function ToolGroup({
  label,
  icon,
  children,
  active,
}: {
  label: string;
  icon: React.ReactNode;
  children: ToolChild[];
  active?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const timer = useRef<number>(0);
  const later = (fn: () => void, ms: number) => {
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(fn, ms);
  };
  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => !box.current?.contains(e.target as Node) && setOpen(false);
    window.addEventListener('mousedown', away);
    return () => window.removeEventListener('mousedown', away);
  }, [open]);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  const anyPressed = active ?? children.some((c) => c.pressed);
  return (
    <div
      ref={box}
      className="relative"
      onMouseEnter={() => later(() => setOpen(true), 180)}
      onMouseLeave={() => later(() => setOpen(false), 220)}
    >
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={label}
        title={label}
        onClick={() => setOpen((v) => !v)}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') {
            e.preventDefault();
            setOpen(true);
            requestAnimationFrame(() =>
              box.current?.querySelector<HTMLButtonElement>('[role="menuitem"]:not(:disabled)')?.focus(),
            );
          }
        }}
        className={`ui-tool flex min-h-[44px] w-10 flex-col items-center justify-center gap-1 rounded-md text-xs min-[1400px]:min-h-[52px] min-[1400px]:w-[68px] ${anyPressed ? 'bg-accent/15 text-accent' : 'hover:bg-surface/60'}`}
      >
        <span className="relative">
          {icon}
          <ChevronDown size={9} aria-hidden className="ui-group-hint absolute -bottom-1 -right-2 text-sub" />
        </span>
        <span className="ui-label hidden items-center gap-0.5 min-[1400px]:flex">
          {label}
          <ChevronDown size={11} aria-hidden />
        </span>
      </button>
      {open && (
        <div
          role="menu"
          aria-label={label}
          onKeyDown={(e) => {
            const items = [
              ...(box.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)') ?? []),
            ];
            const at = items.indexOf(document.activeElement as HTMLButtonElement);
            if (e.key === 'Escape') {
              e.preventDefault();
              setOpen(false);
              box.current?.querySelector<HTMLButtonElement>('[aria-haspopup]')?.focus();
            } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
              e.preventDefault();
              items[(at + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length]?.focus();
            }
          }}
          className="absolute left-1/2 top-full z-50 mt-1 w-56 -translate-x-1/2 rounded-lg border border-surface bg-mantle p-1 shadow-xl"
        >
          {children.map((child) => (
            <button
              key={child.id}
              type="button"
              role="menuitem"
              disabled={child.disabled}
              title={child.hint}
              aria-pressed={child.pressed}
              onClick={() => {
                setOpen(false);
                child.onClick();
              }}
              className={`flex min-h-9 w-full items-center gap-2.5 rounded-md px-3 text-left text-sm disabled:opacity-40 ${child.pressed ? 'bg-accent/15 text-accent' : 'hover:bg-surface/60'}`}
            >
              <span className="shrink-0 text-sub [&>svg]:h-4 [&>svg]:w-4">{child.icon}</span>
              {child.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
