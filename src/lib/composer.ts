import { create } from 'zustand';
import { desktopApi } from '../platform/api';
import type { FileStatus } from '../shared/types';

export interface PlannedCommit {
  id: string;
  summary: string;
  body: string;
  files: string[];
}

let seq = 0;
export const newCommitId = () => `c${++seq}`;

const CODE: Record<string, string> = { M: 'modified', A: 'added', D: 'deleted', R: 'renamed', '?': 'new file' };
export const fileKind = (f: FileStatus) =>
  CODE[f.index === '?' ? '?' : f.index !== ' ' ? f.index : f.worktree] ?? 'changed';

/** The material the AI sees: the changed files, every uncommitted diff, and recent messages for style. */
export async function composeMaterial(repo: string, files: FileStatus[], recentSubjects: string[]) {
  const working: { diff: string; untracked: string[] } = await desktopApi().workingDiff(repo);
  return [
    `Changed files (${files.length}):`,
    ...files.map((f) => `- ${f.path} (${fileKind(f)}${f.oldPath ? ` from ${f.oldPath}` : ''})`),
    '',
    `Recent commit messages in this repository:\n${
      recentSubjects
        .slice(0, 12)
        .map((s) => `- ${s}`)
        .join('\n') || '(none)'
    }`,
    '',
    `Diff:\n${working.diff || '(only new files)'}`,
  ].join('\n');
}

/**
 * Turn the AI's JSON into commits the app can apply: unknown files are dropped, a file listed twice
 * stays in its first commit, and any file the AI left out goes into a final "remaining" commit.
 */
export function parsePlan(text: string, paths: string[]): PlannedCommit[] {
  const json = text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1);
  let raw: { commits?: { message?: string; files?: string[] }[] };
  try {
    raw = JSON.parse(json);
  } catch {
    throw new Error('AI did not return a usable plan. Try again.');
  }
  const known = new Set(paths);
  const used = new Set<string>();
  const commits: PlannedCommit[] = [];
  for (const c of raw.commits ?? []) {
    const files = (c.files ?? []).filter((f) => known.has(f) && !used.has(f));
    files.forEach((f) => used.add(f));
    if (!files.length) continue;
    const [summary, ...rest] = String(c.message ?? '')
      .trim()
      .split('\n');
    commits.push({ id: newCommitId(), summary: summary.trim() || 'Update files', body: rest.join('\n').trim(), files });
  }
  const left = paths.filter((p) => !used.has(p));
  if (left.length) commits.push({ id: newCommitId(), summary: 'Remaining changes', body: '', files: left });
  return commits;
}

export const useComposer = create<{ open: boolean; show: () => void; close: () => void }>((set) => ({
  open: false,
  show: () => set({ open: true }),
  close: () => set({ open: false }),
}));
