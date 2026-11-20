import { createPortal } from 'react-dom';
import { useRepo } from '../store/repoStore';

/**
 * Right-click menu on a changed file: add it, its extension or its folder to the root .gitignore.
 * Tracked files can also stop being tracked (`git rm --cached`), which keeps them on disk.
 */
export function IgnoreMenu({
  path,
  tracked,
  x,
  y,
  onClose,
}: {
  path: string;
  tracked: boolean;
  x: number;
  y: number;
  onClose: () => void;
}) {
  const exec = useRepo((s) => s.exec);
  const name = path.split('/').pop() ?? path;
  const dot = name.lastIndexOf('.');
  const extension = dot > 0 ? name.slice(dot) : '';
  const folder = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
  const options: { label: string; pattern: string; untrack?: string }[] = [
    { label: `Ignore ${name}`, pattern: `/${path}` },
    ...(extension ? [{ label: `Ignore all *${extension} files`, pattern: `*${extension}` }] : []),
    ...(folder ? [{ label: `Ignore folder ${folder}/`, pattern: `/${folder}/` }] : []),
    ...(tracked
      ? [
          { label: `Ignore and stop tracking ${name}`, pattern: `/${path}`, untrack: path },
          ...(folder
            ? [{ label: `Ignore and stop tracking ${folder}/`, pattern: `/${folder}/`, untrack: folder }]
            : []),
        ]
      : []),
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
        aria-label={`Actions for ${path}`}
        className="glass-context-menu fixed z-[101] w-72 rounded-xl border border-white/15 p-1.5 shadow-2xl"
        style={{ left: Math.min(x, window.innerWidth - 300), top: Math.min(y, window.innerHeight - 240) }}
        onMouseDown={(event) => event.stopPropagation()}
      >
        {options.map((option) => (
          <button
            key={option.label}
            type="button"
            role="menuitem"
            title={`Adds "${option.pattern}" to .gitignore${option.untrack ? ' and keeps the file on disk' : ''}`}
            onClick={() => {
              onClose();
              void exec('ignorePath', option.pattern, option.untrack ?? null);
            }}
            className="flex min-h-9 w-full items-center truncate rounded-lg px-3 text-left text-sm text-text hover:bg-white/10"
          >
            {option.label}
          </button>
        ))}
      </div>
    </div>,
    document.body,
  );
}
