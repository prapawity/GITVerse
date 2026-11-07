import { useEffect, useMemo, useState } from 'react';
import { highlight } from '../lib/diff';
import { Spinner } from './Loading';

export type MediaKind = 'image' | 'video' | 'audio';

const TYPES: Record<string, [MediaKind, string]> = {
  png: ['image', 'image/png'],
  jpg: ['image', 'image/jpeg'],
  jpeg: ['image', 'image/jpeg'],
  gif: ['image', 'image/gif'],
  webp: ['image', 'image/webp'],
  avif: ['image', 'image/avif'],
  bmp: ['image', 'image/bmp'],
  ico: ['image', 'image/x-icon'],
  svg: ['image', 'image/svg+xml'],
  mp4: ['video', 'video/mp4'],
  m4v: ['video', 'video/mp4'],
  webm: ['video', 'video/webm'],
  mov: ['video', 'video/quicktime'],
  ogv: ['video', 'video/ogg'],
  mp3: ['audio', 'audio/mpeg'],
  wav: ['audio', 'audio/wav'],
  ogg: ['audio', 'audio/ogg'],
  m4a: ['audio', 'audio/mp4'],
};

const extension = (path: string) => /\.([a-z0-9]+)$/i.exec(path)?.[1].toLowerCase() ?? '';
export const mediaType = (path: string) => TYPES[extension(path)];
export const isJsonFile = (path: string) => extension(path) === 'json';
export const isSvgFile = (path: string) => extension(path) === 'svg';

function base64ToBlobUrl(base64: string, type: string) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return { url: URL.createObjectURL(new Blob([bytes], { type })), size: bytes.length };
}

const size = (bytes: number) =>
  bytes < 1024
    ? `${bytes} B`
    : bytes < 1048576
      ? `${(bytes / 1024).toFixed(1)} KB`
      : `${(bytes / 1048576).toFixed(1)} MB`;

type Loaded = { url: string; size: number } | { error: string } | null;

function useBlob(load: (() => Promise<string>) | null, type: string, deps: unknown[]): Loaded {
  const [state, setState] = useState<Loaded>(null);
  useEffect(() => {
    setState(null);
    if (!load) return;
    let on = true;
    let created = '';
    load()
      .then((base64) => {
        if (!on) return;
        const blob = base64ToBlobUrl(base64, type);
        created = blob.url;
        setState(blob);
      })
      .catch(
        (e: Error) =>
          on && setState({ error: String(e.message).replace(/^Error invoking remote method '[^']*': (Error: )?/, '') }),
      );
    return () => {
      on = false;
      if (created) URL.revokeObjectURL(created);
    };
  }, deps); // eslint-disable-line react-hooks/exhaustive-deps
  return state;
}

function Media({ kind, src, name }: { kind: MediaKind; src: string; name: string }) {
  const [dims, setDims] = useState('');
  if (kind === 'video')
    return (
      <video
        src={src}
        controls
        loop
        muted
        className="max-h-[70vh] max-w-full rounded border border-surface bg-black"
        onLoadedMetadata={(e) => setDims(`${e.currentTarget.videoWidth}×${e.currentTarget.videoHeight}`)}
        aria-label={name}
      />
    );
  if (kind === 'audio') return <audio src={src} controls aria-label={name} />;
  return (
    <div className="flex flex-col items-center gap-1">
      <img
        src={src}
        alt={name}
        onLoad={(e) => setDims(`${e.currentTarget.naturalWidth}×${e.currentTarget.naturalHeight}`)}
        className="max-h-[70vh] max-w-full rounded border border-surface object-contain"
        style={{
          backgroundImage: 'conic-gradient(#2a303c 25%, #20252e 0 50%, #2a303c 0 75%, #20252e 0)',
          backgroundSize: '16px 16px',
        }}
      />
      <span className="font-sans text-[12px] text-sub">{dims}</span>
    </div>
  );
}

function Pane({
  label,
  kind,
  type,
  load,
  name,
  deps,
  empty,
}: {
  label?: string;
  kind: MediaKind;
  type: string;
  load: (() => Promise<string>) | null;
  name: string;
  deps: unknown[];
  empty?: string;
}) {
  const blob = useBlob(load, type, deps);
  return (
    <figure className="flex min-w-0 flex-1 flex-col items-center gap-2 font-sans">
      {label && <figcaption className="text-[12px] uppercase tracking-wide text-sub">{label}</figcaption>}
      {!load && <div className="text-sub">{empty ?? 'Not available'}</div>}
      {load && !blob && (
        <div role="status" className="flex items-center gap-2 text-sub">
          <Spinner size={14} /> Loading preview…
        </div>
      )}
      {blob && 'error' in blob && (
        <div role="alert" className="whitespace-pre-wrap text-[#f38ba8]">
          {blob.error}
        </div>
      )}
      {blob && 'url' in blob && (
        <>
          <Media kind={kind} src={blob.url} name={name} />
          <span className="text-[12px] text-sub">{size(blob.size)}</span>
        </>
      )}
    </figure>
  );
}

/** Previews an image, GIF, video or audio file. When a previous version is supplied it is shown beside the new one. */
export function MediaPreview({
  path,
  loadAfter,
  loadBefore,
  deps,
}: {
  path: string;
  loadAfter: (() => Promise<string>) | null;
  loadBefore?: (() => Promise<string>) | null;
  deps: unknown[];
}) {
  const [kind, type] = mediaType(path)!;
  const name = path.split('/').pop() ?? path;
  return (
    <div className="flex flex-wrap items-start justify-center gap-8 p-6">
      {loadBefore && (
        <Pane
          label="Before"
          kind={kind}
          type={type}
          load={loadBefore}
          name={`${name} (before)`}
          deps={[...deps, 'b']}
        />
      )}
      <Pane
        label={loadBefore ? 'After' : undefined}
        kind={kind}
        type={type}
        load={loadAfter}
        name={name}
        deps={[...deps, 'a']}
        empty="This file no longer exists."
      />
    </div>
  );
}

/** Pretty-printed, syntax-highlighted JSON. Invalid JSON is reported and shown unchanged. */
export function JsonPreview({ text }: { text: string }) {
  const result = useMemo(() => {
    try {
      return { text: JSON.stringify(JSON.parse(text), null, 2) };
    } catch (e) {
      return { text, error: (e as Error).message };
    }
  }, [text]);
  const lines = result.text.split('\n');
  return (
    <div className="min-w-max py-2">
      {result.error && (
        <div role="alert" className="px-4 pb-2 font-sans text-[#f9e2af]">
          Not valid JSON ({result.error}). Showing the raw file.
        </div>
      )}
      {lines.map((line, k) => (
        <div key={k} className="grid grid-cols-[56px_1fr]">
          <span className="select-none pr-2 text-right text-[#6c7a89]">{k + 1}</span>
          <span className="whitespace-pre pl-3">
            {highlight(line).map((token, i) => (
              <span key={i} className={token.c}>
                {token.t}
              </span>
            ))}
            {!line && ' '}
          </span>
        </div>
      ))}
    </div>
  );
}
