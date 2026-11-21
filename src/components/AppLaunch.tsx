import { useEffect, useLayoutEffect, useState } from 'react';
import type { AppUpdateCheck } from '../shared/updates';
import { useRepo } from '../store/repoStore';
import { version } from '../../package.json';
import { LaunchScreen } from './LaunchScreen';
import { UpdateNotice } from './UpdateNotice';
import { ReleasePicker } from './ReleasePicker';
import { useSettings } from '../store/settingsStore';
import { useResolvedTheme } from '../lib/theme';
import { platformApi } from '../platform/api';
import { isVersionUnstable } from '../lib/crashLog';

export function AppLaunch({ children }: { children: React.ReactNode }) {
  const [result, setResult] = useState<AppUpdateCheck | null>(null);
  const [elapsed, setElapsed] = useState(false);
  const [accepted, setAccepted] = useState(false);
  const [fading, setFading] = useState(false);
  const [finished, setFinished] = useState(false);
  const [showVersions, setShowVersions] = useState(false);
  // only offer another version when this one has crashed or hung 5 or more times
  const [unstable] = useState(() => isVersionUnstable(version));
  const loading = useRepo((state) => state.loading);
  const theme = useResolvedTheme();
  // apply the saved theme before the first paint so the launch screen never flashes the default palette
  useLayoutEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);
  useEffect(() => {
    let active = true;
    const delay = 2500;
    const timer = setTimeout(() => {
      if (active) setElapsed(true);
    }, delay);
    const updates = platformApi()?.updates;
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
    // a failed update check (offline, GitHub unreachable) never blocks opening the app
    (accepted || result.kind === 'current' || result.kind === 'development' || result.kind === 'error');
  useEffect(() => {
    if (!ready) return;
    setFading(true);
  }, [ready]);
  useEffect(() => {
    if (!fading) return;
    const timer = setTimeout(() => setFinished(true), matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 300);
    return () => clearTimeout(timer);
  }, [fading]);
  // keep a quiet record of a failed update check instead of interrupting the launch
  useEffect(() => {
    if (result?.kind === 'error')
      useRepo.getState().recordActivity('warning', 'Could not check for updates', result.message);
  }, [result]);

  return (
    <>
      <div style={{ height: '100%', visibility: finished ? 'visible' : 'hidden' }} aria-hidden={!finished}>
        {children}
      </div>
      {!finished && (
        <LaunchScreen
          fading={fading}
          status={
            !result ? 'Checking for updates...' : loading ? 'Opening workspace...' : 'Opening GITVerse by PRAPAWITY...'
          }
        >
          {!fading && unstable && <button onClick={() => setShowVersions(true)}>Download another version</button>}
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
