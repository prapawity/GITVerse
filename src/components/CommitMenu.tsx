import { useState } from 'react';
import { ChevronRight } from 'lucide-react';
import { askConfirm, askFlow, askText } from './Dialogs';
import { useRepo } from '../store/repoStore';
import { groupRefs } from '../lib/refGroups';

const api = () => (window as any).gitApi;

/** git@host:o/r.git | https://[user@]host/o/r.git  ->  https://host/o/r */
export function webUrl(remote: string): string | null {
  let m =
    /^git@([^:]+):(.+?)(?:\.git)?$/.exec(remote) ??
    /^ssh:\/\/(?:[^@]+@)?([^/:]+)(?::\d+)?\/(.+?)(?:\.git)?$/.exec(remote);
  if (!m) m = /^https?:\/\/(?:[^@/]+@)?([^/]+)\/(.+?)(?:\.git)?\/?$/.exec(remote);
  return m ? `https://${m[1]}/${m[2]}` : null;
}
const commitLink = (base: string, hash: string) =>
  /gitlab/i.test(base)
    ? `${base}/-/commit/${hash}`
    : /bitbucket/i.test(base)
      ? `${base}/commits/${hash}`
      : `${base}/commit/${hash}`;

type Item = { label: string; run?: () => void; danger?: boolean; sub?: Item[] } | '-';

export function CommitMenu({
  x,
  y,
  hash,
  hashes,
  current,
  targetRef,
  onPush,
  onClose,
}: {
  x: number;
  y: number;
  hash: string;
  hashes?: string[];
  current: string;
  targetRef?: { name: string; kind: 'local' | 'remote' };
  onPush: () => void;
  onClose: () => void;
}) {
  const { repoPath, exec, deleteBothBranches, checkout, checkoutRemote, toast, track, refs, graph, action } = useRepo();
  const [open, setOpen] = useState<number | null>(null);
  const short = hash.slice(0, 7);

  const attempt = (fn: () => Promise<void>) => async () => {
    try {
      await fn();
    } catch (e: any) {
      useRepo.setState({ error: e.message });
    }
  };
  const sure =
    (title: string, msg: string, label: string, run: () => void, danger = false) =>
    async () => {
      if (await askConfirm(title, msg, { label, danger })) run();
    };

  const commitRefs = graph.rows.find((row) => row.commit.hash === hash)?.commit.refs ?? [];
  const displayed = groupRefs(commitRefs).find((group) => group.ref.current) ?? groupRefs(commitRefs)[0];
  const ref =
    targetRef ??
    (displayed && (displayed.ref.kind === 'local' || displayed.ref.kind === 'remote') ? displayed.ref : undefined);
  const refName = ref?.name;
  const isCurrent = ref?.kind === 'local' && refName === current;
  const localName = ref?.kind === 'remote' ? refName!.slice(refName!.indexOf('/') + 1) : refName;
  const pairedLocal = localName && refs.local.find((branch) => branch.name === localName);
  const pairedRemote =
    pairedLocal &&
    (ref?.kind === 'remote'
      ? refs.remote.find((branch) => branch.name === refName)
      : (refs.remote.find((branch) => branch.name === `origin/${pairedLocal.name}`) ??
        refs.remote.find((branch) => branch.name.endsWith(`/${pairedLocal.name}`))));
  const sameTip = !!pairedLocal && !!pairedRemote && pairedLocal.hash === pairedRemote.hash;
  const deleteLocal = (name: string) =>
    sure(
      'Delete local branch',
      `Delete local branch ${name}? Git will refuse if it is not fully merged.`,
      'Delete local',
      () => exec('deleteBranch', name),
      true,
    );
  const deleteRemote = (name: string) =>
    sure(
      'Delete remote branch',
      `Delete remote branch ${name} from its origin? This cannot be undone.`,
      'Delete remote',
      () => exec('deleteRemoteBranch', name),
      true,
    );
  const branchItems: Item[] =
    ref && refName
      ? [
          ...(isCurrent
            ? [{ label: 'Pull', run: () => action('pull') }, { label: 'Push', run: onPush }, '-' as const]
            : [
                {
                  label: `Fast-forward ${current} to ${refName}`,
                  run: sure('Fast-forward', `Fast-forward ${current} to ${refName}?`, 'Fast-forward', () =>
                    exec('merge', refName, false, true),
                  ),
                },
                {
                  label: `Merge ${refName} into ${current}`,
                  run: sure('Merge', `Merge ${refName} into ${current}?`, 'Merge', () => exec('merge', refName)),
                },
                {
                  label: `Rebase ${current} onto ${refName}`,
                  run: sure('Rebase', `Rebase ${current} onto ${refName}?`, 'Rebase', () =>
                    exec('rebaseOnto', refName),
                  ),
                },
                '-' as const,
                {
                  label: `Checkout ${refName}`,
                  run: () => (ref.kind === 'local' ? checkout(refName) : checkoutRemote(refName)),
                },
                '-' as const,
              ]),
          {
            label: `Create branch from ${refName}`,
            run: async () => {
              const n = await askFlow(
                refs.local.map((b) => b.name),
                refName,
              );
              if (n) exec('branchAt', n, hash);
            },
          },
          ...(sameTip && !pairedLocal.current
            ? [
                { label: `Delete local ${pairedLocal.name}`, danger: true, run: deleteLocal(pairedLocal.name) },
                { label: `Delete remote ${pairedRemote.name}`, danger: true, run: deleteRemote(pairedRemote.name) },
                {
                  label: `Delete both ${pairedLocal.name}`,
                  danger: true,
                  run: sure(
                    'Delete both branches',
                    `Delete local branch ${pairedLocal.name} and remote branch ${pairedRemote.name}? The local branch is checked first and must be fully merged. If remote deletion fails afterwards, the local branch will already be deleted.`,
                    'Delete both',
                    () => deleteBothBranches(pairedLocal.name, pairedRemote.name),
                    true,
                  ),
                },
              ]
            : ref.kind === 'local' && !isCurrent
              ? [{ label: `Delete ${refName}`, danger: true, run: deleteLocal(refName) }]
              : ref.kind === 'remote'
                ? [{ label: `Delete remote ${refName}`, danger: true, run: deleteRemote(refName) }]
                : []),
          {
            label: 'Copy branch name',
            run: attempt(async () => {
              await navigator.clipboard.writeText(refName);
              toast('Branch name copied');
            }),
          },
          '-' as const,
        ]
      : [];

  const selected =
    hashes && hashes.length > 1
      ? graph.rows.filter((row) => hashes.includes(row.commit.hash)).map((row) => row.commit.hash)
      : [];
  const items: Item[] = [
    ...(selected.length > 1
      ? [
          {
            label: `Squash ${selected.length} commits`,
            run: async () => {
              const repo = repoPath;
              const message = await askText('Squash commits', 'New commit message');
              if (!message) return;
              if (
                !(await askConfirm(
                  'Squash commits',
                  `Replace ${selected.length} selected commits on ${current} with one commit? This rewrites history and uses the current commit identity. If already pushed, the remote may need a force push.`,
                  { label: 'Squash commits', danger: true },
                ))
              )
                return;
              if (useRepo.getState().repoPath !== repo) {
                useRepo.getState().notify('error', 'Squash cancelled', 'The active repository changed.');
                return;
              }
              await exec('squashCommits', selected, message);
            },
          },
          {
            label: `Copy ${selected.length} commit SHAs`,
            run: attempt(async () => {
              await navigator.clipboard.writeText(selected.join('\n'));
              toast('Commit SHAs copied');
            }),
          },
          '-' as const,
        ]
      : branchItems),
    {
      label: 'Checkout this commit',
      run: sure(
        'Checkout commit',
        `Check out ${short} in detached HEAD mode? New commits will not belong to a branch until you create or check out one.`,
        'Checkout',
        () => checkout(hash),
      ),
    },
    '-',
    {
      label: 'Create worktree from this commit',
      run: attempt(async () => {
        const p = await askText('Create worktree', 'Absolute path of the new worktree folder');
        if (p) await exec('worktreeAdd', p, hash);
      }),
    },
    '-',
    {
      label: 'Create branch here',
      run: async () => {
        const n = await askFlow(
          useRepo.getState().refs.local.map((b) => b.name),
          `commit ${short}`,
        );
        if (n) exec('branchAt', n, hash);
      },
    },
    selected.length > 1
      ? {
          label: `Cherry pick ${selected.length} commits`,
          run: sure(
            'Cherry-pick commits',
            `Cherry-pick ${selected.length} selected commits onto ${current}, oldest first?`,
            'Cherry-pick',
            () => exec('cherryPickMany', [...selected].reverse()),
          ),
        }
      : { label: 'Cherry pick commit', run: () => exec('cherryPick', hash) },
    {
      label: `Rebase ${current} onto this commit`,
      run: sure('Rebase', `Rebase ${current} onto ${short}?`, 'Rebase', () => exec('rebaseOnto', hash)),
    },
    {
      label: `Reset ${current} to this commit`,
      sub: [
        {
          label: 'Soft — keep all changes staged',
          run: sure('Soft reset', `Move ${current} to ${short}; changes stay staged.`, 'Reset', () =>
            exec('reset', hash, 'soft'),
          ),
        },
        {
          label: 'Mixed — keep changes unstaged',
          run: sure('Mixed reset', `Move ${current} to ${short}; changes stay in the working tree.`, 'Reset', () =>
            exec('reset', hash, 'mixed'),
          ),
        },
        {
          label: 'Hard — discard all changes',
          danger: true,
          run: sure(
            'Hard reset',
            `Move ${current} to ${short} and DISCARD all uncommitted changes. This cannot be undone.`,
            'Hard reset',
            () => exec('reset', hash, 'hard'),
            true,
          ),
        },
      ],
    },
    { label: 'Revert commit', run: () => exec('revert', hash) },
    '-',
    {
      label: 'Copy commit sha',
      run: attempt(async () => {
        await navigator.clipboard.writeText(hash);
        toast(`Copied ${short}`);
      }),
    },
    {
      label: 'Copy link to this commit on remote: origin',
      run: () =>
        track('Preparing link…', async () => {
          const base = webUrl(await api().remoteUrl(repoPath));
          if (!base) throw new Error('Could not turn the origin remote into a web URL.');
          await navigator.clipboard.writeText(commitLink(base, hash));
          toast('Commit link copied');
        }),
    },
    {
      label: selected.length > 1 ? `Create patch from ${selected.length} commits` : 'Create patch from commit',
      run: () =>
        track('Creating patch…', async () => {
          const patches: string[] = await Promise.all(
            (selected.length > 1 ? [...selected].reverse() : [hash]).map((commit) =>
              api().formatPatch(repoPath, commit),
            ),
          );
          if (patches.some((patch) => !patch.trim()))
            throw new Error(
              'Could not create a patch for every selected commit. Merge commits cannot be exported this way.',
            );
          const patch = patches.join('\n');
          const a = document.createElement('a');
          a.href = URL.createObjectURL(new Blob([patch], { type: 'text/plain' }));
          a.download = `${short}.patch`;
          a.click();
          URL.revokeObjectURL(a.href);
          toast(`Saved ${short}.patch`);
        }),
    },
    '-',
    {
      label: 'Create tag here',
      run: async () => {
        const n = await askText('Create tag', 'Tag name');
        if (n) exec('createTag', n, hash);
      },
    },
    {
      label: 'Create annotated tag here',
      run: attempt(async () => {
        const n = await askText('Create annotated tag', 'Tag name');
        if (!n) return;
        const m = await askText('Tag message', 'Message');
        if (m) await exec('createAnnotatedTag', n, hash, m);
      }),
    },
  ];

  const W = Math.min(560, window.innerWidth - 16);
  const left = Math.min(x, window.innerWidth - W - 8);
  const top = Math.max(8, Math.min(y, window.innerHeight - Math.min(700, window.innerHeight - 16)));
  const row =
    'flex w-full cursor-pointer items-center justify-between gap-4 px-4 py-[7px] text-left text-[14px] hover:bg-[#4cc2ff]/20 focus:bg-[#4cc2ff]/20';

  return (
    <div
      role="menu"
      aria-label="Commit actions"
      className="fixed z-50 max-h-[calc(100vh-16px)] overflow-y-auto rounded-lg border border-surface bg-mantle/95 py-1 shadow-2xl backdrop-blur"
      style={{ left, top, width: W }}
      onClick={(e) => e.stopPropagation()}
    >
      {items.map((it, i) =>
        it === '-' ? (
          <div key={i} className="my-1 border-t border-white/10" />
        ) : (
          <div key={it.label} className="relative" onMouseEnter={() => setOpen(it.sub ? i : null)}>
            <button
              role="menuitem"
              aria-haspopup={!!it.sub}
              aria-expanded={it.sub ? open === i : undefined}
              className={`${row} ${it.danger ? 'text-[#f38ba8]' : ''}`}
              title={it.label}
              onClick={() => {
                if (it.sub) setOpen(i);
                else {
                  onClose();
                  it.run?.();
                }
              }}
            >
              <span className="truncate">{it.label}</span>
              {it.sub && <ChevronRight size={14} aria-hidden />}
            </button>
            {it.sub && open === i && (
              <div role="menu" className="border-l border-[#4cc2ff]/40 bg-canvas py-1 pl-3">
                {it.sub.map(
                  (s) =>
                    s !== '-' && (
                      <button
                        key={s.label}
                        role="menuitem"
                        className={`${row} ${s.danger ? 'text-[#f38ba8]' : ''}`}
                        onClick={() => {
                          onClose();
                          s.run?.();
                        }}
                      >
                        {s.label}
                      </button>
                    ),
                )}
              </div>
            )}
          </div>
        ),
      )}
    </div>
  );
}
