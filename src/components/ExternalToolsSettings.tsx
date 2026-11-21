import { useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { desktopApi } from '../platform/api';

// tool names Git knows (git difftool --tool-help)
const KNOWN = [
  'vscode',
  'opendiff',
  'meld',
  'kdiff3',
  'bc',
  'p4merge',
  'smerge',
  'araxis',
  'tortoisemerge',
  'vimdiff',
  'nvimdiff',
  'emerge',
  'winmerge',
  'codecompare',
];
const field =
  'w-full max-w-[280px] rounded-md border border-surface bg-crust px-3 py-2 outline-none focus:border-accent';
const clean = (e: unknown) =>
  String((e as Error)?.message ?? e).replace(/^Error invoking remote method '[^']*': (Error: )?/, '');

/** Global `diff.tool` / `merge.tool`, used by the "external tool" buttons in diffs and conflicts. */
export function ExternalToolsSettings({ repoPath }: { repoPath: string }) {
  const [config, setConfig] = useState<{ diff: string; merge: string } | null>(null);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  useEffect(() => {
    void desktopApi()
      .externalToolConfig(repoPath)
      .then(setConfig)
      .catch((e: unknown) => setError(clean(e)));
  }, [repoPath]);
  if (!config)
    return error ? <p className="text-sm text-danger">{error}</p> : <Loader2 size={18} className="animate-spin" />;
  const save = async () => {
    setError('');
    try {
      await desktopApi().setExternalToolConfig(repoPath, { diff: config.diff.trim(), merge: config.merge.trim() });
      setMessage('Saved to your global Git config.');
    } catch (e) {
      setError(clean(e));
    }
  };
  return (
    <div className="max-w-[850px] space-y-5">
      <datalist id="git-tools">
        {KNOWN.map((t) => (
          <option key={t} value={t} />
        ))}
      </datalist>
      <div className="grid grid-cols-1 gap-x-8 gap-y-4 sm:grid-cols-[200px_1fr]">
        <label htmlFor="tool-diff" className="text-sm font-medium sm:pt-2">
          Diff tool
        </label>
        <input
          id="tool-diff"
          list="git-tools"
          value={config.diff}
          onChange={(e) => setConfig({ ...config, diff: e.target.value })}
          placeholder="e.g. vscode, opendiff, meld"
          className={field}
        />
        <label htmlFor="tool-merge" className="text-sm font-medium sm:pt-2">
          Merge tool
        </label>
        <input
          id="tool-merge"
          list="git-tools"
          value={config.merge}
          onChange={(e) => setConfig({ ...config, merge: e.target.value })}
          placeholder="e.g. vscode, opendiff, kdiff3"
          className={field}
        />
      </div>
      <p className="text-sm text-sub">
        These are Git’s own diff.tool / merge.tool settings, so git difftool and git mergetool use them too. The tool
        must be installed. Leave a field empty to remove it.
      </p>
      <div className="flex items-center gap-3">
        <button onClick={() => void save()} className="btn-primary px-4 py-2">
          Save external tools
        </button>
        {message && <span className="text-sm text-success">{message}</span>}
        {error && <span className="text-sm text-danger">{error}</span>}
      </div>
    </div>
  );
}
