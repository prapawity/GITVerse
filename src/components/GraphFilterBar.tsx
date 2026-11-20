import { EyeOff, Focus, X } from 'lucide-react';
import { useSettings } from '../store/settingsStore';

const label = (key: string) => key.slice(key.indexOf(':') + 1);

/** Shown above the graph while refs are hidden or soloed; one click shows everything again. */
export function GraphFilterBar({ repo }: { repo: string }) {
  const hidden = useSettings((s) => s.graphHidden[repo]) ?? [];
  const solo = useSettings((s) => s.graphSolo[repo]) ?? [];
  const setRefVisibility = useSettings((s) => s.setRefVisibility);
  const reset = useSettings((s) => s.resetRefVisibility);
  if (!hidden.length && !solo.length) return null;
  const soloing = solo.length > 0;
  const keys = soloing ? solo : hidden;
  return (
    <div className="slide-down flex flex-wrap items-center gap-2 border-b border-surface bg-warning/5 px-4 py-1.5 text-xs">
      {soloing ? (
        <Focus size={14} className="text-warning" aria-hidden />
      ) : (
        <EyeOff size={14} className="text-sub" aria-hidden />
      )}
      <span className="text-sub">{soloing ? 'Solo:' : `${hidden.length} hidden:`}</span>
      {keys.map((key) => (
        <span key={key} className="flex items-center gap-1 rounded-full bg-surface/70 py-0.5 pl-2 pr-1">
          {label(key)}
          <button
            onClick={() => setRefVisibility(repo, key, soloing ? 'unsolo' : 'show')}
            aria-label={`${soloing ? 'Stop solo' : 'Show'} ${label(key)}`}
            className="rounded-full p-0.5 hover:bg-surface"
          >
            <X size={11} />
          </button>
        </span>
      ))}
      {soloing && hidden.length > 0 && <span className="text-sub">({hidden.length} hidden when solo ends)</span>}
      <button onClick={() => reset(repo)} className="ml-auto text-accent hover:underline">
        Show all
      </button>
    </div>
  );
}
