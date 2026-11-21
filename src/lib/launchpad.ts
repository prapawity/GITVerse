/**
 * Launchpad: pull requests, issues and work in progress across every repository open as a tab.
 * Each repository is loaded independently (a few at a time), so one server being slow or a missing
 * token never hides the others; repositories that share a remote are fetched once.
 */
import { create } from 'zustand';
import { desktopApi } from '../platform/api';
import type { HostedRepo } from '../shared/pullRequests';
import type { FileStatus } from '../shared/types';
import { HostError, openIssues, openRequests, type OpenIssue, type OpenRequest } from './pullRequests';
import { hostedFor } from '../components/PullRequestList';

export interface RepoSummary {
  path: string;
  name: string;
  hosted: HostedRepo | null;
  branch: string | null;
  changes: number;
  requests: OpenRequest[];
  issues: OpenIssue[];
  /** why requests / issues are missing for this repository, if they are */
  problem?: string;
  needsToken?: boolean;
}

const nameOf = (path: string) => path.split(/[\\/]/).filter(Boolean).pop() ?? path;

async function summarize(
  path: string,
  seen: Map<string, Promise<Pick<RepoSummary, 'requests' | 'issues' | 'problem' | 'needsToken'>>>,
): Promise<RepoSummary> {
  const api = desktopApi();
  const [hosted, status, refs] = await Promise.all([
    hostedFor(path).catch(() => null),
    api.status(path).catch(() => [] as FileStatus[]),
    api.refs(path).catch(() => ({ local: [] as { name: string; current?: boolean }[] })),
  ]);
  const base: RepoSummary = {
    path,
    name: nameOf(path),
    hosted,
    branch: refs.local.find((b: { current?: boolean }) => b.current)?.name ?? null,
    changes: (status as FileStatus[]).length,
    requests: [],
    issues: [],
  };
  if (!hosted) return { ...base, problem: 'No GitHub, GitLab or Bitbucket remote' };
  // clones of the same project share one fetch
  const key = `${hosted.kind}:${hosted.host}/${hosted.path}`;
  if (!seen.has(key))
    seen.set(
      key,
      (async () => {
        try {
          const [requests, issues] = await Promise.all([
            openRequests(hosted),
            hosted.kind === 'bitbucket' ? Promise.resolve([] as OpenIssue[]) : openIssues(hosted).catch(() => []),
          ]);
          return { requests, issues };
        } catch (e) {
          return {
            requests: [],
            issues: [],
            problem: String((e as Error)?.message ?? e),
            needsToken: e instanceof HostError && e.needsToken,
          };
        }
      })(),
    );
  return { ...base, ...(await seen.get(key)!) };
}

/** Load every repository, at most `limit` at a time; results arrive through `onRepo` as they finish. */
export async function loadLaunchpad(paths: string[], onRepo: (summary: RepoSummary) => void, limit = 3) {
  const seen = new Map<string, Promise<Pick<RepoSummary, 'requests' | 'issues' | 'problem' | 'needsToken'>>>();
  const queue = [...paths];
  const worker = async () => {
    for (let path = queue.shift(); path; path = queue.shift()) onRepo(await summarize(path, seen));
  };
  await Promise.all(Array.from({ length: Math.min(limit, paths.length) }, worker));
}

export const useLaunchpad = create<{ open: boolean; show: () => void; close: () => void; toggle: () => void }>(
  (set) => ({
    open: false,
    show: () => set({ open: true }),
    close: () => set({ open: false }),
    toggle: () => set((s) => ({ open: !s.open })),
  }),
);
