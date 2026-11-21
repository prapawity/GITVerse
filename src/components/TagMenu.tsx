import { useRepo } from '../store/repoStore';
import { useSettings } from '../store/settingsStore';
import { refKey } from '../lib/historyScope';
import { askConfirm } from './Dialogs';
import { ContextMenu, type MenuItem } from './ContextMenu';

/** Right-click menu for a tag in the sidebar: push, delete, hide / solo, copy. */
export function TagMenu({ tag, x, y, onClose }: { tag: string; x: number; y: number; onClose: () => void }) {
  const { repoPath, exec, toast, refs } = useRepo();
  const settings = useSettings();
  if (!repoPath) return null;
  const remote = refs.remote.some((r) => r.name.startsWith('origin/')) ? 'origin' : refs.remote[0]?.name.split('/')[0];
  const key = refKey('tag', tag);
  const hidden = (settings.graphHidden[repoPath] ?? []).includes(key);
  const solo = (settings.graphSolo[repoPath] ?? []).includes(key);
  // ContextMenu closes itself before running an item
  const run = (fn: () => unknown) => () => void fn();
  const items: MenuItem[] = [
    {
      label: 'Push',
      disabled: !remote,
      sub: [
        { label: `Push ${tag} to ${remote}`, run: run(() => exec('pushTag', remote, tag)) },
        { label: `Push all tags to ${remote}`, run: run(() => exec('pushTag', remote, null)) },
      ],
    },
    {
      label: 'Graph',
      sub: [
        {
          label: hidden ? 'Show in graph' : 'Hide in graph',
          run: run(() => settings.setRefVisibility(repoPath, key, hidden ? 'show' : 'hide')),
        },
        {
          label: solo ? 'Stop solo' : 'Solo',
          run: run(() => settings.setRefVisibility(repoPath, key, solo ? 'unsolo' : 'solo')),
        },
      ],
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
      label: 'Delete',
      danger: true,
      sub: [
        {
          label: `Delete ${tag} locally`,
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
      ],
    },
  ];
  return <ContextMenu items={items} x={x} y={y} label={`Actions for tag ${tag}`} onClose={onClose} width={280} />;
}
