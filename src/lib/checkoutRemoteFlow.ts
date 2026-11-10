import { askConfirm } from '../components/Dialogs';
import { useRepo } from '../store/repoStore';

const api = () => (window as any).gitApi;

/** Offer a sparse checkout only when a remote tree has paths Windows cannot materialize. */
export async function checkoutRemoteWithSparseRecovery(ref: string) {
  const repoPath = useRepo.getState().repoPath;
  if (!repoPath) return;

  let unsupported: string[];
  try {
    unsupported = await api().windowsUnsupportedPathsForRef(repoPath, ref);
  } catch (error) {
    useRepo.getState().notify('error', 'Checkout failed', String((error as Error).message ?? error));
    return;
  }

  if (!unsupported.length) {
    await useRepo.getState().checkoutRemote(ref);
    return;
  }

  const currentStatus = await api().status(repoPath).catch((error: unknown) => {
    useRepo.getState().notify('error', 'Could not inspect working changes', String((error as Error).message ?? error));
    return null;
  });
  if (!currentStatus) return;
  if (currentStatus.length) {
    useRepo.getState().notify(
      'warning',
      'Commit or stash changes first',
      `Sparse checkout needs a clean working tree. ${currentStatus.length} changed entr${currentStatus.length === 1 ? 'y is' : 'ies are'} present.`,
    );
    return;
  }

  const examples = unsupported.slice(0, 5).map((filePath) => `'${filePath}'`).join('\n');
  const more = unsupported.length > 5 ? `\n…and ${unsupported.length - 5} more.` : '';
  const confirmed = await askConfirm(
    'Use sparse checkout for Windows?',
    `${unsupported.length} paths in ${ref} contain names Windows cannot create:\n${examples}${more}\n\nGITVerse will enable sparse checkout for this working tree, omit these paths from the Windows folder, and align the local branch with the remote. The files remain in the Git history and on the remote.`,
    { label: 'Continue with sparse checkout' },
  );
  if (!confirmed || useRepo.getState().repoPath !== repoPath) return;
  await useRepo.getState().checkoutRemote(ref, true, unsupported);
}
