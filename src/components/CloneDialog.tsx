import { useEffect, useState } from 'react';
import { FolderOpen } from 'lucide-react';
import { useRepo } from '../store/repoStore';
import { desktopApi } from '../platform/api';

const api = () => desktopApi();
const field = 'w-full rounded-md border border-surface bg-crust px-3 py-2 text-sm outline-none focus:border-accent';

export function CloneDialog({ onClose }: { onClose: () => void }) {
  const [url, setUrl] = useState('');
  const [destination, setDestination] = useState('');
  const [parentFolder, setParentFolder] = useState('');
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState('');
  const [error, setError] = useState('');
  const [completed, setCompleted] = useState('');
  const [authNeeded, setAuthNeeded] = useState(false);
  const [login, setLogin] = useState('');
  const [password, setPassword] = useState('');
  const [shallow, setShallow] = useState(false);
  const [depth, setDepth] = useState('1');

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
    if (running || !url.trim() || !destination.trim() || (authNeeded && (!login.trim() || !password))) return;
    setError('');
    setProgress('Starting clone…');
    setRunning(true);
    try {
      await api().cloneRepo(
        url.trim(),
        destination.trim(),
        authNeeded ? { username: login.trim(), password } : undefined,
        { depth: shallow ? Math.max(1, Number.parseInt(depth, 10) || 1) : null },
      );
      setPassword('');
      useRepo.getState().recordActivity('success', 'Repository cloned', destination.trim(), destination.trim());
      setCompleted(destination.trim());
    } catch (e: any) {
      const message = String(e?.message ?? e).replace(/^Error invoking remote method '[^']*': (Error: )?/, '');
      setError(message);
      if (
        /^https:\/\//i.test(url.trim()) &&
        /authentication failed|http basic: access denied|could not read (username|password)|invalid (username|password|credentials)|\b401\b/i.test(
          message,
        )
      )
        setAuthNeeded(true);
      setPassword('');
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
            <p className="font-medium text-success">Repository cloned successfully</p>
            <p className="mt-2 break-all text-sm text-sub">{completed}</p>
            <div className="mt-5 flex justify-end gap-2">
              <button onClick={onClose} className="btn-secondary px-3 py-2">
                Close
              </button>
              <button
                onClick={() => {
                  onClose();
                  void useRepo.getState().openRepo(completed);
                }}
                className="btn-primary px-4 py-2"
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
                  setAuthNeeded(false);
                  setPassword('');
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
                  className="btn-secondary flex shrink-0 items-center gap-1 px-3"
                >
                  <FolderOpen size={16} /> Browse
                </button>
              </span>
            </label>
            <p className="text-xs text-sub">
              Choose a parent folder or enter the full path for the new repository folder. HTTPS and SSH use your system
              Git credentials or SSH agent.
            </p>
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={shallow}
                  disabled={running}
                  onChange={(e) => setShallow(e.target.checked)}
                />
                Shallow clone — only the latest
              </label>
              <input
                type="number"
                min={1}
                value={depth}
                disabled={!shallow || running}
                onChange={(e) => setDepth(e.target.value)}
                aria-label="Number of commits to clone"
                className="w-20 rounded-md border border-surface bg-crust px-2 py-1 outline-none focus:border-accent disabled:opacity-40"
              />
              <span>commit{depth === '1' ? '' : 's'}</span>
              {shallow && (
                <span className="w-full text-xs text-sub">
                  Much faster for large repositories. Older history is not downloaded (fetch with --unshallow later for
                  the rest).
                </span>
              )}
            </div>
            {authNeeded && (
              <div className="space-y-3 rounded-lg border border-warning/40 bg-warning/5 p-3">
                <p className="text-sm text-warning">
                  Enter HTTPS credentials to retry. Your server may require an access token.
                </p>
                <label className="block text-sm">
                  Username
                  <input
                    autoComplete="username"
                    value={login}
                    disabled={running}
                    onChange={(e) => setLogin(e.target.value)}
                    className={`${field} mt-1`}
                  />
                </label>
                <label className="block text-sm">
                  Password or access token
                  <input
                    type="password"
                    autoComplete="off"
                    value={password}
                    disabled={running}
                    onChange={(e) => setPassword(e.target.value)}
                    className={`${field} mt-1`}
                  />
                </label>
                <p className="text-xs text-sub">Used for this retry and not saved.</p>
              </div>
            )}
            {running && (
              <div role="status" aria-live="polite" className="space-y-2">
                <div className="progress-bar" />
                <p className="break-all text-sm text-sub">{progress}</p>
              </div>
            )}
            {error && (
              <div
                role="alert"
                className="max-h-40 overflow-auto whitespace-pre-wrap break-words rounded-md border border-danger/40 bg-danger/10 p-3 text-sm text-danger"
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
              <button type="button" onClick={onClose} disabled={running} className="btn-secondary px-3 py-2">
                Cancel
              </button>
              <button
                type="submit"
                disabled={running || !url.trim() || !destination.trim() || (authNeeded && (!login.trim() || !password))}
                className="btn-primary px-4 py-2"
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
