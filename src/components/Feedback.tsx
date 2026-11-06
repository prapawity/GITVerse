import { useEffect, useRef, useState } from 'react';
import { AlertTriangle, CheckCircle2, ChevronDown, ChevronRight, Copy, Info, X, XCircle } from 'lucide-react';
import { useRepo, type Toast } from '../store/repoStore';
import { Spinner, useDelayed } from './Loading';

const STYLE = {
  success: { Icon: CheckCircle2, color: '#a6e3a1', ms: 3500 },
  info: { Icon: Info, color: '#4cc2ff', ms: 6000 },
  warning: { Icon: AlertTriangle, color: '#f9e2af', ms: 9000 },
  error: { Icon: XCircle, color: '#f38ba8', ms: 0 }, // 0 = stays until dismissed: failures must not vanish before they are read
} as const;

function ToastCard({ t }: { t: Toast }) {
  const dismiss = useRepo((s) => s.dismissToast);
  const [hover, setHover] = useState(false);
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const { Icon, color, ms } = STYLE[t.kind];

  // auto-dismiss, paused while the pointer is over the card or its detail is open
  useEffect(() => {
    if (!ms || hover || open) return;
    const id = setTimeout(() => dismiss(t.id), ms);
    return () => clearTimeout(id);
  }, [ms, hover, open, dismiss, t.id]);

  const detail = t.detail?.trim();
  const long = !!detail && (detail.includes('\n') || detail.length > 110);
  const copy = async () => {
    try { await navigator.clipboard.writeText(`${t.title}\n\n${detail ?? ''}`.trim()); setCopied(true); setTimeout(() => setCopied(false), 1500); } catch { /* clipboard blocked */ }
  };

  return (
    <div
      role={t.kind === 'error' ? 'alert' : 'status'}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      className="toast-in pointer-events-auto overflow-hidden rounded-lg border border-surface bg-[#262b36] shadow-2xl"
      style={{ borderLeft: `4px solid ${color}` }}
    >
      <div className="flex items-start gap-3 px-4 py-3">
        <Icon size={20} className="mt-0.5 shrink-0" style={{ color }} aria-hidden />
        <div className="min-w-0 flex-1">
          <div className="font-semibold leading-snug">{t.title}</div>
          {detail && !long && <div className="mt-1 break-words text-[13px] text-sub">{detail}</div>}
          {detail && long && (
            <>
              <button onClick={() => setOpen(!open)} aria-expanded={open} className="mt-1 flex items-center gap-1 text-[13px] text-sub hover:text-text">
                {open ? <ChevronDown size={14} aria-hidden /> : <ChevronRight size={14} aria-hidden />} {open ? 'Hide details' : 'Show details'}
              </button>
              {open && <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap break-words rounded bg-crust p-2 font-mono text-[12px] text-sub">{detail}</pre>}
            </>
          )}
          {t.kind === 'error' && detail && (
            <button onClick={copy} className="mt-2 flex items-center gap-1.5 text-[13px] text-sub hover:text-text"><Copy size={13} aria-hidden /> {copied ? 'Copied' : 'Copy details'}</button>
          )}
        </div>
        <button onClick={() => dismiss(t.id)} aria-label="Dismiss" className="-mr-1 -mt-1 rounded p-1.5 text-sub hover:bg-surface hover:text-text"><X size={15} /></button>
      </div>
    </div>
  );
}

/** Stack of result messages, bottom-right. */
export function Toasts() {
  const toasts = useRepo((s) => s.toasts);
  const error = useRepo((s) => s.error);

  // anything elsewhere that reports through `error` (components, older code paths) becomes an error toast too
  useEffect(() => {
    if (!error) return;
    useRepo.getState().notify('error', 'Something went wrong', error);
    useRepo.setState({ error: null });
  }, [error]);

  return (
    <div aria-label="Notifications" className="pointer-events-none fixed bottom-5 right-5 z-[130] flex w-[400px] max-w-[calc(100vw-2.5rem)] flex-col gap-2">
      {toasts.map((t) => <ToastCard key={t.id} t={t} />)}
    </div>
  );
}

/**
 * Full-screen block while an operation that moves HEAD or rewrites the working tree runs (checkout, pull, rebase…).
 * Appears only if the operation takes longer than ~250 ms, so quick ones don't flash it.
 */
export function BusyOverlay() {
  const working = useRepo((s) => s.working);
  const blocking = useRepo((s) => s.blocking);
  const show = useDelayed(!!working && blocking, 250);
  const last = useRef('');
  if (working) last.current = working;
  if (!show) return null;
  return (
    <div role="alertdialog" aria-modal="true" aria-busy="true" aria-label={working ?? last.current} className="fade-in fixed inset-0 z-[200] flex items-center justify-center bg-black/55 backdrop-blur-[2px]">
      <div className="flex w-[340px] flex-col items-center gap-4 rounded-xl border border-surface bg-[#262b36] px-8 py-8 shadow-2xl">
        <Spinner size={42} className="text-[#4cc2ff]" />
        <div className="text-center">
          <div className="text-[17px] font-semibold">{working ?? last.current}</div>
          <div className="mt-1 text-[13px] text-sub">Please wait — the repository is being updated. Don't close the app.</div>
        </div>
      </div>
    </div>
  );
}
