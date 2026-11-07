import { useEffect, useState } from 'react';
import { AlertTriangle, Loader2, Upload } from 'lucide-react';
import { useRepo } from '../store/repoStore';
import { useSettings } from '../store/settingsStore';

const api = () => (window as any).gitApi;
const field = 'w-full rounded-md border border-surface bg-crust px-3 py-2 outline-none focus:border-[#4cc2ff]';
type Info = { branch: string; remotes: string[]; remote: string; target: string; remoteHash: string | null };

export function PushDialog({ repo, onClose }: { repo: string; onClose: () => void }) {
  const [info, setInfo] = useState<Info | null>(null);
  const [error, setError] = useState('');
  const [pushing, setPushing] = useState(false);
  const [authNeeded, setAuthNeeded] = useState(false);
  const [login, setLogin] = useState('');
  const [password, setPassword] = useState('');
  const [forcePush, setForcePush] = useState(false);

  useEffect(() => {
    let active = true;
    api()
      .pushInfo(repo)
      .then((value: Info) => {
        if (active) setInfo(value);
      })
      .catch((e: Error) => {
        if (active) setError(e.message);
      });
    return () => {
      active = false;
    };
  }, [repo]);
  useEffect(() => {
    const escape = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !pushing) onClose();
    };
    window.addEventListener('keydown', escape);
    return () => window.removeEventListener('keydown', escape);
  }, [onClose, pushing]);

  const remote = info?.remote ?? '';
  const target = info?.target ?? '';
  const canPush = !!info?.branch && !!target && info.remotes.includes(remote);

  const push = async () => {
    if (!canPush || !info || pushing || (forcePush && !info.remoteHash) || (authNeeded && (!login.trim() || !password)))
      return;
    const settings = useSettings.getState();
    const profile = settings.pushProfiles?.[repo]?.find((p) => p.id === settings.selectedPushProfiles?.[repo]);
    setPushing(true);
    setError('');
    try {
      await api().pushProfiles.push(
        repo,
        remote,
        info.branch,
        target.trim(),
        profile,
        authNeeded ? { username: login.trim(), password } : undefined,
        forcePush ? { forceWithLease: true, expectedRemoteHash: info.remoteHash } : undefined,
      );
      await useRepo.getState().syncAfterPush(repo);
      setPassword('');
      useRepo
        .getState()
        .notify('success', `${forcePush ? 'Force pushed' : 'Pushed'} ${info.branch} to ${remote}/${target.trim()}`);
      onClose();
    } catch (e: any) {
      const message = String(e?.message ?? e).replace(/^Error invoking remote method '[^']*': (Error: )?/, '');
      const nonFastForward = /non-fast-forward|\(fetch first\)/i.test(message);
      setError(
        nonFastForward
          ? 'The remote history differs from this branch. Pull to integrate remote commits, or force push if you intentionally rewrote history.'
          : /stale info/i.test(message)
            ? 'The remote branch changed. Nothing was overwritten. Fetch and review the remote commits, then reopen this dialog.'
            : message,
      );
      useRepo.getState().recordActivity('error', 'Push failed', message, repo);
      if (
        /authentication failed|http basic: access denied|could not read (username|password)|invalid (username|password|credentials)|\b401\b/i.test(
          message,
        )
      )
        setAuthNeeded(true);
      setPassword('');
    } finally {
      setPushing(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-[90] flex items-center justify-center bg-black/60 p-4"
      onMouseDown={() => {
        if (!pushing) onClose();
      }}
    >
      <section
        role="dialog"
        aria-modal="true"
        aria-labelledby="push-title"
        onMouseDown={(e) => e.stopPropagation()}
        className="max-h-[90vh] w-full max-w-[560px] overflow-auto rounded-lg border border-surface bg-mantle p-5 shadow-2xl"
      >
        <h2 id="push-title" className="text-lg font-semibold">
          Push branch
        </h2>
        {error && (
          <p role="alert" className="mt-3 whitespace-pre-wrap text-sm text-[#f38ba8]">
            {error}
          </p>
        )}
        {!info ? (
          <p className="mt-4 text-sub">{error ? 'Could not load repository details.' : 'Loading remotes…'}</p>
        ) : (
          <div className="mt-4 space-y-4">
            {!info.branch && <p className="text-sm text-[#f9e2af]">Check out a branch before pushing.</p>}
            {canPush && (
              <p className="break-all text-sm leading-relaxed">
                Push <span className="font-semibold text-text">{info.branch}</span> to{' '}
                <span className="font-semibold text-[#4cc2ff]">
                  {remote}/{target}
                </span>
                ?
              </p>
            )}
            {!info.remotes.length && (
              <p className="text-sm text-[#f9e2af]">This repository has no remotes. Add one in Git first.</p>
            )}
            {info.remotes.length > 0 && remote && !info.remotes.includes(remote) && (
              <p className="text-sm text-[#f9e2af]">
                The configured upstream remote “{remote}” is unavailable. Update the branch's upstream in Git first.
              </p>
            )}
            {canPush && (
              <div className={`space-y-2 border-t pt-3 ${forcePush ? 'border-[#f9e2af]/40' : 'border-surface'}`}>
                <label className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={forcePush}
                    disabled={pushing || !info.remoteHash}
                    onChange={(e) => setForcePush(e.target.checked)}
                    className="accent-[#f38ba8]"
                  />
                  Force push (--force-with-lease)
                </label>
                {forcePush && (
                  <p className="flex items-start gap-2 text-sm text-[#f9e2af]">
                    <AlertTriangle size={16} className="mt-0.5 shrink-0" aria-hidden />
                    Replaces remote history and may remove remote-only commits. The push is blocked if the remote
                    changed since this dialog opened.
                  </p>
                )}
                {!info.remoteHash && (
                  <p className="text-xs text-sub">
                    Fetch the remote branch and reopen this dialog to enable force push.
                  </p>
                )}
              </div>
            )}
            {authNeeded && (
              <div className="space-y-3 rounded-lg border border-[#f9e2af]/40 bg-[#f9e2af]/5 p-3">
                <p className="text-sm text-[#f9e2af]">
                  Authentication failed. Enter HTTPS credentials to retry. Your server may require an access token
                  instead of a password.
                </p>
                <label className="block text-sm">
                  Username
                  <input
                    autoComplete="username"
                    value={login}
                    disabled={pushing}
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
                    disabled={pushing}
                    onChange={(e) => setPassword(e.target.value)}
                    className={`${field} mt-1`}
                  />
                </label>
                <p className="text-xs text-sub">Used for this retry and not saved.</p>
              </div>
            )}
          </div>
        )}
        <div className="mt-5 flex justify-end gap-2">
          <button
            onClick={onClose}
            disabled={pushing}
            className="rounded-md border border-surface px-3 py-2 hover:bg-surface/60 disabled:opacity-40"
          >
            Cancel
          </button>
          <button
            onClick={push}
            disabled={
              !canPush || pushing || (forcePush && !info?.remoteHash) || (authNeeded && (!login.trim() || !password))
            }
            className={`flex items-center gap-2 rounded-md px-4 py-2 font-medium text-crust disabled:opacity-40 ${forcePush ? 'bg-[#f38ba8]' : 'bg-[#4cc2ff]'}`}
          >
            {pushing ? <Loader2 size={16} className="animate-spin" aria-hidden /> : <Upload size={16} aria-hidden />}
            {pushing ? 'Pushing…' : forcePush ? 'Confirm force push' : authNeeded ? 'Retry push' : 'Push'}
          </button>
        </div>
      </section>
    </div>
  );
}
