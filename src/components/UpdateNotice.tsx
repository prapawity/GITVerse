import { useEffect, useRef, useState } from 'react';
import { Download, Loader2 } from 'lucide-react';
import type { AppUpdateCheck } from '../shared/updates';

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
  const [error, setError] = useState('');
  useEffect(() => {
    const element = dialog.current!;
    element.showModal();
    element.querySelector<HTMLButtonElement>('[data-later]')?.focus();
    return () => element.close();
  }, []);
  return (
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
        Download the installer for your platform, then quit GITVerse before installing.
      </p>
      {error && (
        <p role="alert" className="mt-3 break-words text-sm text-[#f38ba8]">
          {error}
        </p>
      )}
      <div className="mt-5 flex justify-end gap-2">
        <button
          data-later
          disabled={opening}
          onClick={onLater}
          className="rounded-md border border-surface px-4 py-2 text-sm disabled:opacity-40"
        >
          Later
        </button>
        <button
          disabled={opening}
          onClick={async () => {
            setOpening(true);
            setError('');
            try {
              await (window as any).gitApi.updates.openDownloads(update.url);
              onLater();
            } catch (reason) {
              setError(String((reason as Error)?.message ?? reason));
            } finally {
              setOpening(false);
            }
          }}
          className="flex items-center gap-2 rounded-md bg-[#4cc2ff] px-4 py-2 text-sm font-semibold text-crust disabled:opacity-40"
        >
          {opening ? <Loader2 size={16} className="animate-spin" /> : <Download size={16} />} Update
        </button>
      </div>
    </dialog>
  );
}
