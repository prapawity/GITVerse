import { DiffView } from './DiffView';
import type { ChangedFile } from './DetailsPanel';
import type { StashRef } from '../shared/types';

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
  const api = (window as any).gitApi;
  return (
    <DiffView
      repoPath={repo}
      hash={id}
      file={file}
      onClose={onClose}
      readOnlySnapshot
      loadDiff={() => api.stashFileDiff(repo, id, file.path)}
      loadContent={() => api.stashFileAt(repo, id, file.path)}
    />
  );
}
