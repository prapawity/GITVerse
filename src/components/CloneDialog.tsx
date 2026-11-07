import { useEffect, useState } from 'react';
import { FolderOpen } from 'lucide-react';
import { useRepo } from '../store/repoStore';

const api = () => (window as any).gitApi;
const field = 'w-full rounded-md border border-surface bg-crust px-3 py-2 text-sm outline-none focus:border-[#4cc2ff]';

export function CloneDialog({ onClose }: { onClose: () => void }) {
  const [url, setUrl] = useState('');
  const [destination, setDestination] = useState('');
  const [parentFolder, setParentFolder] = useState('');
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState('');
  const [error, setError] = useState('');
  const [completed, setCompleted] = useState('');

  useEffect(() => api().onCloneProgress((message: string) => setProgress(message)), []);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !running) onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [running, onClose]);

  const destinationIn = (parent: string, repositoryUrl: string) => {
    const name =
      repositoryUrl
        .trim()
        .split(/[?#]/, 1)[0]
        .replace(/\/+$/, '')
        .split(/[/:]/)
        .pop()
        ?.replace(/\.git$/i, '') ?? '';
    const separator = parent.includes('\\') && !parent.includes('/') ? '\\' : '/';
    return `${parent.replace(/[\\/]+$/, '')}${separator}${name}`;
  };

  const browse = async () => {
    try {
      const parent: string | null = await api().openRepoDialog();
      if (!parent) return;
      setParentFolder(parent);
      setDestination(destinationIn(parent, url));
    } catch (e: any) {
      setError(String(e?.message ?? e));
    }
  };

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (running || !url.trim() || !destination.trim()) return;
    setError('');
    setProgress('Starting clone…');
    setRunning(true);
    try {
      await api().cloneRepo(url.trim(), destination.trim());
      useRepo.getState().recordActivity('success', 'Repository cloned', destination.trim(), destination.trim());
      setCompleted(destination.trim());
    } catch (e: any) {
      setError(String(e?.message ?? e).replace(/^Error invoking remote method '[^']*': (Error: )?/, ''));
      useRepo.getState().recordActivity('error', 'Clone failed', undefined, null);
    } finally {
      setRunning(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-[90] flex items-center justify-center bg-black/60 p-4"
      onMouseDown={() => {
        if (!running) onClose();
      }}
    >
      <section
        role="dialog"
        aria-modal="true"
        aria-labelledby="clone-title"
        onMouseDown={(e) => e.stopPropagation()}
        className="w-full max-w-[560px] rounded-xl border border-surface bg-mantle p-5 shadow-2xl"
      >
        <h2 id="clone-title" className="text-lg font-semibold">
          Clone repository
        </h2>
        {completed ? (
          <div role="status" className="mt-4">
            <p className="font-medium text-[#a6e3a1]">Repository cloned successfully</p>
            <p className="mt-2 break-all text-sm text-sub">{completed}</p>
            <div className="mt-5 flex justify-end gap-2">
              <button onClick={onClose} className="rounded-md border border-surface px-3 py-2">
                Close
              </button>
              <button
                onClick={() => {
                  onClose();
                  void useRepo.getState().openRepo(completed);
                }}
                className="rounded-md bg-[#4cc2ff] px-4 py-2 font-medium text-crust"
              >
                Open repository
              </button>
            </div>
          </div>
        ) : (
          <form onSubmit={submit} className="mt-4 space-y-4">
            <label className="block text-sm font-medium">
              Repository URL
              <input
                autoFocus
                value={url}
                onChange={(e) => {
                  setUrl(e.target.value);
                  if (parentFolder) setDestination(destinationIn(parentFolder, e.target.value));
                }}
                disabled={running}
                placeholder="https://github.com/user/repository.git"
                className={`${field} mt-1`}
              />
            </label>
            <label className="block text-sm font-medium">
              Destination folder
              <span className="mt-1 flex gap-2">
                <input
                  value={destination}
                  onChange={(e) => {
                    setParentFolder('');
                    setDestination(e.target.value);
                  }}
                  disabled={running}
                  placeholder="/path/to/new/folder"
                  className={field}
                />
                <button
                  type="button"
                  onClick={browse}
                  disabled={running}
                  className="flex shrink-0 items-center gap-1 rounded-md border border-surface px-3 hover:bg-surface/60"
                >
                  <FolderOpen size={16} /> Browse
                </button>
              </span>
            </label>
            <p className="text-xs text-sub">
              Choose a parent folder or enter the full path for the new repository folder. HTTPS and SSH use your system
              Git credentials or SSH agent.
            </p>
            {running && (
              <div role="status" aria-live="polite" className="space-y-2">
                <div className="progress-bar" />
                <p className="break-all text-sm text-sub">{progress}</p>
              </div>
            )}
            {error && (
              <div
                role="alert"
                className="max-h-40 overflow-auto whitespace-pre-wrap break-words rounded-md border border-[#f38ba8]/40 bg-[#f38ba8]/10 p-3 text-sm text-[#f38ba8]"
              >
                {error}
                {/authentication failed|could not read (username|password)|permission denied|terminal prompts disabled/i.test(
                  error,
                ) && (
                  <p className="mt-2">
                    Check your system Git credentials or SSH key and repository access, then try again.
                  </p>
                )}
              </div>
            )}
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={onClose}
                disabled={running}
                className="rounded-md border border-surface px-3 py-2 disabled:opacity-40"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={running || !url.trim() || !destination.trim()}
                className="rounded-md bg-[#4cc2ff] px-4 py-2 font-medium text-crust disabled:opacity-40"
              >
                {running ? 'Cloning…' : 'Clone'}
              </button>
            </div>
          </form>
        )}
      </section>
    </div>
  );
}
