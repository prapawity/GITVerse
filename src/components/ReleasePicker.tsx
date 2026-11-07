import { useEffect, useRef, useState } from 'react';
import type { ReleaseUpdate } from '../shared/updates';

export function ReleasePicker({ currentVersion, onClose }: { currentVersion: string; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [releases, setReleases] = useState<ReleaseUpdate[] | null>(null);
  const [selected, setSelected] = useState('');
  const [error, setError] = useState('');
  const [opening, setOpening] = useState(false);
  const [retry, setRetry] = useState(0);

  useEffect(() => {
    const element = dialog.current!;
    element.showModal();
    return () => element.close();
  }, []);
  useEffect(() => {
    let active = true;
    setReleases(null);
    setError('');
    Promise.resolve()
      .then(() => (window as any).gitApi.updates.list())
      .then((items: ReleaseUpdate[]) => {
        if (active) {
          setReleases(items);
          setSelected(items[0]?.url ?? '');
        }
      })
      .catch((reason) => {
        if (active) setError(String(reason?.message ?? reason));
      });
    return () => {
      active = false;
    };
  }, [retry]);

  return (
    <dialog
      ref={dialog}
      aria-labelledby="release-picker-title"
      onCancel={(event) => {
        event.preventDefault();
        if (!opening) onClose();
      }}
      className="m-auto w-[440px] max-w-[calc(100vw-32px)] rounded-lg border border-surface bg-mantle p-5 text-text shadow-2xl backdrop:bg-black/65"
    >
      <h2 id="release-picker-title" className="text-lg font-semibold">
        Download a version
      </h2>
      <p className="mt-3 text-sm text-sub">
        Current version: {currentVersion}. Select a stable release to open its downloads. Quit GITVerse before
        installing.
      </p>
      {releases && releases.length > 0 && (
        <label className="mt-4 block text-sm">
          Version
          <select
            value={selected}
            onChange={(event) => setSelected(event.target.value)}
            className="mt-2 w-full rounded-md border border-surface bg-crust px-3 py-2"
          >
            {releases.map((release) => (
              <option key={release.url} value={release.url}>
                {release.version}
                {release.version === currentVersion ? ' (current)' : ''}
              </option>
            ))}
          </select>
        </label>
      )}
      {!releases && !error && (
        <p role="status" className="mt-4 text-sm text-sub">
          Loading versions…
        </p>
      )}
      {releases?.length === 0 && <p className="mt-4 text-sm text-sub">No stable releases found.</p>}
      {error && (
        <p role="alert" className="mt-4 break-words text-sm text-[#f38ba8]">
          {error}
        </p>
      )}
      <div className="mt-5 flex flex-wrap justify-end gap-2">
        <button
          disabled={opening}
          onClick={async () => {
            try {
              await (window as any).gitApi.updates.openReleaseList();
            } catch (reason) {
              setError(String((reason as Error)?.message ?? reason));
            }
          }}
          className="rounded-md border border-surface px-4 py-2 text-sm disabled:opacity-40"
        >
          View all releases
        </button>
        {error && (
          <button
            onClick={() => setRetry((value) => value + 1)}
            className="rounded-md border border-surface px-4 py-2 text-sm"
          >
            Retry
          </button>
        )}
        <button
          disabled={opening}
          onClick={onClose}
          className="rounded-md border border-surface px-4 py-2 text-sm disabled:opacity-40"
        >
          Close
        </button>
        <button
          disabled={!selected || opening}
          onClick={async () => {
            setOpening(true);
            setError('');
            try {
              await (window as any).gitApi.updates.openDownloads(selected);
              onClose();
            } catch (reason) {
              setError(String((reason as Error)?.message ?? reason));
            } finally {
              setOpening(false);
            }
          }}
          className="rounded-md bg-[#4cc2ff] px-4 py-2 text-sm font-semibold text-crust disabled:opacity-40"
        >
          {opening ? 'Opening…' : 'Open downloads'}
        </button>
      </div>
    </dialog>
  );
}
