import type Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';

/**
 * Tools the in-app assistant may call. Shared by the main process (sent to the API) and the
 * renderer (which validates and executes them through the same store actions the toolbar uses).
 */
export const AI_MODEL = 'claude-opus-5-5';

// read = runs immediately; write = changes the repository, so the user approves each call first
export const TOOL_KIND: Record<string, 'read' | 'safe' | 'write'> = {
  get_repo_status: 'read',
  list_branches: 'read',
  recent_commits: 'read',
  fetch: 'safe', // only updates remote-tracking refs; never touches your branches or files
  pull: 'write',
  push: 'write',
  stash: 'write',
  stash_pop: 'write',
  checkout: 'write',
  create_branch: 'write',
  rebase: 'write',
  merge: 'write',
  flow_start: 'write',
  flow_finish: 'write',
  get_conflicts: 'read',
  get_conflict_file: 'read',
  resolve_conflict_file: 'write',
  continue_operation: 'write',
  skip_commit: 'write',
  abort_operation: 'write',
};

export const FLOW_TYPES = ['feature', 'bugfix', 'release', 'hotfix', 'support'] as const;

export const TOOL_INPUT = {
  get_repo_status: z.object({}).strict(),
  list_branches: z.object({ filter: z.string().max(200).optional() }).strict(),
  recent_commits: z.object({ limit: z.number().int().min(1).max(50).optional() }).strict(),
  fetch: z.object({}).strict(),
  pull: z.object({}).strict(),
  push: z.object({}).strict(),
  stash: z.object({}).strict(),
  stash_pop: z.object({}).strict(),
  checkout: z.object({ ref: z.string().min(1).max(255) }).strict(),
  create_branch: z.object({ name: z.string().min(1).max(255), from: z.string().min(1).max(255).optional() }).strict(),
  rebase: z.object({ onto: z.string().min(1).max(255) }).strict(),
  merge: z.object({ ref: z.string().min(1).max(255), no_ff: z.boolean().optional() }).strict(),
  flow_start: z
    .object({ type: z.enum(FLOW_TYPES), name: z.string().min(1).max(200), from: z.string().min(1).max(255).optional() })
    .strict(),
  flow_finish: z
    .object({ delete_branch: z.boolean().optional(), tag_message: z.string().max(500).optional() })
    .strict(),
  get_conflicts: z.object({}).strict(),
  get_conflict_file: z.object({ path: z.string().min(1).max(1000) }).strict(),
  resolve_conflict_file: z
    .object({
      path: z.string().min(1).max(1000),
      resolutions: z
        .array(
          z
            .object({
              index: z.number().int().min(0),
              resolved: z.string().max(200_000),
              explanation: z.string().min(1).max(500),
            })
            .strict(),
        )
        .min(1)
        .max(200),
    })
    .strict(),
  continue_operation: z.object({}).strict(),
  skip_commit: z.object({}).strict(),
  abort_operation: z.object({}).strict(),
} as const;
export type ToolName = keyof typeof TOOL_INPUT;

const tool = (
  name: ToolName,
  description: string,
  properties: Record<string, unknown> = {},
  required: string[] = [],
): Anthropic.Beta.BetaTool => ({
  name,
  description,
  eager_input_streaming: true, // streamed request: inputs arrive as generated; the renderer validates them before running
  input_schema: { type: 'object', properties, required, additionalProperties: false },
});

export const AI_TOOLS: Anthropic.Beta.BetaTool[] = [
  tool(
    'get_repo_status',
    'Current repository, checked-out branch, uncommitted changed files, any rebase/merge in progress with its conflicted files, and stash count. Call this before pull, push or checkout so you can warn about uncommitted work.',
  ),
  tool(
    'list_branches',
    'Local and remote branch names (the current one is marked). Use to find the exact name of a branch the user refers to loosely.',
    { filter: { type: 'string', description: 'Case-insensitive substring to narrow the list.' } },
  ),
  tool(
    'recent_commits',
    'The most recent commits in the graph: short hash, subject, author, date and the branches/tags on each.',
    { limit: { type: 'integer', minimum: 1, maximum: 50, description: 'How many commits, default 15.' } },
  ),
  tool(
    'fetch',
    'Fetch from all remotes (with prune if the user enabled it). Safe: does not change local branches or files.',
  ),
  tool('pull', 'Pull the current branch from its upstream. Requires user approval.'),
  tool('push', 'Push the current branch to its upstream. Never force-pushes. Requires user approval.'),
  tool('stash', 'Stash all uncommitted changes, including untracked files. Requires user approval.'),
  tool('stash_pop', 'Apply and drop the most recent stash. Requires user approval.'),
  tool(
    'checkout',
    'Check out a local branch, a remote branch (creates a tracking branch), a tag or a commit. Requires user approval.',
    { ref: { type: 'string', description: 'Branch name, tag, or commit hash.' } },
    ['ref'],
  ),
  tool(
    'rebase',
    "Rebase the current branch onto another branch, tag or commit. Rewrites the current branch's history (after pushing it would need a force push, which you cannot do). If it stops on conflicts, use get_conflicts. Requires user approval.",
    { onto: { type: 'string', description: 'Branch, tag or commit to rebase onto.' } },
    ['onto'],
  ),
  tool(
    'merge',
    'Merge a branch, tag or commit into the current branch. Creates a merge commit unless no_ff is false and a fast-forward is possible. If it stops on conflicts, use get_conflicts. Requires user approval.',
    {
      ref: { type: 'string' },
      no_ff: { type: 'boolean', description: 'Always create a merge commit (default true).' },
    },
    ['ref'],
  ),
  tool(
    'flow_start',
    "Git Flow: start a feature, bugfix, release, hotfix or support branch using this repository's Gitflow settings (prefixes and the development/production branch names from Preferences). feature/bugfix/release start from the development branch; hotfix/support from the production branch. Requires user approval.",
    {
      type: { type: 'string', enum: [...FLOW_TYPES] },
      name: { type: 'string', description: 'Name after the prefix, e.g. "DEMO-123-login" or "1.2.0".' },
      from: { type: 'string', description: 'Override the start point.' },
    },
    ['type', 'name'],
  ),
  tool(
    'flow_finish',
    'Git Flow: finish the CURRENT flow branch. feature/bugfix: merge (--no-ff) into the development branch. release/hotfix: merge into the production branch, tag it with the branch name, then merge into the development branch. The branch is deleted afterwards (only if fully merged). Needs a clean working tree. Stops and reports if a merge conflicts. Requires user approval.',
    {
      delete_branch: { type: 'boolean', description: 'Delete the finished branch (default true).' },
      tag_message: { type: 'string', description: 'Message for the release/hotfix tag.' },
    },
  ),
  tool(
    'get_conflicts',
    'The merge/rebase/cherry-pick/revert in progress, which files still have conflicts and how many conflicting regions each has. Call this after any action that stopped on conflicts.',
  ),
  tool(
    'get_conflict_file',
    'The conflicting regions of one file: for each numbered region, version A, version B, the common base when available, and the code around it. For a rebase A is the branch being rebased onto and B is the commit being replayed; for a merge A is the current branch and B is the incoming one.',
    { path: { type: 'string', description: 'Path as listed by get_conflicts.' } },
    ['path'],
  ),
  tool(
    'resolve_conflict_file',
    'Write the resolution of EVERY conflicting region of one file in a single call, then stage the file. Give the exact replacement text for each region (no conflict markers) and a one-sentence explanation the user will read before approving. Never invent code that is in neither version unless needed to combine them. Requires user approval.',
    {
      path: { type: 'string' },
      resolutions: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            index: { type: 'integer', minimum: 0 },
            resolved: { type: 'string' },
            explanation: { type: 'string' },
          },
          required: ['index', 'resolved', 'explanation'],
          additionalProperties: false,
        },
      },
    },
    ['path', 'resolutions'],
  ),
  tool(
    'continue_operation',
    'Continue the stopped rebase/merge/cherry-pick/revert once every conflicted file is resolved. It may stop again on the next commit. Requires user approval.',
  ),
  tool(
    'skip_commit',
    'Skip the commit currently being applied during a rebase/cherry-pick/revert. Requires user approval.',
  ),
  tool(
    'abort_operation',
    'Abort the stopped operation and restore the branch to how it was before it started. Discards conflict resolutions made so far. Requires user approval.',
  ),
  tool(
    'create_branch',
    'Create a new branch and check it out. Requires user approval.',
    {
      name: { type: 'string' },
      from: { type: 'string', description: 'Start point (branch, tag or commit). Defaults to the current HEAD.' },
    },
    ['name'],
  ),
];

export const AI_SYSTEM = `You are the assistant built into GITVerse, a desktop Git client. You operate the repository that is open in the app by calling the tools provided.

How the tools behave:
- get_repo_status, list_branches and recent_commits run immediately. fetch also runs immediately because it only updates remote-tracking refs.
- pull, push, stash, stash_pop, checkout and create_branch are shown to the user, who approves or declines each call. If a result says the user declined, don't call it again; ask what they would like instead.
- The app already shows a progress overlay and a success or error message for each action, so after a tool runs, confirm the outcome in one short sentence rather than repeating everything.

Working well:
- Before pull, push or checkout, check get_repo_status so you can mention uncommitted changes or a rebase/merge in progress.
- Resolve loose branch names with list_branches instead of guessing; if several branches match, ask which one.
- When a tool fails, explain the git error in plain words and suggest the next step.
- Conflicts: when an action stops on conflicts, call get_conflicts, then for each file get_conflict_file, think about what both sides intend, and write the whole file's resolution with resolve_conflict_file (one call per file, every region). Keep both sides' intent when they don't contradict; when they do, choose what fits the surrounding code and say why. If you cannot tell which side is right, ask the user instead of guessing. After all files are resolved call continue_operation; a rebase may stop again on the next commit, so check get_conflicts again.
- Git Flow: use flow_start and flow_finish rather than assembling the steps yourself. The development and production branch names and the prefixes come from the repository's Gitflow preferences. flow_finish needs a clean working tree.
- Rebase and merge change history or the working tree: explain in a sentence what you are about to do before calling them, and mention that a rebased branch that was already pushed would need a force push, which you cannot do.
- You cannot edit files other than resolving conflicts, make commits, reset, cherry-pick, revert, or force-push from chat. If asked, say so and point to where it is in the app: right-click a commit for reset / cherry-pick / revert.
- Reply in the language the user writes in. Keep replies short; use a list only when listing several items.`;

/** Structured result of "Auto-resolve with AI" in the merge tool. */
export const ConflictResolution = z.object({
  resolutions: z.array(
    z.object({
      index: z.number().int().describe('0-based index of the conflict, as numbered in the request'),
      resolved: z.string().describe('Exact replacement text for this conflict region, without any conflict markers'),
      explanation: z.string().describe('One short sentence: what was kept from A and/or B and why'),
    }),
  ),
});
export type ConflictResolutionT = z.infer<typeof ConflictResolution>;

export const CONFLICT_SYSTEM = `You resolve Git merge conflicts inside GITVerse. You receive one file with numbered conflict regions; each region has version A and version B (and sometimes the common base), plus surrounding code for context.

For every region, write the text that should replace the whole region in the final file:
- Combine the intent of both sides when they don't contradict (e.g. both added different fields, imports or cases: keep both, in a sensible order, without duplicates).
- When they genuinely contradict, choose the side that fits the surrounding code and the operation's goal, and say which you chose.
- Preserve the file's indentation, quoting and line-ending style. Never output conflict markers (<<<<<<<, =======, >>>>>>>, |||||||).
- Return exactly one entry per region, using the region's index. Output only the region's replacement text, not the context around it.`;
