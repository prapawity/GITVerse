import { useEffect, useRef, useState } from 'react';
import { Boxes, Code2, FileUp, HardDrive, Loader2, Package, Wrench } from 'lucide-react';
import { desktopApi } from '../platform/api';
import { useRepo } from '../store/repoStore';
import { askConfirm } from './Dialogs';
import { resetLfsCache } from '../lib/lfs';

type Lfs = { installed: boolean; used: boolean; patterns: string[]; files: string[] };
type Submodule = {
  path: string;
  hash: string;
  state: 'ok' | 'uninitialized' | 'modified' | 'conflict';
  describe?: string;
};
const STATE_LABEL: Record<Submodule['state'], string> = {
  ok: 'Up to date',
  uninitialized: 'Not initialised',
  modified: 'Different commit checked out',
  conflict: 'Conflict',
};
const clean = (e: unknown) =>
  String((e as Error)?.message ?? e).replace(/^Error invoking remote method '[^']*': (Error: )?/, '');
const heading = 'flex items-center gap-2 text-sm font-semibold';
const card = 'border-t border-surface px-4 py-4';

/** LFS, submodules, patches, "Open in…" and maintenance for the open repository (Workspace panel). */
export function RepoTools({ repoPath }: { repoPath: string }) {
  const exec = useRepo((s) => s.exec);
  const [lfs, setLfs] = useState<Lfs | null>(null);
  const [subs, setSubs] = useState<Submodule[] | null>(null);
  const [editors, setEditors] = useState<{ id: string; name: string }[]>([]);
  const [pattern, setPattern] = useState('');
  const [busy, setBusy] = useState('');
  const [note, setNote] = useState('');
  const [error, setError] = useState('');
  const [revision, setRevision] = useState(0);
  const fileInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let active = true;
    const api = desktopApi();
    void api
      .lfsStatus(repoPath)
      .then((v: Lfs) => active && setLfs(v))
      .catch(() => active && setLfs(null));
    void api
      .submodules(repoPath)
      .then((v: Submodule[]) => active && setSubs(v))
      .catch(() => active && setSubs([]));
    void api
      .editors()
      .then((v) => active && setEditors(v))
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [repoPath, revision]);

  const run = async (label: string, fn: () => Promise<unknown>) => {
    if (label === 'lfs') resetLfsCache(repoPath);
    setBusy(label);
    setError('');
    setNote('');
    try {
      await fn();
      setRevision((v) => v + 1);
    } catch (e) {
      setError(clean(e));
    } finally {
      setBusy('');
    }
  };

  const applyPatchFile = async (file: File) => {
    const text = await file.text();
    const mail = /^From [0-9a-f]{40} /m.test(text) && /^Subject: /m.test(text);
    const check = await desktopApi()
      .applyPatch(repoPath, text, 'check')
      .then(
        () => '',
        (e: unknown) => clean(e),
      );
    const ok = await askConfirm(
      `Apply ${file.name}?`,
      `${mail ? 'This is a patch with commits: they are added with their original author and message (git am).' : 'The changes are applied to your working files (git apply).'}${check ? `\n\nGit reports it may not apply cleanly; a 3-way merge will be tried:\n${check}` : ''}`,
      { label: mail ? 'Apply commits' : 'Apply changes' },
    );
    if (ok) await exec('applyPatch', text, mail ? 'am' : 'apply');
  };

  return (
    <>
      <section className={card} aria-labelledby="tools-open-in">
        <h3 id="tools-open-in" className={heading}>
          <Code2 size={15} aria-hidden /> Open in
        </h3>
        {editors.length ? (
          <div className="mt-2 flex flex-wrap gap-1.5">
            {editors.map((editor) => (
              <button
                key={editor.id}
                onClick={() => void run(editor.name, () => desktopApi().openIn(editor.id, repoPath))}
                className="btn-secondary px-2.5 py-1 text-xs"
              >
                {editor.name}
              </button>
            ))}
          </div>
        ) : (
          <p className="mt-2 text-xs text-sub">No supported editor (VS Code, Cursor, JetBrains, Xcode, Zed…) found.</p>
        )}
      </section>

      <section className={card} aria-labelledby="tools-lfs">
        <h3 id="tools-lfs" className={heading}>
          <HardDrive size={15} aria-hidden /> Git LFS
        </h3>
        {!lfs ? (
          <Loader2 size={14} className="mt-2 animate-spin" />
        ) : !lfs.installed ? (
          <p className="mt-2 text-xs text-sub">Git LFS is not installed on this computer (git-lfs.com).</p>
        ) : (
          <div className="mt-2 space-y-2 text-xs">
            <p className="text-sub">
              {lfs.used
                ? `${lfs.files.length} file${lfs.files.length === 1 ? '' : 's'} in LFS · tracking ${lfs.patterns.join(', ') || '—'}`
                : 'This repository does not use LFS yet.'}
            </p>
            <div className="flex flex-wrap gap-1.5">
              <button
                onClick={() => void run('lfs', () => exec('lfsAction', 'install'))}
                className="btn-secondary px-2.5 py-1"
              >
                Initialize LFS
              </button>
              <button
                onClick={() => void run('lfs', () => exec('lfsAction', 'pull'))}
                className="btn-secondary px-2.5 py-1"
              >
                Pull LFS files
              </button>
            </div>
            <form
              className="flex gap-1.5"
              onSubmit={(e) => {
                e.preventDefault();
                if (pattern.trim())
                  void run('lfs', async () => {
                    await exec('lfsAction', 'track', pattern.trim());
                    setPattern('');
                  });
              }}
            >
              <input
                value={pattern}
                onChange={(e) => setPattern(e.target.value)}
                placeholder="Track pattern, e.g. *.psd"
                aria-label="LFS pattern to track"
                className="min-w-0 flex-1 rounded-md border border-surface bg-crust px-2 py-1 outline-none focus:border-accent"
              />
              <button type="submit" disabled={!pattern.trim()} className="btn-secondary px-2.5">
                Track
              </button>
            </form>
            {lfs.patterns.length > 0 && (
              <div className="flex flex-wrap gap-1">
                {lfs.patterns.map((p) => (
                  <span key={p} className="flex items-center gap-1 rounded-full bg-surface/70 py-0.5 pl-2 pr-1">
                    {p}
                    <button
                      onClick={() => void run('lfs', () => exec('lfsAction', 'untrack', p))}
                      aria-label={`Stop tracking ${p} with LFS`}
                      className="rounded-full px-1 hover:bg-surface"
                    >
                      ×
                    </button>
                  </span>
                ))}
              </div>
            )}
          </div>
        )}
      </section>

      <section className={card} aria-labelledby="tools-submodules">
        <h3 id="tools-submodules" className={heading}>
          <Boxes size={15} aria-hidden /> Submodules <span className="font-normal text-sub">({subs?.length ?? 0})</span>
        </h3>
        {subs && subs.length > 0 ? (
          <div className="mt-2 space-y-1.5">
            {subs.map((sub) => (
              <div key={sub.path} className="flex items-center gap-2 text-xs">
                <Package size={13} className="shrink-0 text-sub" aria-hidden />
                <span className="min-w-0 flex-1 truncate" title={`${sub.path} @ ${sub.hash.slice(0, 7)}`}>
                  {sub.path}
                  <span className={`ml-1.5 ${sub.state === 'ok' ? 'text-sub' : 'text-warning'}`}>
                    {STATE_LABEL[sub.state]}
                  </span>
                </span>
                {sub.state !== 'ok' && (
                  <button
                    onClick={() => void run('sub', () => exec('submoduleUpdate', sub.path))}
                    className="btn-secondary shrink-0 px-2 py-0.5"
                  >
                    Update
                  </button>
                )}
              </div>
            ))}
            <button
              onClick={() => void run('sub', () => exec('submoduleUpdate', null))}
              className="btn-secondary mt-1 px-2.5 py-1 text-xs"
            >
              Update all submodules
            </button>
          </div>
        ) : (
          <p className="mt-2 text-xs text-sub">No submodules.</p>
        )}
      </section>

      <section className={card} aria-labelledby="tools-patch">
        <h3 id="tools-patch" className={heading}>
          <FileUp size={15} aria-hidden /> Patches
        </h3>
        <p className="mt-1 text-xs text-sub">
          Apply a .patch / .diff file. To create one, select commits in the graph and use Save as patch.
        </p>
        <input
          ref={fileInput}
          type="file"
          accept=".patch,.diff,.txt,text/x-patch,text/x-diff"
          className="hidden"
          onChange={(e) => {
            const file = e.target.files?.[0];
            e.target.value = '';
            if (file) void run('patch', () => applyPatchFile(file));
          }}
        />
        <button onClick={() => fileInput.current?.click()} className="btn-secondary mt-2 px-2.5 py-1 text-xs">
          Apply patch…
        </button>
      </section>

      <section className={card} aria-labelledby="tools-maintenance">
        <h3 id="tools-maintenance" className={heading}>
          <Wrench size={15} aria-hidden /> Maintenance
        </h3>
        <p className="mt-1 text-xs text-sub">
          Packs objects and rebuilds the commit-graph so large repositories stay fast.
        </p>
        <button
          disabled={!!busy}
          onClick={() =>
            void run('maintenance', async () => {
              const r: { beforeKiB: number; afterKiB: number } = await desktopApi().maintenance(repoPath);
              const mb = (k: number) => `${(k / 1024).toFixed(1)} MB`;
              setNote(`Repository size ${mb(r.beforeKiB)} → ${mb(r.afterKiB)}`);
              useRepo.getState().notify('success', 'Maintenance finished', `${mb(r.beforeKiB)} → ${mb(r.afterKiB)}`);
            })
          }
          className="btn-secondary mt-2 flex items-center gap-1.5 px-2.5 py-1 text-xs"
        >
          {busy === 'maintenance' && <Loader2 size={12} className="animate-spin" aria-hidden />}
          Run maintenance
        </button>
      </section>

      {(error || note) && (
        <p className={`px-4 pb-4 text-xs ${error ? 'text-danger' : 'text-success'}`} role={error ? 'alert' : 'status'}>
          {error || note}
        </p>
      )}
    </>
  );
}
