import { useCallback, useEffect, useState } from 'react';
import { Check, Copy, Loader2, RefreshCw, Sparkles, X } from 'lucide-react';
import { Markdown } from '../lib/markdown';
import { runAiTask, useExplain } from '../lib/aiTask';
import { providerLabel } from '../shared/aiTypes';
import { useSettings } from '../store/settingsStore';

type State = { phase: 'reading' | 'writing' } | { phase: 'done'; text: string } | { phase: 'error'; message: string };

/** AI explanation of a commit, a range, a branch or the working changes. Opened through `useExplain`. */
export function ExplainDialog() {
  const request = useExplain((s) => s.request);
  const close = useExplain((s) => s.close);
  const provider = useSettings((s) => s.aiProvider);
  const [state, setState] = useState<State>({ phase: 'reading' });
  const [copied, setCopied] = useState(false);
  const [run, setRun] = useState(0);

  const start = useCallback(async () => {
    if (!request) return;
    setState({ phase: 'reading' });
    try {
      const material = await request.material();
      if (!material.trim()) throw new Error('There are no changes to explain.');
      setState({ phase: 'writing' });
      setState({ phase: 'done', text: await runAiTask('explain', material) });
    } catch (e) {
      setState({
        phase: 'error',
        message: String((e as Error)?.message ?? e).replace(/^Error invoking remote method '[^']*': (Error: )?/, ''),
      });
    }
  }, [request]);
  useEffect(() => {
    void start();
  }, [start, run]);
  useEffect(() => {
    if (!request) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && close();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [request, close]);
  if (!request) return null;

  return (
    <div className="fixed inset-0 z-[95] flex items-center justify-center bg-black/55 p-4" onMouseDown={close}>
      <section
        role="dialog"
        aria-modal="true"
        aria-labelledby="explain-title"
        onMouseDown={(e) => e.stopPropagation()}
        className="flex max-h-[85vh] w-full max-w-[720px] flex-col overflow-hidden rounded-xl border border-surface bg-mantle shadow-2xl"
      >
        <header className="flex items-start gap-3 border-b border-surface px-5 py-4">
          <Sparkles size={18} className="mt-0.5 text-ai" aria-hidden />
          <div className="min-w-0 flex-1">
            <h2 id="explain-title" className="truncate font-semibold">
              {request.title}
            </h2>
            {request.subtitle && <p className="truncate text-sm text-sub">{request.subtitle}</p>}
          </div>
          <button onClick={close} aria-label="Close" className="rounded p-1.5 hover:bg-surface">
            <X size={17} />
          </button>
        </header>
        <div className="min-h-[160px] flex-1 overflow-y-auto px-5 py-4" aria-live="polite">
          {(state.phase === 'reading' || state.phase === 'writing') && (
            <p className="flex items-center gap-2 text-sm text-sub">
              <Loader2 size={15} className="animate-spin text-ai" aria-hidden />
              {state.phase === 'reading'
                ? 'Reading the changes…'
                : `${providerLabel(provider)} is writing the explanation…`}
            </p>
          )}
          {state.phase === 'error' && (
            <p role="alert" className="whitespace-pre-wrap text-sm text-danger">
              {state.message}
            </p>
          )}
          {state.phase === 'done' && (
            <div className="fade-in text-sm leading-relaxed">
              <Markdown text={state.text} />
            </div>
          )}
        </div>
        <footer className="flex items-center gap-2 border-t border-surface px-5 py-3">
          <span className="flex-1 text-xs text-sub">
            Sent to {providerLabel(provider)}. Check important details against the diff.
          </span>
          {state.phase === 'done' && (
            <button
              onClick={() =>
                void navigator.clipboard.writeText(state.text).then(() => {
                  setCopied(true);
                  setTimeout(() => setCopied(false), 1500);
                })
              }
              className="btn-secondary flex items-center gap-1.5 px-3 py-1.5 text-sm"
            >
              {copied ? <Check size={14} aria-hidden /> : <Copy size={14} aria-hidden />}
              {copied ? 'Copied' : 'Copy'}
            </button>
          )}
          {(state.phase === 'done' || state.phase === 'error') && (
            <button
              onClick={() => setRun((n) => n + 1)}
              className="btn-secondary flex items-center gap-1.5 px-3 py-1.5 text-sm"
            >
              <RefreshCw size={14} aria-hidden /> Ask again
            </button>
          )}
        </footer>
      </section>
    </div>
  );
}
