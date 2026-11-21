import { useEffect, useState } from 'react';
import { Loader2, ShieldCheck } from 'lucide-react';
import { desktopApi } from '../platform/api';

type Format = 'openpgp' | 'ssh' | 'x509';
interface Config {
  format: Format;
  key: string;
  commits: boolean;
  tags: boolean;
  scope: 'local' | 'global' | 'none';
}
const field =
  'w-full max-w-[420px] rounded-md border border-surface bg-crust px-3 py-2 outline-none focus:border-accent';
const KEY_HINT: Record<Format, string> = {
  openpgp:
    'GPG key ID or fingerprint (gpg --list-secret-keys --keyid-format=long). Leave empty to use your default key.',
  ssh: 'Path to your public key (e.g. ~/.ssh/id_ed25519.pub) or the key itself ("ssh-ed25519 AAAA…").',
  x509: 'Certificate ID used by gpgsm / smimesign.',
};
const clean = (e: unknown) =>
  String((e as Error)?.message ?? e).replace(/^Error invoking remote method '[^']*': (Error: )?/, '');

/** Git commit / tag signing for the open repository or for every repository (git config). */
export function SigningSettings({ repoPath, repoName }: { repoPath: string; repoName: string }) {
  const [config, setConfig] = useState<Config | null>(null);
  const [scope, setScope] = useState<'local' | 'global'>('local');
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    let active = true;
    void desktopApi()
      .signingConfig(repoPath)
      .then((value: Config) => {
        if (!active) return;
        setConfig(value);
        setScope(value.scope === 'global' ? 'global' : 'local');
      })
      .catch((e: unknown) => active && setError(clean(e)));
    return () => {
      active = false;
    };
  }, [repoPath]);

  if (!config)
    return error ? <p className="text-sm text-danger">{error}</p> : <Loader2 size={18} className="animate-spin" />;
  const update = (patch: Partial<Config>) => {
    setConfig({ ...config, ...patch });
    setMessage('');
  };
  const save = async () => {
    setSaving(true);
    setError('');
    try {
      await desktopApi().setSigningConfig(
        repoPath,
        { format: config.format, key: config.key, commits: config.commits, tags: config.tags },
        scope,
      );
      setMessage(scope === 'local' ? `Saved for ${repoName}.` : 'Saved for all repositories.');
    } catch (e) {
      setError(clean(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="max-w-[850px] space-y-5">
      <p className="flex items-start gap-2 text-sm text-sub">
        <ShieldCheck size={16} className="mt-0.5 shrink-0 text-success" aria-hidden />
        Git signs each commit (and tag) itself with these settings, also outside this app. Signing needs GPG or an SSH
        key set up on this computer.
      </p>
      <div className="grid grid-cols-1 gap-x-8 gap-y-4 sm:grid-cols-[200px_1fr]">
        <span className="text-sm font-medium sm:pt-2">Sign</span>
        <div className="space-y-2">
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={config.commits} onChange={(e) => update({ commits: e.target.checked })} />
            Sign commits (commit.gpgsign)
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={config.tags} onChange={(e) => update({ tags: e.target.checked })} />
            Sign tags (tag.gpgsign)
          </label>
        </div>
        <label htmlFor="sign-format" className="text-sm font-medium sm:pt-2">
          Format
        </label>
        <select
          id="sign-format"
          value={config.format}
          onChange={(e) => update({ format: e.target.value as Format })}
          className={field}
        >
          <option value="openpgp">GPG (OpenPGP)</option>
          <option value="ssh">SSH key</option>
          <option value="x509">X.509 certificate</option>
        </select>
        <label htmlFor="sign-key" className="text-sm font-medium sm:pt-2">
          Signing key
        </label>
        <div>
          <input
            id="sign-key"
            value={config.key}
            onChange={(e) => update({ key: e.target.value })}
            placeholder={config.format === 'ssh' ? '~/.ssh/id_ed25519.pub' : 'Key ID'}
            className={field}
          />
          <p className="mt-1.5 max-w-[560px] text-xs text-sub">{KEY_HINT[config.format]}</p>
        </div>
        <span className="text-sm font-medium sm:pt-2">Apply to</span>
        <div className="inline-flex w-fit gap-1 rounded-md border border-surface p-1">
          {(
            [
              ['local', `This repository (${repoName})`],
              ['global', 'All repositories'],
            ] as const
          ).map(([id, label]) => (
            <button
              key={id}
              type="button"
              aria-pressed={scope === id}
              onClick={() => setScope(id)}
              className={`min-h-9 rounded px-3 text-sm ${scope === id ? 'bg-accent/15 font-semibold text-accent' : 'text-sub hover:bg-surface/50'}`}
            >
              {label}
            </button>
          ))}
        </div>
      </div>
      <div className="flex items-center gap-3">
        <button onClick={() => void save()} disabled={saving} className="btn-primary flex items-center gap-2 px-4 py-2">
          {saving && <Loader2 size={15} className="animate-spin" aria-hidden />} Save signing settings
        </button>
        {message && <span className="text-sm text-success">{message}</span>}
        {error && <span className="text-sm text-danger">{error}</span>}
      </div>
    </div>
  );
}
