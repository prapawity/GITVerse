import { create } from 'zustand';
import { desktopApi } from '../platform/api';
import { useSettings } from '../store/settingsStore';

export type AiTask = 'explain' | 'stash' | 'compose';

/** Run a one-shot AI task with the provider and model chosen in Settings; returns the text or throws. */
export async function runAiTask(task: AiTask, prompt: string): Promise<string> {
  const settings = useSettings.getState();
  const provider = settings.aiProvider;
  const model =
    (provider === 'openai' ? settings.openaiModel : provider === 'copilot' ? settings.copilotModel : '') || undefined;
  const result = await desktopApi().ai.task(provider, model, task, prompt);
  if (!result.ok) throw new Error(result.error?.message ?? 'AI did not answer.');
  return String(result.text)
    .trim()
    .replace(/^```(?:[\w-]+)?\s*\n/, '')
    .replace(/\n```\s*$/, '')
    .trim();
}

/** What the Explain dialog is showing: a title and how to build the material for the AI. */
interface ExplainRequest {
  title: string;
  subtitle?: string;
  material: () => Promise<string>;
}
export const useExplain = create<{
  request: ExplainRequest | null;
  open: (request: ExplainRequest) => void;
  close: () => void;
}>((set) => ({
  request: null,
  open: (request) => set({ request }),
  close: () => set({ request: null }),
}));

const api = () => desktopApi();

/** Material for explaining commits: one patch, a consecutive range, or several patches. */
export async function commitMaterial(repo: string, hashes: string[], range: { oldest: string; newest: string } | null) {
  if (range) {
    const patch: string = await api().rangePatch(repo, range.oldest, range.newest);
    return `Changes of ${hashes.length} consecutive commits (${range.oldest.slice(0, 7)}..${range.newest.slice(0, 7)}):\n\n${patch.slice(0, 140_000)}`;
  }
  const patches: string[] = await Promise.all(hashes.slice(0, 20).map((h) => api().formatPatch(repo, h)));
  return patches.join('\n').slice(0, 140_000);
}

export async function branchMaterial(repo: string, base: string, branch: string) {
  const r: { commits: string; diff: string } = await api().branchDiff(repo, base, branch);
  if (!r.diff.trim() && !r.commits.trim()) return '';
  return `Branch ${branch} compared with ${base}.\n\nCommits:\n${r.commits || '(none)'}\n\nDiff:\n${r.diff}`;
}

export async function workingMaterial(repo: string) {
  const r: { diff: string; untracked: string[] } = await api().workingDiff(repo);
  if (!r.diff.trim() && !r.untracked.length) return '';
  return `Uncommitted changes in the working tree.\n\n${r.untracked.length ? `New files not yet tracked:\n${r.untracked.map((f) => `- ${f}`).join('\n')}\n\n` : ''}Diff:\n${r.diff}`;
}
