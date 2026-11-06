import { useEffect, useState } from 'react';
import { Archive, X } from 'lucide-react';

export function StashView({
  repo,
  stash,
  onClose,
}: {
  repo: string;
  stash: { id: string; message: string };
  onClose: () => void;
}) {
  const [diff, setDiff] = useState<string | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    setDiff(null);
    setError('');
    (window as any).gitApi
      .stashDiff(repo, stash.id)
      .then((value: string) => {
        if (active) setDiff(value);
      })
      .catch((e: Error) => {
        if (active) setError(e.message.replace(/^Error invoking remote method '[^']*': (Error: )?/, ''));
      });
    return () => {
      active = false;
    };
  }, [repo, stash.id]);
  const lines = diff?.split('\n') ?? [];
  return (
    <section className="flex h-full min-h-0 flex-col bg-canvas" aria-label="Stash details">
      <header className="flex items-center gap-2 border-b border-surface px-4 py-3">
        <Archive size={16} className="text-[#4cc2ff]" />
        <span className="font-semibold">{stash.id}</span>
        <span className="min-w-0 flex-1 truncate text-sub" title={stash.message}>
          {stash.message}
        </span>
        <button onClick={onClose} aria-label="Close stash details" className="rounded p-1 hover:bg-surface">
          <X size={16} />
        </button>
      </header>
      {error ? (
        <p role="alert" className="whitespace-pre-wrap p-4 text-[#f38ba8]">
          {error}
        </p>
      ) : diff === null ? (
        <p role="status" className="p-4 text-sub">
          Loading stash…
        </p>
      ) : !diff.trim() ? (
        <p className="p-4 text-sub">This stash has no textual changes.</p>
      ) : (
        <div className="min-h-0 flex-1 overflow-auto">
          <pre className="w-max min-w-full font-mono text-xs leading-5">
            {lines.map((line, i) => (
              <div
                key={i}
                className={`px-4 ${line.startsWith('+') && !line.startsWith('+++') ? 'bg-[#a6e22e]/15 text-[#a6e3a1]' : line.startsWith('-') && !line.startsWith('---') ? 'bg-[#f38ba8]/15 text-[#f38ba8]' : line.startsWith('@@') || line.startsWith('diff --git') ? 'text-[#4cc2ff]' : 'text-text'}`}
              >
                {line || ' '}
              </div>
            ))}
          </pre>
        </div>
      )}
    </section>
  );
}
