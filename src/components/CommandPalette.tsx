import { useEffect, useMemo, useRef, useState } from 'react';
import { Command, Search } from 'lucide-react';

export interface PaletteCommand {
  id: string;
  title: string;
  group: string;
  shortcut?: string;
  keywords?: string;
  disabled?: boolean;
  run: () => void;
}

/** Every word typed must appear in the title, group or keywords (any order). */
function matches(command: PaletteCommand, query: string) {
  const text = `${command.title} ${command.group} ${command.keywords ?? ''}`.toLowerCase();
  return query
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((word) => text.includes(word));
}

export function CommandPalette({ commands, onClose }: { commands: PaletteCommand[]; onClose: () => void }) {
  const [query, setQuery] = useState('');
  const [index, setIndex] = useState(0);
  const list = useRef<HTMLDivElement>(null);
  const shown = useMemo(() => commands.filter((c) => !c.disabled && matches(c, query)).slice(0, 80), [commands, query]);
  useEffect(() => setIndex(0), [query]);
  useEffect(() => {
    list.current?.querySelector<HTMLElement>(`[data-index="${index}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [index]);
  const run = (command: PaletteCommand | undefined) => {
    if (!command) return;
    onClose();
    command.run();
  };
  let lastGroup = '';
  return (
    <div className="fixed inset-0 z-[120] flex items-start justify-center bg-black/40 pt-[12vh]" onMouseDown={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
        onMouseDown={(e) => e.stopPropagation()}
        className="w-[620px] max-w-[92vw] overflow-hidden rounded-xl border border-surface bg-mantle shadow-2xl"
      >
        <div className="flex items-center gap-2 border-b border-surface px-4">
          <Search size={16} className="text-sub" aria-hidden />
          <input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') {
                e.preventDefault();
                setIndex((i) => Math.min(shown.length - 1, i + 1));
              } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                setIndex((i) => Math.max(0, i - 1));
              } else if (e.key === 'Enter') {
                e.preventDefault();
                run(shown[index]);
              } else if (e.key === 'Escape') {
                e.preventDefault();
                onClose();
              }
            }}
            placeholder="Type a command, branch or repository…"
            aria-label="Command"
            aria-controls="palette-list"
            className="min-h-[48px] flex-1 bg-transparent text-sm outline-none"
          />
        </div>
        <div id="palette-list" ref={list} role="listbox" className="max-h-[55vh] overflow-y-auto py-1">
          {shown.length === 0 && <p className="px-4 py-6 text-center text-sm text-sub">No matching commands</p>}
          {shown.map((command, i) => {
            const header = command.group !== lastGroup ? command.group : null;
            lastGroup = command.group;
            return (
              <div key={command.id}>
                {header && <div className="px-4 pb-1 pt-2 text-2xs font-semibold uppercase text-sub">{header}</div>}
                <button
                  type="button"
                  role="option"
                  data-index={i}
                  aria-selected={i === index}
                  onMouseMove={() => setIndex(i)}
                  onClick={() => run(command)}
                  className={`flex w-full items-center gap-3 px-4 py-2 text-left text-sm ${i === index ? 'bg-accent/15 text-text' : 'text-sub'}`}
                >
                  <span className="flex-1 truncate">{command.title}</span>
                  {command.shortcut && (
                    <kbd className="rounded border border-surface px-1.5 font-mono text-2xs text-sub">
                      {command.shortcut}
                    </kbd>
                  )}
                </button>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

export function ShortcutList({ shortcuts, onClose }: { shortcuts: [string, string][]; onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="fixed inset-0 z-[120] flex items-center justify-center bg-black/50 p-4" onMouseDown={onClose}>
      <section
        role="dialog"
        aria-modal="true"
        aria-label="Keyboard shortcuts"
        onMouseDown={(e) => e.stopPropagation()}
        className="w-[460px] max-w-[92vw] rounded-xl border border-surface bg-mantle p-5 shadow-2xl"
      >
        <h2 className="mb-3 flex items-center gap-2 text-base font-semibold">
          <Command size={16} aria-hidden /> Keyboard shortcuts
        </h2>
        <dl className="divide-y divide-surface/60">
          {shortcuts.map(([keys, what]) => (
            <div key={keys} className="flex items-center justify-between gap-4 py-2 text-sm">
              <dt className="text-sub">{what}</dt>
              <dd>
                <kbd className="rounded border border-surface px-1.5 py-0.5 font-mono text-xs">{keys}</kbd>
              </dd>
            </div>
          ))}
        </dl>
      </section>
    </div>
  );
}
