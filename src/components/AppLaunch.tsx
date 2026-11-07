import { useEffect, useState } from 'react';
import type { AppUpdateCheck } from '../shared/updates';
import { useRepo } from '../store/repoStore';
import { version } from '../../package.json';
import { LaunchScreen } from './LaunchScreen';
import { UpdateNotice } from './UpdateNotice';
import { ReleasePicker } from './ReleasePicker';
import { useSettings } from '../store/settingsStore';

export function AppLaunch({ children }: { children: React.ReactNode }) {
  const [result, setResult] = useState<AppUpdateCheck | null>(null);
  const [elapsed, setElapsed] = useState(false);
  const [accepted, setAccepted] = useState(false);
  const [fading, setFading] = useState(false);
  const [finished, setFinished] = useState(false);
  const [showVersions, setShowVersions] = useState(false);
  const loading = useRepo((state) => state.loading);
  useEffect(() => {
    let active = true;
    const delay = 2500;
    const timer = setTimeout(() => {
      if (active) setElapsed(true);
    }, delay);
    const updates = (window as any).gitApi?.updates;
    const check: Promise<AppUpdateCheck> = !useSettings.getState().autoCheckUpdates
      ? Promise.resolve({ kind: 'current', currentVersion: version })
      : updates?.startup
        ? updates.startup()
        : Promise.resolve({ kind: 'development', currentVersion: version });
    check
      .then((value) => {
        if (active) setResult(value);
      })
      .catch((error) => {
        if (active) setResult({ kind: 'error', currentVersion: version, message: String(error?.message ?? error) });
      });
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, []);
  const ready =
    elapsed &&
    !loading &&
    !showVersions &&
    result &&
    (accepted || result.kind === 'current' || result.kind === 'development');
  useEffect(() => {
    if (!ready) return;
    setFading(true);
  }, [ready]);
  useEffect(() => {
    if (!fading) return;
    const timer = setTimeout(() => setFinished(true), matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 300);
    return () => clearTimeout(timer);
  }, [fading]);
  const retry = async () => {
    setResult(null);
    try {
      setResult(await (window as any).gitApi.updates.check());
    } catch (error) {
      setResult({ kind: 'error', currentVersion: version, message: String((error as Error)?.message ?? error) });
    }
  };
  return (
    <>
      <div style={{ height: '100%', visibility: finished ? 'visible' : 'hidden' }} aria-hidden={!finished}>
        {children}
      </div>
      {!finished && (
        <LaunchScreen
          fading={fading}
          status={
            !result
              ? 'Checking for updates...'
              : loading
                ? 'Opening workspace...'
                : result.kind === 'error'
                  ? 'Could not check for updates'
                  : 'Opening GITVerse...'
          }
        >
          {elapsed && result?.kind === 'error' && !accepted && (
            <>
              <p role="alert" className="w-full text-xs text-[#f9c5ce]">
                {result.message}
              </p>
              <button onClick={() => void retry()}>Retry</button>
              <button onClick={() => setAccepted(true)}>Continue</button>
            </>
          )}
          {!fading && <button onClick={() => setShowVersions(true)}>Download another version</button>}
        </LaunchScreen>
      )}
      {showVersions && (
        <ReleasePicker currentVersion={result?.currentVersion ?? version} onClose={() => setShowVersions(false)} />
      )}
      {elapsed && !loading && !showVersions && result?.kind === 'optional' && !accepted && (
        <UpdateNotice update={result} onLater={() => setAccepted(true)} />
      )}
    </>
  );
}
