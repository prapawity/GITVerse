import { useEffect, useRef, useState } from 'react';
import { Check, CircleStop, Loader2, RotateCcw, SendHorizontal, Sparkles, X, XCircle, Ban, ShieldQuestion } from 'lucide-react';
import { Markdown } from '../lib/markdown';
import { AI_MODEL, TOOL_KIND } from '../shared/aiTools';
import { PROVIDERS, providerLabel, type Provider } from '../shared/aiTypes';
import { useSettings } from '../store/settingsStore';
import { useAi, type Item } from '../store/aiStore';
import { useRepo } from '../store/repoStore';

const LABEL: Record<string, string> = {
  get_repo_status: 'Read repository status', list_branches: 'List branches', recent_commits: 'Read recent commits',
  fetch: 'Fetch', pull: 'Pull', push: 'Push', stash: 'Stash changes', stash_pop: 'Pop stash', checkout: 'Check out', create_branch: 'Create branch',
  rebase: 'Rebase', merge: 'Merge', flow_start: 'Git Flow: start', flow_finish: 'Git Flow: finish',
  get_conflicts: 'Read conflicts', get_conflict_file: 'Read conflicted file', resolve_conflict_file: 'Resolve conflicts in file',
  continue_operation: 'Continue', skip_commit: 'Skip commit', abort_operation: 'Abort',
};

/** One plain sentence about what an approval would do, so the user can judge it. */
function describeCall(name: string, i: Record<string, any>): string {
  switch (name) {
    case 'rebase': return `Rebase the current branch onto “${i.onto}”. This rewrites the branch's history.`;
    case 'merge': return `Merge “${i.ref}” into the current branch${i.no_ff === false ? '' : ' (always with a merge commit)'}.`;
    case 'flow_start': return `Create ${i.type} branch “${i.name}”${i.from ? ` from ${i.from}` : ''} using this repository's Gitflow settings and check it out.`;
    case 'flow_finish': return `Finish the current flow branch: merge it${i.tag_message ? ' (tagged)' : ''} into its target branch(es)${i.delete_branch === false ? '' : ' and delete it'}. Nothing is pushed.`;
    case 'resolve_conflict_file': return `Overwrite ${i.path} with the resolution below and stage it.`;
    case 'continue_operation': return 'Continue the stopped operation.';
    case 'skip_commit': return 'Drop the commit currently being applied.';
    case 'abort_operation': return 'Abort the operation and restore the branch to how it was. Resolutions so far are discarded.';
    case 'checkout': return `Check out “${i.ref}”.`;
    case 'create_branch': return `Create and check out branch “${i.name}”${i.from ? ` from ${i.from}` : ''}.`;
    default: return 'Run this on your repository.';
  }
}
const SUGGEST = ['Fetch and tell me what changed', 'Pull the latest changes', 'Push my branch', 'Which branch am I on?'];

function ToolCard({ it, onAnswer, who }: { it: Extract<Item, { kind: 'tool' }>; onAnswer: (ok: boolean) => void; who: string }) {
  const args = it.name === 'resolve_conflict_file' ? String(it.input.path ?? '') : Object.entries(it.input).map(([k, v]) => `${k}: ${typeof v === 'object' ? '…' : String(v)}`).join(', ');
  const regions = it.name === 'resolve_conflict_file' && Array.isArray(it.input.resolutions) ? (it.input.resolutions as { index: number; explanation: string }[]) : [];
  const write = TOOL_KIND[it.name] === 'write';
  const icon = {
    awaiting: <ShieldQuestion size={15} className="text-[#f9e2af]" aria-hidden />,
    running: <Loader2 size={15} className="animate-spin text-[#4cc2ff]" aria-hidden />,
    done: <Check size={15} className="text-[#a6e3a1]" aria-hidden />,
    error: <XCircle size={15} className="text-[#f38ba8]" aria-hidden />,
    declined: <Ban size={15} className="text-sub" aria-hidden />,
  }[it.status];
  return (
    <div className={`rounded-md border px-3 py-2 text-[13px] ${it.status === 'awaiting' ? 'border-[#f9e2af]/60 bg-[#f9e2af]/10' : 'border-surface bg-crust/60'}`}>
      <div className="flex items-center gap-2">
        {icon}
        <span className="font-medium">{LABEL[it.name] ?? it.name}</span>
        {args && <span className="truncate font-mono text-[12px] text-sub" title={args}>{args}</span>}
        {it.status === 'declined' && <span className="ml-auto text-[12px] text-sub">declined</span>}
      </div>
      {it.status === 'awaiting' && (
        <div className="mt-2">
          <p className="mb-2 text-sub">{who} wants to: {describeCall(it.name, it.input)}</p>
          {regions.length > 0 && (
            <ul className="mb-2 max-h-40 space-y-1 overflow-auto rounded bg-crust p-2 text-[12px]">
              {regions.map((g) => <li key={g.index}><span className="font-medium text-[#f472b6]">Region {g.index + 1}:</span> {g.explanation}</li>)}
            </ul>
          )}
          <div className="flex gap-2">
            <button autoFocus onClick={() => onAnswer(true)} className="min-h-[32px] rounded-md bg-[#4cc2ff] px-3 font-medium text-crust">Allow</button>
            <button onClick={() => onAnswer(false)} className="min-h-[32px] rounded-md border border-surface px-3 hover:bg-surface/60">Deny</button>
          </div>
        </div>
      )}
      {it.status === 'error' && it.result && <pre className="mt-1.5 max-h-28 overflow-auto whitespace-pre-wrap font-mono text-[12px] text-[#f38ba8]">{it.result}</pre>}
      {!write && it.status === 'done' && <span className="sr-only">done</span>}
    </div>
  );
}

/** Chat with Claude about the open repository; it can run git actions through the app (write actions need approval). */
export function AiPanel({ onClose, onOpenSettings }: { onClose: () => void; onOpenSettings: () => void }) {
  const { items, busy, send, stop, reset, answer } = useAi();
  const provider = useSettings((s) => s.aiProvider);
  const model = provider === 'claude' ? AI_MODEL : (provider === 'openai' ? useSettings.getState().openaiModel : useSettings.getState().copilotModel) || 'default model';
  const pick = (p: Provider) => {
    if (p === provider) return;
    useSettings.getState().set('aiProvider', p);
    reset(`Switched to ${providerLabel(p)} — new conversation.`); // histories can't be shared faithfully between providers
  };
  const repoPath = useRepo((s) => s.repoPath);
  const [text, setText] = useState('');
  const list = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);

  useEffect(() => { list.current?.scrollTo({ top: list.current.scrollHeight }); }, [items]);
  useEffect(() => { input.current?.focus(); }, []);

  const submit = () => { const t = text.trim(); if (!t || busy) return; setText(''); send(t); };
  const last = items[items.length - 1];
  const awaiting = items.some((it) => it.kind === 'tool' && it.status === 'awaiting'); // waiting on the user, not on the AI
  const waiting = busy && !awaiting && !(last?.kind === 'assistant' && last.text);

  return (
    <section aria-label="AI assistant" className="flex h-full min-w-0 flex-col bg-mantle">
      <header className="flex items-center gap-2 border-b border-surface px-4 py-3">
        <Sparkles size={17} className="shrink-0 text-[#cba6f7]" aria-hidden />
        <select aria-label="AI provider" value={provider} disabled={busy} onChange={(e) => pick(e.target.value as Provider)} className="rounded-md border border-surface bg-crust px-2 py-1 font-semibold outline-none focus:border-[#4cc2ff] disabled:opacity-60">
          {PROVIDERS.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
        </select>
        <span className="min-w-0 truncate text-[12px] text-sub" title={model}>{model}</span>
        <button onClick={() => reset()} disabled={busy || !items.length} aria-label="New conversation" title="New conversation" className="ml-auto rounded p-1.5 text-sub hover:bg-surface hover:text-text disabled:opacity-30"><RotateCcw size={15} /></button>
        <button onClick={onClose} aria-label="Close assistant" className="rounded p-1.5 text-sub hover:bg-surface hover:text-text"><X size={16} /></button>
      </header>

      <div ref={list} role="log" aria-live="polite" className="min-h-0 flex-1 space-y-3 overflow-y-auto px-4 py-4">
        {!items.length && (
          <div className="space-y-3 text-[14px]">
            <p className="text-sub">Ask in your own words — e.g. “pull แล้วบอกว่ามีอะไรเปลี่ยน”. {providerLabel(provider)} can fetch, pull, push, stash, check out and create branches. Anything that changes the repository asks for your approval first.</p>
            {!repoPath && <p className="text-[#f9e2af]">Open a repository first.</p>}
            <div className="flex flex-wrap gap-2">
              {SUGGEST.map((s) => <button key={s} disabled={!repoPath} onClick={() => send(s)} className="rounded-full border border-surface px-3 py-1.5 text-[13px] hover:bg-surface/60 disabled:opacity-40">{s}</button>)}
            </div>
            <p className="text-[12px] text-sub">Your messages, branch names, commit subjects and file names are sent to {PROVIDERS.find((p) => p.id === provider)!.sub} to answer.</p>
          </div>
        )}
        {items.map((it, i) => {
          if (it.kind === 'user') return <div key={i} className="ml-8 rounded-lg bg-[#4cc2ff]/15 px-3 py-2 text-[14px]"><span className="whitespace-pre-wrap">{it.text}</span></div>;
          if (it.kind === 'assistant') return !it.text ? null : <div key={i} className="text-[14px] [&>div]:p-0 [&>div]:text-[14px]"><Markdown text={it.text} /></div>;
          if (it.kind === 'tool') return <ToolCard key={it.id} it={it} onAnswer={answer} who={providerLabel(provider)} />;
          return (
            <div key={i} role={it.tone === 'error' ? 'alert' : undefined} className={`rounded-md px-3 py-2 text-[13px] ${it.tone === 'error' ? 'bg-[#f38ba8]/15 text-[#f38ba8]' : 'text-sub'}`}>
              {it.text}
              {it.auth && <button onClick={onOpenSettings} className="ml-2 underline">Open Preferences → AI</button>}
            </div>
          );
        })}
        {waiting && <div className="flex items-center gap-2 text-[13px] text-sub"><Loader2 size={14} className="animate-spin" aria-hidden /> {providerLabel(provider)} is thinking…</div>}
      </div>

      <div className="border-t border-surface p-3">
        <div className="flex items-end gap-2 rounded-lg border border-surface bg-crust p-2 focus-within:border-[#4cc2ff]">
          <textarea
            ref={input}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); submit(); } }}
            rows={2}
            aria-label="Message the assistant"
            placeholder={repoPath ? `Ask ${providerLabel(provider)} to fetch, pull, push… (Enter to send)` : 'Open a repository first'}
            disabled={!repoPath}
            className="max-h-40 min-h-[44px] flex-1 resize-none bg-transparent px-1 outline-none placeholder:text-sub"
          />
          {busy ? (
            <button onClick={stop} aria-label="Stop" title="Stop" className="flex h-9 w-9 items-center justify-center rounded-md bg-[#f38ba8]/20 text-[#f38ba8]"><CircleStop size={18} /></button>
          ) : (
            <button onClick={submit} disabled={!text.trim() || !repoPath} aria-label="Send" title="Send (Enter)" className="flex h-9 w-9 items-center justify-center rounded-md bg-[#4cc2ff] text-crust disabled:opacity-40"><SendHorizontal size={17} /></button>
          )}
        </div>
      </div>
    </section>
  );
}
