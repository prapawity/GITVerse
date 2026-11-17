import { useEffect, useRef, useState } from 'react';
import { Download, Loader2 } from 'lucide-react';
import type { AppUpdateCheck } from '../shared/updates';
import { ReleasePicker } from './ReleasePicker';
import { desktopApi } from '../platform/api';
import { runUpdate } from '../lib/runUpdate';

export function UpdateNotice({
  update,
  onLater,
}: {
  update: Extract<AppUpdateCheck, { kind: 'optional' }>;
  onLater: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const later = useRef(onLater);
  later.current = onLater;
  const [opening, setOpening] = useState(false);
  const [showVersions, setShowVersions] = useState(false);
  const [error, setError] = useState('');
  const [download, setDownload] = useState<{ state: string; percent?: number } | null>(null);
  const [manualInstall, setManualInstall] = useState<boolean | null>(null);
  useEffect(() => desktopApi().updates.onStatus(setDownload), []);
  useEffect(() => {
    let active = true;
    desktopApi()
      .updates.environment()
      .then((environment: { manualInstall?: boolean }) => {
        if (active) setManualInstall(!!environment.manualInstall);
      })
      .catch(() => {
        if (active) setError('Could not determine how to install updates. Please try again later.');
      });
    return () => {
      active = false;
    };
  }, []);
  useEffect(() => {
    const element = dialog.current!;
    element.showModal();
    element.querySelector<HTMLButtonElement>('[data-later]')?.focus();
    return () => element.close();
  }, []);
  return (
    <>
      <dialog
        ref={dialog}
        aria-labelledby="update-notice-title"
        onCancel={(event) => {
          event.preventDefault();
          if (!opening) later.current();
        }}
        className="m-auto w-[440px] max-w-[calc(100vw-32px)] rounded-lg border border-surface bg-mantle p-5 text-text shadow-2xl backdrop:bg-black/65"
      >
        <h2 id="update-notice-title" className="text-lg font-semibold">
          Update available
        </h2>
        <p className="mt-3 text-sm text-sub">
          GITVerse {update.version} is available. Current version: {update.currentVersion}.
        </p>
        <p className="mt-2 text-sm text-sub">
          {manualInstall
            ? 'Download the installer, then quit GITVerse and drag the new app to Applications.'
            : 'Download and install the update here. GITVerse will restart when it is ready.'}
        </p>
        {download?.state === 'downloading' && (
          <p role="status" className="mt-3 text-sm text-sub">
            Downloading update… {Math.round(download.percent ?? 0)}%
          </p>
        )}
        {download?.state === 'downloaded' && (
          <p role="status" className="mt-3 text-sm text-sub">
            Update downloaded and ready to install.
          </p>
        )}
        {error && (
          <p role="alert" className="mt-3 break-words text-sm text-danger">
            {error}
          </p>
        )}
        <div className="mt-5 flex justify-end gap-2">
          <button
            disabled={opening || download?.state === 'downloading'}
            onClick={() => setShowVersions(true)}
            className="btn-secondary px-4 py-2"
          >
            Other versions
          </button>
          <button
            data-later
            disabled={opening || download?.state === 'downloading'}
            onClick={onLater}
            className="btn-secondary px-4 py-2"
          >
            Later
          </button>
          <button
            disabled={opening || download?.state === 'downloading' || manualInstall === null}
            onClick={async () => {
              if (manualInstall === null) return;
              setOpening(true);
              setError('');
              try {
                await runUpdate(
                  download?.state === 'downloaded',
                  manualInstall,
                  () => desktopApi().updates.download(update.version),
                  () => desktopApi().updates.install(),
                );
              } catch (reason) {
                setDownload(null);
                setError(String((reason as Error)?.message ?? reason));
              } finally {
                setOpening(false);
              }
            }}
            className="btn-primary px-4 py-2"
          >
            {opening ? <Loader2 size={16} className="animate-spin" /> : <Download size={16} />}{' '}
            {download?.state === 'downloaded'
              ? manualInstall
                ? 'Open installer'
                : 'Restart and Install'
              : download?.state === 'downloading'
                ? 'Downloading…'
                : opening
                  ? 'Starting…'
                  : 'Update'}
          </button>
        </div>
      </dialog>
      {showVersions && <ReleasePicker currentVersion={update.currentVersion} onClose={() => setShowVersions(false)} />}
    </>
  );
}
