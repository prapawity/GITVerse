import { useState } from 'react';
import { AlertCircle, CheckCircle2, ClipboardList, Info, Trash2, X } from 'lucide-react';
import { useRepo } from '../store/repoStore';

export function ActivityLog() {
  const [open, setOpen] = useState(false);
  const activity = useRepo((s) => s.activity);
  const clear = useRepo((s) => s.clearActivity);
  const current = useRepo((s) => s.repoPath);
  return <footer className="relative flex h-8 shrink-0 items-center border-t border-surface bg-crust px-3 text-xs text-sub">
    <button onClick={() => setOpen(!open)} aria-expanded={open} aria-controls="activity-log" className={`flex h-full items-center gap-2 rounded px-2 hover:bg-surface/50 hover:text-text ${open ? 'text-[#4cc2ff]' : ''}`}><ClipboardList size={15} /> Activity log {activity.length > 0 && <span className="rounded-full bg-surface px-1.5 py-0.5 text-[10px]">{activity.length}</span>}</button>
    <span className="pointer-events-none absolute left-1/2 -translate-x-1/2 text-[10px]">Crafted by Prapawity</span>
    <span className="ml-auto max-w-[40%] min-w-0 truncate text-right" title={current ?? undefined}>{current ?? 'No repository open'}</span>
    {open && <section id="activity-log" aria-label="Activity log" className="absolute bottom-full left-2 z-[70] mb-2 flex max-h-[min(60vh,520px)] w-[min(520px,90vw)] flex-col overflow-hidden rounded-lg border border-surface bg-mantle shadow-2xl">
      <header className="flex shrink-0 items-center gap-2 border-b border-surface px-4 py-3"><ClipboardList size={16} className="text-[#4cc2ff]" /><h2 className="flex-1 text-sm font-semibold text-text">Activity log</h2><button onClick={clear} disabled={!activity.length} className="flex items-center gap-1 rounded px-2 py-1 hover:bg-surface/50 disabled:opacity-40"><Trash2 size={14} /> Clear</button><button onClick={() => setOpen(false)} aria-label="Close activity log" className="rounded p-1 hover:bg-surface/50"><X size={16} /></button></header>
      <div className="min-h-0 overflow-y-auto">
        {!activity.length ? <p className="px-4 py-8 text-center text-sm">No activity yet.</p> : activity.map((item) => {
          const Icon = item.kind === 'success' ? CheckCircle2 : item.kind === 'error' || item.kind === 'warning' ? AlertCircle : Info;
          const color = item.kind === 'success' ? 'text-[#a6e3a1]' : item.kind === 'error' ? 'text-[#f38ba8]' : item.kind === 'warning' ? 'text-[#f9e2af]' : 'text-[#4cc2ff]';
          return <div key={item.id} className="flex gap-3 border-b border-surface/50 px-4 py-3 last:border-0"><Icon size={16} className={`mt-0.5 shrink-0 ${color}`} /><div className="min-w-0 flex-1"><div className="break-words text-sm font-medium text-text">{item.title}</div>{item.repo && <div title={item.repo} className="mt-1 truncate">{item.repo.split(/[\\/]/).pop()}</div>}{item.detail && <details className="mt-1"><summary className="cursor-pointer hover:text-text">Details</summary><pre className="mt-1 max-h-36 overflow-auto whitespace-pre-wrap break-all rounded bg-crust p-2">{item.detail}</pre></details>}</div><time className="shrink-0 text-[11px]" dateTime={new Date(item.time).toISOString()}>{new Date(item.time).toLocaleString()}</time></div>;
        })}
      </div>
      <p className="border-t border-surface px-4 py-2 text-[11px]">Activity is kept for this session, up to 200 entries.</p>
    </section>}
  </footer>;
}
