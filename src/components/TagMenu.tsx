import { createPortal } from 'react-dom';
import { useRepo } from '../store/repoStore';
import { useSettings } from '../store/settingsStore';
import { refKey } from '../lib/historyScope';
import { askConfirm } from './Dialogs';

/** Right-click menu for a tag in the sidebar: push, delete, hide / solo, copy. */
export function TagMenu({ tag, x, y, onClose }: { tag: string; x: number; y: number; onClose: () => void }) {
  const { repoPath, exec, toast, refs } = useRepo();
  const settings = useSettings();
  if (!repoPath) return null;
  const remote = refs.remote.some((r) => r.name.startsWith('origin/')) ? 'origin' : refs.remote[0]?.name.split('/')[0];
  const key = refKey('tag', tag);
  const hidden = (settings.graphHidden[repoPath] ?? []).includes(key);
  const solo = (settings.graphSolo[repoPath] ?? []).includes(key);
  const run = (fn: () => unknown) => () => {
    onClose();
    void fn();
  };
  const items: ({ label: string; run: () => void; danger?: boolean; disabled?: boolean } | '-')[] = [
    { label: `Push ${tag} to ${remote ?? 'remote'}`, disabled: !remote, run: run(() => exec('pushTag', remote, tag)) },
    {
      label: `Push all tags to ${remote ?? 'remote'}`,
      disabled: !remote,
      run: run(() => exec('pushTag', remote, null)),
    },
    '-',
    {
      label: hidden ? 'Show in graph' : 'Hide in graph',
      run: run(() => settings.setRefVisibility(repoPath, key, hidden ? 'show' : 'hide')),
    },
    {
      label: solo ? 'Stop solo' : 'Solo',
      run: run(() => settings.setRefVisibility(repoPath, key, solo ? 'unsolo' : 'solo')),
    },
    {
      label: 'Copy tag name',
      run: run(async () => {
        await navigator.clipboard.writeText(tag);
        toast('Tag name copied');
      }),
    },
    '-',
    {
      label: `Delete ${tag}`,
      danger: true,
      run: run(async () => {
        if (await askConfirm('Delete tag', `Delete the local tag ${tag}?`, { label: 'Delete', danger: true }))
          await exec('deleteTag', tag, null);
      }),
    },
    {
      label: `Delete ${tag} locally and on ${remote ?? 'remote'}`,
      danger: true,
      disabled: !remote,
      run: run(async () => {
        if (
          await askConfirm('Delete tag everywhere', `Delete ${tag} here and on ${remote}? This cannot be undone.`, {
            label: 'Delete everywhere',
            danger: true,
          })
        )
          await exec('deleteTag', tag, remote);
      }),
    },
  ];
  return createPortal(
    <div
      className="fixed inset-0 z-[100]"
      onMouseDown={(event) => event.target === event.currentTarget && onClose()}
      onContextMenu={(event) => {
        event.preventDefault();
        onClose();
      }}
    >
      <div
        role="menu"
        aria-label={`Actions for tag ${tag}`}
        className="glass-context-menu fixed z-[101] w-64 rounded-xl border border-white/15 p-1.5 shadow-2xl"
        style={{ left: Math.min(x, window.innerWidth - 270), top: Math.min(y, window.innerHeight - 330) }}
        onMouseDown={(event) => event.stopPropagation()}
      >
        {items.map((item, i) =>
          item === '-' ? (
            <div key={i} className="my-1 h-px bg-white/10" />
          ) : (
            <button
              key={item.label}
              type="button"
              role="menuitem"
              disabled={item.disabled}
              onClick={item.run}
              className={`flex min-h-9 w-full items-center rounded-lg px-3 text-left text-sm hover:bg-white/10 disabled:opacity-40 ${item.danger ? 'text-danger' : 'text-text'}`}
            >
              {item.label}
            </button>
          ),
        )}
      </div>
    </div>,
    document.body,
  );
}
