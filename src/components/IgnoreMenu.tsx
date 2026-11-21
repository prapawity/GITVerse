import { useRepo } from '../store/repoStore';
import { ContextMenu, type MenuItem } from './ContextMenu';

/** A literal path as a .gitignore pattern: glob characters, a leading # or ! and trailing spaces are escaped. */
export function escapeGitignore(path: string): string {
  return path
    .replace(/[\\*?[\]]/g, (c) => `\\${c}`)
    .replace(/^[#!]/, (c) => `\\${c}`)
    .replace(/ +$/, (spaces) => spaces.replace(/ /g, '\\ '));
}

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
  const exact = `/${escapeGitignore(path)}`;
  const dir = `/${escapeGitignore(folder)}/`;
  const ignore = (pattern: string, untrack?: string) => () => void exec('ignorePath', pattern, untrack ?? null);
  const items: MenuItem[] = [
    { label: `Ignore ${name}`, hint: `Adds "${exact}" to .gitignore`, run: ignore(exact) },
    ...(extension
      ? [
          {
            label: `Ignore all *${extension} files`,
            hint: `Adds "*${escapeGitignore(extension)}"`,
            run: ignore(`*${escapeGitignore(extension)}`),
          },
        ]
      : []),
    ...(folder ? [{ label: `Ignore folder ${folder}/`, hint: `Adds "${dir}"`, run: ignore(dir) }] : []),
    ...(tracked
      ? [
          '-' as const,
          {
            label: 'Ignore and stop tracking',
            hint: 'Removes it from Git (git rm --cached) and keeps it on disk',
            sub: [
              { label: name, run: ignore(exact, path) },
              ...(folder ? [{ label: `${folder}/`, run: ignore(dir, folder) }] : []),
            ],
          },
        ]
      : []),
  ];
  return <ContextMenu items={items} x={x} y={y} label={`Actions for ${path}`} onClose={onClose} width={300} />;
}
