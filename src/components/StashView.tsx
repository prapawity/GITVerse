import { DiffView } from './DiffView';
import type { ChangedFile } from './DetailsPanel';
import type { StashRef } from '../shared/types';
import { desktopApi } from '../platform/api';

export function StashView({
  repo,
  stash,
  file,
  onClose,
}: {
  repo: string;
  stash: StashRef;
  file: ChangedFile;
  onClose: () => void;
}) {
  const id = stash.hash ?? stash.id;
  return (
    <DiffView
      repoPath={repo}
      hash={id}
      file={file}
      onClose={onClose}
      readOnlySnapshot
      loadDiff={() => desktopApi().stashFileDiff(repo, id, file.path)}
      loadContent={() => desktopApi().stashFileAt(repo, id, file.path)}
    />
  );
}
