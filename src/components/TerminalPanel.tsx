import { useEffect, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { ChevronDown, Plus, SquareTerminal, Trash2, X } from 'lucide-react';
import { termFont, useSettings } from '../store/settingsStore';

/**
 * Bottom terminal with tabs. Sessions live at module level so hiding the panel (or switching
 * between graph and diff) keeps shells running; each xterm renders into its own detached element
 * that is moved into whichever container is mounted.
 */
interface Session {
  key: number;
  id: number | null;
  title: string;
  term: Terminal;
  fit: FitAddon;
  el: HTMLDivElement;
  ended: boolean;
}

const sessions: Session[] = [];
const byId = new Map<number, Session>();
const pending = new Map<number, string[]>(); // output that arrived before spawn() resolved
const listeners = new Set<() => void>();
let wired = false;
let keySeq = 0;
const api = () => (window as any).gitApi?.term;
const notify = () => listeners.forEach((l) => l());

function wire() {
  if (wired || !api()) return;
  wired = true;
  api().onData((id: number, data: string) => {
    const s = byId.get(id);
    if (s) s.term.write(data);
    else pending.set(id, [...(pending.get(id) ?? []), data]);
  });
  api().onExit((id: number) => {
    const s = byId.get(id);
    if (!s) return;
    s.ended = true;
    s.term.write('\r\n\x1b[2m[process exited — close this tab or open a new one]\x1b[0m\r\n');
    notify();
  });
}

const THEME = {
  background: '#13161c',
  foreground: '#cdd6f4',
  cursor: '#4cc2ff',
  selectionBackground: '#4cc2ff44',
  black: '#45475a',
  red: '#f38ba8',
  green: '#a6e3a1',
  yellow: '#f9e2af',
  blue: '#89b4fa',
  magenta: '#cba6f7',
  cyan: '#94e2d5',
  white: '#bac2de',
  brightBlack: '#585b70',
  brightRed: '#f38ba8',
  brightGreen: '#a6e3a1',
  brightYellow: '#f9e2af',
  brightBlue: '#89b4fa',
  brightMagenta: '#cba6f7',
  brightCyan: '#94e2d5',
  brightWhite: '#a6adc8',
};

async function create(cwd: string | null): Promise<Session> {
  wire();
  const el = document.createElement('div');
  el.style.height = '100%';
  const cfg = useSettings.getState();
  const term = new Terminal({
    fontFamily: termFont(cfg.termFontFamily),
    fontSize: cfg.termFontSize,
    cursorBlink: cfg.termCursorBlink,
    theme: THEME,
    scrollback: cfg.termScrollback,
    allowProposedApi: false,
  });
  const fit = new FitAddon();
  term.loadAddon(fit);
  term.open(el);
  const s: Session = { key: ++keySeq, id: null, title: 'zsh', term, fit, el, ended: false };
  sessions.push(s);
  notify();
  if (!api()) {
    term.write('Terminal is available in the desktop app.\r\n');
    return s;
  }
  const id: number = await api().spawn(cwd ?? '', term.cols || 80, term.rows || 24, cfg.termShell || undefined);
  s.id = id;
  byId.set(id, s);
  (pending.get(id) ?? []).forEach((d) => term.write(d));
  pending.delete(id);
  term.onData((d) => !s.ended && api().write(id, d));
  term.onResize(({ cols, rows }) => api().resize(id, cols, rows));
  return s;
}

function destroy(s: Session) {
  if (s.id != null && !s.ended) api()?.kill(s.id);
  if (s.id != null) byId.delete(s.id);
  s.term.dispose();
  sessions.splice(sessions.indexOf(s), 1);
  notify();
}

export function TerminalPanel({ cwd, onHide }: { cwd: string | null; onHide: () => void }) {
  const [, force] = useState(0);
  const [active, setActive] = useState<number | null>(sessions[0]?.key ?? null);
  const host = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const l = () => force((v) => v + 1);
    listeners.add(l);
    if (!sessions.length) create(cwd).then((s) => setActive(s.key));
    return () => {
      listeners.delete(l);
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const current = sessions.find((s) => s.key === active) ?? sessions[sessions.length - 1];

  // font size / cursor changes in Preferences apply to terminals that are already open
  useEffect(
    () =>
      useSettings.subscribe((s) => {
        sessions.forEach((x) => {
          x.term.options.fontFamily = termFont(s.termFontFamily);
          x.term.options.fontSize = s.termFontSize;
          x.term.options.cursorBlink = s.termCursorBlink;
          try {
            x.fit.fit();
          } catch {
            /* hidden */
          }
        });
      }),
    [],
  );

  // move the active terminal's element into our container and keep it sized to the panel
  useEffect(() => {
    const box = host.current;
    if (!box || !current) return;
    box.replaceChildren(current.el);
    const fitNow = () => {
      try {
        current.fit.fit();
      } catch {
        /* not visible yet */
      }
    };
    requestAnimationFrame(fitNow);
    current.term.focus();
    const ro = new ResizeObserver(fitNow);
    ro.observe(box);
    return () => ro.disconnect();
  }, [current]);

  const add = async () => setActive((await create(cwd)).key);
  const close = (s: Session) => {
    const i = sessions.indexOf(s);
    destroy(s);
    if (!sessions.length) onHide();
    else setActive(sessions[Math.max(0, i - 1)].key);
  };

  return (
    <section aria-label="Terminal" className="flex h-full min-h-0 flex-col bg-[#13161c]">
      <div
        role="tablist"
        aria-label="Terminal sessions"
        className="flex h-[38px] shrink-0 items-center gap-1 border-b border-surface bg-mantle px-2"
      >
        {sessions.map((s, i) => (
          <div
            key={s.key}
            className={`group flex h-[28px] items-center gap-1.5 rounded-md pl-2.5 pr-1 text-[13px] ${s === current ? 'bg-surface text-text' : 'text-sub hover:bg-surface/50'}`}
          >
            <button
              role="tab"
              aria-selected={s === current}
              onClick={() => setActive(s.key)}
              className="flex items-center gap-1.5"
            >
              <SquareTerminal size={14} aria-hidden />
              {s.title}
              {sessions.length > 1 ? ` ${i + 1}` : ''}
              {s.ended ? ' (exited)' : ''}
            </button>
            <button
              aria-label={`Close terminal ${i + 1}`}
              onClick={() => close(s)}
              className="rounded p-0.5 opacity-60 hover:bg-white/10 hover:opacity-100"
            >
              <X size={13} />
            </button>
          </div>
        ))}
        <button
          aria-label="New terminal"
          title="New terminal"
          onClick={add}
          className="rounded-md p-1.5 text-sub hover:bg-surface hover:text-text"
        >
          <Plus size={15} />
        </button>
        <div className="ml-auto flex items-center gap-1">
          <button
            aria-label="Clear terminal"
            title="Clear"
            onClick={() => current?.term.clear()}
            className="rounded-md p-1.5 text-sub hover:bg-surface hover:text-text"
          >
            <Trash2 size={15} />
          </button>
          <button
            aria-label="Hide terminal"
            title="Hide (Ctrl+`)"
            onClick={onHide}
            className="rounded-md p-1.5 text-sub hover:bg-surface hover:text-text"
          >
            <ChevronDown size={16} />
          </button>
        </div>
      </div>
      <div ref={host} className="min-h-0 flex-1 px-2 pt-1" />
    </section>
  );
}
