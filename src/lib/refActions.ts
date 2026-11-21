/**
 * What clicking a branch or tag does, shared by the sidebar, the commit graph and the command palette,
 * so both places behave the same:
 * - locate (single click): select its commit and scroll the graph to it
 * - open (double click): check it out — a local branch directly, a remote branch as a tracking branch,
 *   a tag as a detached HEAD after a warning
 */
import { useRepo } from '../store/repoStore';
import { desktopApi } from '../platform/api';
import { checkoutRemoteWithSparseRecovery } from './checkoutRemoteFlow';
import { askConfirm } from '../components/Dialogs';

export type RefKind = 'local' | 'remote' | 'tag';

let locator: ((hash: string) => Promise<boolean>) | null = null;
/** The app shell registers how to select and scroll to a commit. */
export function registerLocator(fn: ((hash: string) => Promise<boolean>) | null) {
  locator = fn;
}

const clean = (e: unknown) =>
  String((e as Error)?.message ?? e).replace(/^Error invoking remote method '[^']*': (Error: )?/, '');

export async function locateRef(kind: RefKind, name: string): Promise<boolean> {
  const state = useRepo.getState();
  try {
    let hash: string | undefined;
    if (kind === 'tag') {
      if (!state.repoPath) return false;
      hash = await desktopApi().tagCommit(state.repoPath, name);
    } else {
      hash =
        state.refs[kind].find((item) => item.name === name)?.hash ??
        state.graph.rows.find((row) => row.commit.refs.some((r) => r.kind === kind && r.name === name))?.commit.hash;
    }
    if (!hash) throw new Error('Refresh the repository and try again.');
    return (await locator?.(hash)) ?? false;
  } catch (error) {
    state.notify('error', `Could not locate ${kind === 'tag' ? 'tag' : 'branch'}`, clean(error));
    return false;
  }
}

export async function openRef(kind: RefKind, name: string): Promise<void> {
  const state = useRepo.getState();
  if (kind === 'local') {
    if (state.refs.local.some((b) => b.name === name && b.current)) return;
    await state.checkout(name);
  } else if (kind === 'remote') {
    await checkoutRemoteWithSparseRecovery(name);
  } else if (
    await askConfirm(
      `Check out tag ${name}?`,
      'This puts the repository in "detached HEAD": new commits will not belong to any branch until you create one.',
      { label: 'Check out tag' },
    )
  ) {
    await state.checkout(name);
  }
}
