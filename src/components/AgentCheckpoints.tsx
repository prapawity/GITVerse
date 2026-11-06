import { useEffect, useState } from 'react';
import { Bot, ShieldCheck } from 'lucide-react';
import { useRepo } from '../store/repoStore';

interface Checkpoint { ref: string; hash: string; subject: string }

export function AgentCheckpoints({ repo }: { repo: string }) {
  const [checkpoints, setCheckpoints] = useState<Checkpoint[]>([]);
  useEffect(() => {
    const api = (window as Window & { gitApi?: { agentCheckpoints?: (cwd: string) => Promise<Checkpoint[]> } }).gitApi;
    if (!api?.agentCheckpoints) return;
    let active = true;
    let pending = false;
    let reported = false;
    const refresh = async () => {
      if (pending) return;
      pending = true;
      try {
        const result = await api.agentCheckpoints!(repo);
        if (active) setCheckpoints(result);
        reported = false;
      } catch (error) {
        if (active && !reported) {
          useRepo.getState().notify('warning', 'Could not load Agent checkpoints', error instanceof Error ? error.message : String(error));
          reported = true;
        }
      } finally { pending = false; }
    };
    void refresh();
    const timer = window.setInterval(() => { if (!document.hidden) void refresh(); }, 5000);
    return () => { active = false; window.clearInterval(timer); };
  }, [repo]);
  if (!checkpoints.length) return null;
  return (
    <aside aria-label="Agent recovery snapshots" className="shrink-0 border-b border-dashed border-surface bg-mantle px-4 py-3">
      <details>
        <summary className="cursor-pointer rounded text-sm font-medium">
          <span className="inline-flex flex-wrap items-center gap-2 align-middle"><Bot size={17} aria-hidden />Agent checkpoints <span className="rounded-full border border-surface px-2 text-xs">{checkpoints.length}</span><span className="text-xs font-normal text-sub">Local recovery snapshots · Not branch history</span></span>
        </summary>
        <p className="mt-3 flex items-start gap-2 text-sm text-sub"><ShieldCheck size={16} className="mt-0.5 shrink-0" aria-hidden />Created by your coding agent for recovery. Stored as Git objects under refs/agents, not commits on your working branch. Normal branch pushes do not publish these refs.</p>
        <ul className="mt-3 max-h-40 space-y-2 overflow-y-auto" aria-label="Checkpoint references">
          {checkpoints.map((checkpoint) => <li key={checkpoint.ref} className="rounded-md border border-dashed border-surface bg-crust/50 px-3 py-2">
            <p className="break-words text-sm">{checkpoint.subject}</p>
            <p className="mt-1 break-all font-mono text-xs text-sub">{checkpoint.ref} · {checkpoint.hash}</p>
          </li>)}
        </ul>
      </details>
    </aside>
  );
}
