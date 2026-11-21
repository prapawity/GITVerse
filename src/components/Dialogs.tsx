import { useEffect, useMemo, useRef, useState } from 'react';
import { flowFor, type FlowConfig } from '../store/settingsStore';
import { useRepo } from '../store/repoStore';
import { create } from 'zustand';

type Req =
  | { kind: 'confirm'; title: string; message: string; danger?: boolean; label?: string; resolve: (v: boolean) => void }
  | { kind: 'text'; title: string; placeholder: string; initial?: string; resolve: (v: string | null) => void }
  | { kind: 'flow'; branches: string[]; source: string; resolve: (v: string | null) => void };

const useDialog = create<{ req: Req | null; open: (r: Req) => void; close: () => void }>((set) => ({
  req: null,
  open: (req) => set({ req }),
  close: () => set({ req: null }),
}));

export const askConfirm = (title: string, message: string, opts: { danger?: boolean; label?: string } = {}) =>
  new Promise<boolean>((resolve) => useDialog.getState().open({ kind: 'confirm', title, message, resolve, ...opts }));
export const askText = (title: string, placeholder = '', initial = '') =>
  new Promise<string | null>((resolve) =>
    useDialog.getState().open({ kind: 'text', title, placeholder, initial, resolve }),
  );
export const askFlow = (branches: string[], source: string) =>
  new Promise<string | null>((resolve) => useDialog.getState().open({ kind: 'flow', branches, source, resolve }));

// Branch types come from the repo's Gitflow preferences (prefixes and base branches are configurable)
const makeFlow = (c: FlowConfig) => [
  { id: 'feature', prefix: c.feature, hint: 'New functionality', color: '#a6e3a1' },
  { id: 'bugfix', prefix: c.bugfix, hint: 'Non-urgent fix', color: '#f9e2af' },
  { id: 'release', prefix: c.release, hint: 'Prepare a version', color: '#cba6f7' },
  { id: 'hotfix', prefix: c.hotfix, hint: 'Urgent production fix', color: '#f38ba8' },
  { id: 'support', prefix: c.support, hint: 'Long-term support', color: '#94e2d5' },
  { id: '', prefix: '', hint: 'No prefix', color: '#4cc2ff' },
];

const btn = 'px-4 py-2 min-h-[36px]';

function Shell({ title, onCancel, children }: { title: string; onCancel: () => void; children: React.ReactNode }) {
  useEffect(() => {
    const h = (e: KeyboardEvent) => e.key === 'Escape' && onCancel();
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [onCancel]);
  return (
    <div className="fixed inset-0 z-[100] flex items-start justify-center bg-black/55 pt-[15vh]" onMouseDown={onCancel}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className="w-[460px] max-w-[92vw] rounded-lg border border-surface bg-mantle p-5 shadow-2xl"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <h2 className="mb-3 text-base font-semibold">{title}</h2>
        {children}
      </div>
    </div>
  );
}

function FlowDialog({
  branches,
  source,
  resolve,
}: {
  branches: string[];
  source: string;
  resolve: (v: string | null) => void;
}) {
  const close = useDialog((s) => s.close);
  const FLOW = useMemo(() => makeFlow(flowFor(useRepo.getState().repoPath)), []);
  const [type, setType] = useState<(typeof FLOW)[number]>(FLOW[0]);
  const [name, setName] = useState('');
  const clean = name.trim().replace(/\s+/g, '-');
  const full = `${type.prefix}${clean}`;
  const exists = branches.includes(full);
  const err = !clean ? 'Enter a branch name' : exists ? `Branch "${full}" already exists` : '';
  const done = (v: string | null) => {
    resolve(v);
    close();
  };

  return (
    <Shell title="Create branch (Git Flow)" onCancel={() => done(null)}>
      <div role="radiogroup" aria-label="Branch type" className="mb-3 grid grid-cols-3 gap-2">
        {FLOW.map((t) => (
          <button
            key={t.id || 'plain'}
            role="radio"
            aria-checked={type === t}
            onClick={() => setType(t)}
            className={`rounded border px-2 py-2 text-left ${type === t ? 'border-accent bg-accent/15' : 'border-surface hover:bg-surface/50'}`}
          >
            <div className="font-medium" style={{ color: t.color }}>
              {t.id || 'plain'}
            </div>
            <div className="text-xs text-sub">{t.hint}</div>
          </button>
        ))}
      </div>
      <label className="mb-1 block text-xs text-sub" htmlFor="bn">
        Name
      </label>
      <input
        id="bn"
        autoFocus
        value={name}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => e.key === 'Enter' && !err && done(full)}
        placeholder="e.g. DEMO-18562-demo-ui"
        aria-invalid={!!err && !!name}
        aria-describedby="bn-err"
        className="w-full rounded border border-surface bg-crust px-3 py-2 outline-none focus:border-accent"
      />
      <div id="bn-err" className="mt-1 min-h-[18px] text-xs text-danger">
        {name && err}
      </div>
      <p className="mt-2 text-sm text-sub">
        New branch will start at <span className="break-all font-medium text-text">{source}</span>.
      </p>
      <div className="mt-4 flex justify-end gap-2">
        <button className={`btn-ghost ${btn}`} onClick={() => done(null)}>
          Cancel
        </button>
        <button disabled={!!err} className={`btn-primary ${btn}`} onClick={() => done(full)}>
          Create branch
        </button>
      </div>
    </Shell>
  );
}

export function DialogHost() {
  const { req, close } = useDialog();
  const [text, setText] = useState('');
  const ref = useRef<HTMLButtonElement>(null);
  useEffect(() => setText(req?.kind === 'text' ? (req.initial ?? '') : ''), [req]);
  useEffect(() => {
    if (req?.kind === 'confirm') ref.current?.focus();
  }, [req]);
  if (!req) return null;
  if (req.kind === 'flow') return <FlowDialog branches={req.branches} source={req.source} resolve={req.resolve} />;
  if (req.kind === 'confirm') {
    const done = (v: boolean) => {
      req.resolve(v);
      close();
    };
    return (
      <Shell title={req.title} onCancel={() => done(false)}>
        <p className="mb-4 whitespace-pre-wrap break-words text-sub">{req.message}</p>
        <div className="flex justify-end gap-2">
          <button className={`btn-ghost ${btn}`} onClick={() => done(false)}>
            Cancel
          </button>
          <button
            ref={ref}
            className={`btn-primary ${btn} ${req.danger ? '!bg-danger' : ''}`}
            onClick={() => done(true)}
          >
            {req.label ?? 'Confirm'}
          </button>
        </div>
      </Shell>
    );
  }
  const done = (v: string | null) => {
    req.resolve(v);
    close();
  };
  return (
    <Shell title={req.title} onCancel={() => done(null)}>
      <input
        autoFocus
        value={text}
        placeholder={req.placeholder}
        aria-label={req.title}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => e.key === 'Enter' && text.trim() && done(text.trim())}
        className="w-full rounded border border-surface bg-crust px-3 py-2 outline-none focus:border-accent"
      />
      <div className="mt-4 flex justify-end gap-2">
        <button className={`btn-ghost ${btn}`} onClick={() => done(null)}>
          Cancel
        </button>
        <button disabled={!text.trim()} className={`btn-primary ${btn}`} onClick={() => done(text.trim())}>
          OK
        </button>
      </div>
    </Shell>
  );
}
