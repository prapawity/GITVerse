import { useEffect, useState } from 'react';
import { FileText, Loader2, RefreshCw } from 'lucide-react';
import { version } from '../../package.json';
import type { AppUpdateCheck } from '../shared/updates';
import { UpdateNotice } from './UpdateNotice';
import { ReleasePicker } from './ReleasePicker';

export function ApplicationAbout() {
  const [environment, setEnvironment] = useState<{ enabled: boolean; currentVersion: string } | null>(null);
  const [checking, setChecking] = useState(false);
  const [update, setUpdate] = useState<Extract<AppUpdateCheck, { kind: 'optional' }> | null>(null);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [noticesError, setNoticesError] = useState('');
  const [showVersions, setShowVersions] = useState(false);
  const [openingNotice, setOpeningNotice] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    const updates = (window as any).gitApi?.updates;
    const request = updates?.environment
      ? updates.environment()
      : Promise.resolve({ enabled: false, currentVersion: version });
    request
      .then((value: { enabled: boolean; currentVersion: string }) => {
        if (active) setEnvironment(value);
      })
      .catch((reason: Error) => {
        if (active) setError(reason.message);
      });
    return () => {
      active = false;
    };
  }, []);
  const check = async () => {
    if (!environment?.enabled || checking) return;
    setChecking(true);
    setMessage('');
    setError('');
    try {
      const result: AppUpdateCheck = await (window as any).gitApi.updates.check();
      if (result.kind === 'optional') setUpdate(result);
      else if (result.kind === 'current') setMessage('You are on the latest version.');
      else if (result.kind === 'error') setError(result.message);
      else setMessage('Development build');
    } catch (reason) {
      setError(String((reason as Error)?.message ?? reason));
    } finally {
      setChecking(false);
    }
  };
  const openNotice = async (kind: 'third-party' | 'electron' | 'chromium') => {
    if (openingNotice) return;
    setOpeningNotice(kind);
    setNoticesError('');
    try {
      const api = (window as any).gitApi;
      const open =
        kind === 'third-party'
          ? typeof api?.openThirdPartyNotices === 'function'
            ? () => api.openThirdPartyNotices()
            : undefined
          : typeof api?.openRuntimeNotice === 'function'
            ? () => api.openRuntimeNotice(kind)
            : undefined;
      if (typeof open !== 'function') throw new Error('Third-party notices are unavailable in this build.');
      await open();
    } catch (reason) {
      setNoticesError(String((reason as Error)?.message ?? reason));
    } finally {
      setOpeningNotice(null);
    }
  };
  return (
    <section className="max-w-[720px]" aria-label="Application and About">
      <h1 className="text-[28px] font-semibold">About GITVerse</h1>
      <p className="mt-1 text-sm text-sub">Version information and application updates.</p>
      <div className="mt-7 flex items-center gap-4 rounded-xl border border-surface bg-mantle/60 p-5">
        <img src={new URL('../assets/gitverse-mark.svg', import.meta.url).href} width={48} height={48} alt="" />
        <div>
          <h2 className="text-lg font-semibold">GITVerse</h2>
          <p className="mt-1 text-sm text-sub">
            Version {environment?.enabled ? environment.currentVersion : version}
            {environment && !environment.enabled ? ' (development build)' : ''}
          </p>
        </div>
      </div>
      <div className="py-7">
        <h2 className="text-lg font-semibold">Updates</h2>
        <p className="mb-4 mt-1 text-sm text-sub">Check for the latest stable release or choose another version.</p>
        <div className="flex flex-wrap gap-3">
          <button
            onClick={() => void check()}
            disabled={!environment?.enabled || checking}
            className="flex min-h-[40px] items-center gap-2 rounded-md border border-[#4cc2ff]/50 px-4 py-2 text-sm text-[#4cc2ff] hover:bg-[#4cc2ff]/10 disabled:opacity-40"
          >
            {checking ? (
              <Loader2 size={16} className="animate-spin" aria-hidden />
            ) : (
              <RefreshCw size={16} aria-hidden />
            )}
            {checking ? 'Checking...' : 'Check for Update'}
          </button>
          <button
            onClick={() => setShowVersions(true)}
            className="min-h-[40px] rounded-md border border-surface px-4 py-2 text-sm hover:bg-surface/60"
          >
            Download another version
          </button>
        </div>
        {environment && !environment.enabled && (
          <p className="mt-3 text-sm text-sub">Update checks are unavailable in development builds.</p>
        )}
        {message && (
          <p role="status" className="mt-3 text-sm text-sub">
            {message}
          </p>
        )}
        {error && (
          <p role="alert" className="mt-3 break-words text-sm text-[#f38ba8]">
            {error}
          </p>
        )}
      </div>
      <div className="border-t border-surface py-6">
        <h2 className="text-lg font-semibold">Open source licenses</h2>
        <p className="mb-4 mt-1 text-sm text-sub">
          GITVerse is licensed under MIT. Third-party, Electron, and Chromium notices are included with this
          application.
        </p>
        <div className="flex flex-wrap gap-2">
          {(
            [
              ['third-party', 'View third-party notices'],
              ['electron', 'View Electron license'],
              ['chromium', 'View Chromium notices'],
            ] as const
          ).map(([kind, label]) => (
            <button
              key={kind}
              type="button"
              onClick={() => void openNotice(kind)}
              disabled={openingNotice !== null}
              className="flex min-h-[40px] items-center gap-2 rounded-md border border-surface px-4 py-2 text-sm hover:bg-surface/60 disabled:opacity-50"
            >
              <FileText size={16} aria-hidden />
              {openingNotice === kind ? 'Opening…' : label}
            </button>
          ))}
        </div>
        {noticesError && (
          <p role="alert" className="mt-3 break-words text-sm text-[#f38ba8]">
            {noticesError}
          </p>
        )}
      </div>
      {update && <UpdateNotice update={update} onLater={() => setUpdate(null)} />}
      {showVersions && (
        <ReleasePicker currentVersion={environment?.currentVersion ?? version} onClose={() => setShowVersions(false)} />
      )}
    </section>
  );
}
