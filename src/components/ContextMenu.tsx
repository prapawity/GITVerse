import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ChevronRight } from 'lucide-react';

export type MenuItem =
  { label: string; run?: () => void; danger?: boolean; disabled?: boolean; hint?: string; sub?: MenuItem[] } | '-';

const row =
  'flex min-h-9 w-full items-center gap-3 rounded-lg px-3 text-left text-sm hover:bg-white/10 focus-visible:bg-white/10 focus-visible:outline-none disabled:opacity-40';

/**
 * Right-click menu with groups: an item with `sub` opens its child list on hover, click, or the
 * right arrow key, so long menus stay short. Closes on outside click, Escape or a second right-click.
 */
export function ContextMenu({
  items,
  x,
  y,
  label,
  onClose,
  width = 256,
}: {
  items: MenuItem[];
  x: number;
  y: number;
  label: string;
  onClose: () => void;
  width?: number;
}) {
  const [open, setOpen] = useState<number | null>(null);
  const menu = useRef<HTMLDivElement>(null);
  useEffect(() => {
    menu.current?.querySelector<HTMLButtonElement>('[role="menuitem"]:not(:disabled)')?.focus();
  }, []);
  const choose = (item: Exclude<MenuItem, '-'>) => {
    onClose();
    item.run?.();
  };
  const onKey = (event: React.KeyboardEvent) => {
    const list = event.currentTarget.closest('[role="menu"]') ?? menu.current;
    const buttons = [
      ...(list?.querySelectorAll<HTMLButtonElement>(':scope > div > [role="menuitem"]:not(:disabled)') ?? []),
    ];
    const at = buttons.indexOf(document.activeElement as HTMLButtonElement);
    if (event.key === 'Escape') {
      event.preventDefault();
      if (open !== null) setOpen(null);
      else onClose();
    } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      buttons[(at + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length]?.focus();
    }
  };
  const left = Math.max(8, Math.min(x, window.innerWidth - width - 8));
  const top = Math.max(8, Math.min(y, window.innerHeight - 40 * items.length - 16));
  const opensLeft = left + width * 2 + 16 > window.innerWidth;

  const renderItems = (list: MenuItem[], nested: boolean) =>
    list.map((item, i) =>
      item === '-' ? (
        <div key={`sep-${i}`} className="my-1 h-px bg-white/10" role="separator" />
      ) : (
        <div key={item.label} className="relative" onMouseEnter={() => !nested && setOpen(item.sub ? i : null)}>
          <button
            type="button"
            role="menuitem"
            disabled={item.disabled}
            title={item.hint}
            aria-haspopup={item.sub ? 'menu' : undefined}
            aria-expanded={item.sub ? open === i : undefined}
            onClick={() => (item.sub ? setOpen(open === i ? null : i) : choose(item))}
            onKeyDown={(event) => {
              if (item.sub && (event.key === 'ArrowRight' || event.key === 'Enter')) {
                event.preventDefault();
                setOpen(i);
                requestAnimationFrame(() =>
                  event.currentTarget.parentElement
                    ?.querySelector<HTMLButtonElement>('[role="menu"] [role="menuitem"]:not(:disabled)')
                    ?.focus(),
                );
              } else if (nested && event.key === 'ArrowLeft') {
                event.preventDefault();
                setOpen(null);
              }
            }}
            className={`${row} ${item.danger ? 'text-danger' : 'text-text'}`}
          >
            <span className="flex-1 truncate">{item.label}</span>
            {item.sub && <ChevronRight size={14} className="shrink-0 text-sub" aria-hidden />}
          </button>
          {item.sub && open === i && (
            <div
              role="menu"
              aria-label={item.label}
              onKeyDown={onKey}
              className={`glass-context-menu absolute top-0 z-[102] rounded-xl border border-white/15 p-1.5 shadow-2xl ${opensLeft ? 'right-full mr-1' : 'left-full ml-1'}`}
              style={{ width }}
            >
              {renderItems(item.sub, true)}
            </div>
          )}
        </div>
      ),
    );

  return createPortal(
    <div
      className="fixed inset-0 z-[100]"
      onMouseDown={(event) => event.target === event.currentTarget && onClose()}
      onContextMenu={(event) => {
        event.preventDefault();
        onClose();
      }}
    >
      <div
        ref={menu}
        role="menu"
        aria-label={label}
        onKeyDown={onKey}
        className="glass-context-menu fixed z-[101] rounded-xl border border-white/15 p-1.5 shadow-2xl"
        style={{ left, top, width }}
        onMouseDown={(event) => event.stopPropagation()}
      >
        {renderItems(items, false)}
      </div>
    </div>,
    document.body,
  );
}
