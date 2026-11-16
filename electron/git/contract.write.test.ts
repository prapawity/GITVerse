/**
 * Golden contract tests for the write-side Git API.
 *
 * Each scenario starts from the deterministic repository in contractRepo.ts, optionally prepares it
 * with raw git, runs ONE operation from git.ts, and records `{ result | error, after }` where `after`
 * is the repository state (status, refs, log, in-progress operation). The Rust backend replays the
 * same scenarios (src-tauri/core/tests/golden_write.rs) and must produce identical JSON.
 *
 * Regenerate after an intentional change:  UPDATE_FIXTURES=1 npm test
 */
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import * as git from './git';
import { OPERATION_ENV, buildRepo, golden, isolatedEnv, rawGit } from './contractRepo';

type Raw = ReturnType<typeof rawGit>;
type Scenario = {
  /** Prepare the repository with raw git (not under test). */
  setup?: (raw: Raw, cwd: string) => Promise<unknown>;
  /** The single operation under test. */
  run: (cwd: string) => Promise<unknown>;
};

const put = (cwd: string, file: string, text: string) => writeFile(path.join(cwd, file), text);
/** Discard the builder's working-tree changes and stash so a scenario starts clean. */
const clean = async (raw: Raw) => {
  await raw('reset', '--quiet', '--hard', 'HEAD');
  await raw('clean', '-fdq');
};
/** Make `main` and a new `clash` branch both edit README.md, so merging clash conflicts. */
const conflict = async (raw: Raw, cwd: string) => {
  await clean(raw);
  await raw('checkout', '--quiet', '-b', 'clash');
  await put(cwd, 'README.md', '# Demo\n\nfrom clash\n');
  await raw('commit', '--quiet', '-am', 'Clash edit');
  await raw('checkout', '--quiet', 'main');
  await put(cwd, 'README.md', '# Demo\n\nfrom main\n');
  await raw('commit', '--quiet', '-am', 'Main edit');
  await raw('merge', '--quiet', 'clash').catch(() => {});
};

/** format-patch ends with "-- \n<git version>"; drop it so fixtures do not depend on the git version. */
const withoutGitVersion = (patch: string) => {
  const i = patch.lastIndexOf('\n-- \n');
  return i < 0 ? patch : patch.slice(0, i + 1);
};

export const SCENARIOS: Record<string, Scenario> = {
  stage: { run: (cwd) => git.stage(cwd, ['app.txt', 'notes.md', 'README.md']) },
  stageRejectsUnknownFile: { run: (cwd) => git.stage(cwd, ['missing.txt']) },
  unstage: { run: (cwd) => git.unstage(cwd, ['login.txt']) },
  commit: { run: (cwd) => git.commit(cwd, 'Remember me', 'Adds the remember-me line.') },
  commitAmendKeepsMessage: { run: (cwd) => git.commit(cwd, '', '', { amend: true }) },
  commitSignoff: { run: (cwd) => git.commit(cwd, 'Signed', '', { signoff: true }) },
  createBranch: { run: (cwd) => git.createBranch(cwd, 'topic') },
  createBranchFromTag: { setup: clean, run: (cwd) => git.createBranch(cwd, 'from-tag', 'v1.0.0') },
  checkout: { setup: clean, run: (cwd) => git.checkout(cwd, 'feature/login') },
  checkoutRejectsDirtyConflict: {
    setup: (raw, cwd) => clean(raw).then(() => put(cwd, 'login.txt', 'local edit\n')),
    run: (cwd) => git.checkout(cwd, 'v1.0.0'),
  },
  stash: { run: (cwd) => git.stash(cwd, 'park it') },
  stashPop: { setup: clean, run: (cwd) => git.stashPop(cwd) },
  stashApplyByHash: {
    setup: clean,
    run: async (cwd) => git.stashAction(cwd, (await git.refs(cwd)).stashes[0].hash ?? '', 'apply'),
  },
  stashDropByHash: { run: async (cwd) => git.stashAction(cwd, (await git.refs(cwd)).stashes[0].hash ?? '', 'drop') },
  stashRejectsBadHash: { run: (cwd) => git.stashAction(cwd, 'not-a-hash', 'drop') },
  stashRename: { run: (cwd) => git.stashRename(cwd, 'stash@{0}', 'renamed stash') },
  stashRenameOlder: {
    setup: (raw) => raw('stash', 'push', '--quiet', '--include-untracked', '-m', 'newer'),
    run: (cwd) => git.stashRename(cwd, 'stash@{1}', 'renamed older'),
  },
  stashRenameNewestOfTwo: {
    setup: (raw) => raw('stash', 'push', '--quiet', '--include-untracked', '-m', 'newer'),
    run: (cwd) => git.stashRename(cwd, 'stash@{0}', 'renamed newer'),
  },
  stashDetail: { run: (cwd) => git.stashDetail(cwd, 'stash@{0}') },
  stashDiff: { run: (cwd) => git.stashDiff(cwd, 'stash@{0}') },
  resetSoft: { run: (cwd) => git.reset(cwd, 'HEAD~1', 'soft') },
  resetMixed: { run: (cwd) => git.reset(cwd, 'HEAD~1', 'mixed') },
  resetHard: { run: (cwd) => git.reset(cwd, 'v1.0.0', 'hard') },
  cherryPick: {
    setup: async (raw) => {
      await clean(raw);
      await raw('checkout', '--quiet', '-b', 'pick', 'v1.0.0');
    },
    run: async (cwd) => git.cherryPick(cwd, (await rawGit(cwd)('rev-parse', 'main~1')).trim()),
  },
  revert: { setup: clean, run: (cwd) => git.revert(cwd, 'HEAD^2') },
  rebaseOnto: {
    setup: async (raw, cwd) => {
      await clean(raw);
      await raw('checkout', '--quiet', '-b', 'topic', 'v1.0.0');
      await put(cwd, 'topic.txt', 'topic\n');
      await raw('add', 'topic.txt');
      await raw('commit', '--quiet', '-m', 'Topic work');
    },
    run: (cwd) => git.rebaseOnto(cwd, 'main'),
  },
  mergeNoFf: {
    setup: async (raw, cwd) => {
      await clean(raw);
      await raw('checkout', '--quiet', '-b', 'side');
      await put(cwd, 'side.txt', 'side\n');
      await raw('add', 'side.txt');
      await raw('commit', '--quiet', '-m', 'Side work');
      await raw('checkout', '--quiet', 'main');
    },
    run: (cwd) => git.merge(cwd, 'side'),
  },
  mergeConflict: {
    setup: async (raw, cwd) => {
      await conflict(raw, cwd);
      await raw('merge', '--abort');
    },
    run: (cwd) => git.merge(cwd, 'clash'),
  },
  resolveOursThenContinue: {
    setup: conflict,
    run: async (cwd) => {
      await git.resolveFile(cwd, 'README.md', 'ours');
      return git.opContinue(cwd, 'merge', 'Merge clash, keep main');
    },
  },
  resolveTheirs: { setup: conflict, run: (cwd) => git.resolveFile(cwd, 'README.md', 'theirs') },
  opAbort: { setup: conflict, run: (cwd) => git.opAbort(cwd, 'merge') },
  createTag: { run: (cwd) => git.createTag(cwd, 'v2.0.0', 'HEAD') },
  createAnnotatedTag: { run: (cwd) => git.createAnnotatedTag(cwd, 'v2.0.1', 'HEAD', 'Second release') },
  tagCommit: { run: (cwd) => git.tagCommit(cwd, 'v1.0.1') },
  branchAt: { setup: clean, run: (cwd) => git.branchAt(cwd, 'at-tag', 'v1.0.0') },
  deleteMergedBranch: { run: (cwd) => git.deleteBranch(cwd, 'feature/login') },
  deleteCurrentBranchFails: { run: (cwd) => git.deleteBranch(cwd, 'main') },
  deleteUnmergedBranchFails: {
    setup: async (raw, cwd) => {
      await clean(raw);
      await raw('checkout', '--quiet', '-b', 'loose');
      await put(cwd, 'loose.txt', 'loose\n');
      await raw('add', 'loose.txt');
      await raw('commit', '--quiet', '-m', 'Loose');
      await raw('checkout', '--quiet', 'main');
    },
    run: (cwd) => git.deleteBranch(cwd, 'loose'),
  },
  forceDeleteBranch: {
    setup: async (raw, cwd) => {
      await clean(raw);
      await raw('checkout', '--quiet', '-b', 'loose');
      await put(cwd, 'loose.txt', 'loose\n');
      await raw('add', 'loose.txt');
      await raw('commit', '--quiet', '-m', 'Loose');
      await raw('checkout', '--quiet', 'main');
    },
    run: (cwd) => git.deleteBranch(cwd, 'loose', true),
  },
  setCommitIdentity: {
    run: async (cwd) => {
      await git.setCommitIdentity(cwd, 'Katherine Johnson', 'katherine@example.com');
      return git.commitIdentity(cwd);
    },
  },
  setCommitIdentityRejectsBadEmail: { run: (cwd) => git.setCommitIdentity(cwd, 'Name', 'not an email') },
  fileAt: { run: (cwd) => git.fileAt(cwd, 'v1.0.0', 'app.txt') },
  formatPatch: { run: async (cwd) => withoutGitVersion(await git.formatPatch(cwd, 'v1.0.0')) },
  readWorkFile: { run: (cwd) => git.readWorkFile(cwd, 'app.txt') },
  writeWorkFile: { run: (cwd) => git.writeWorkFile(cwd, 'app.txt', 'rewritten\n') },
  readWorkFileRejectsEscape: { run: (cwd) => git.readWorkFile(cwd, '../outside.txt') },
  remoteUrlMissing: { run: (cwd) => git.remoteUrl(cwd) },
  pushPullFetchWithLocalRemote: {
    setup: async (raw, cwd) => {
      await clean(raw);
      await raw('init', '--quiet', '--bare', `${cwd}-origin.git`);
      await raw('remote', 'add', 'origin', `${cwd}-origin.git`);
      await raw('push', '--quiet', '-u', 'origin', 'main');
    },
    run: async (cwd) => {
      await put(cwd, 'pushed.txt', 'pushed\n');
      await git.stage(cwd, ['pushed.txt']);
      await git.commit(cwd, 'Pushed change');
      await git.push(cwd);
      await git.fetch(cwd);
      await git.pull(cwd, 'ff-only');
      return git.remoteUrl(cwd);
    },
  },
};

const snapshot = async (cwd: string) => ({
  status: await git.status(cwd),
  refs: await git.refs(cwd),
  log: (await git.log(cwd)).map(({ hash, parents, subject }) => ({ hash, parents, subject })),
  operation: await git.opState(cwd),
});

for (const [name, scenario] of Object.entries(SCENARIOS)) {
  test(`write scenario: ${name}`, async (t) => {
    const cwd = await realpath(await mkdtemp(path.join(tmpdir(), 'gitverse-write-')));
    t.after(async () => {
      await rm(cwd, { recursive: true, force: true });
      await rm(`${cwd}-origin.git`, { recursive: true, force: true });
    });
    const prevEnv = { ...process.env };
    Object.assign(process.env, isolatedEnv(cwd));
    t.after(() => {
      process.env = prevEnv;
    });
    const { git: raw } = await buildRepo(cwd);
    await scenario.setup?.(raw, cwd);
    Object.assign(process.env, OPERATION_ENV);
    let outcome: { result: unknown } | { error: string };
    try {
      outcome = { result: (await scenario.run(cwd)) ?? null };
    } catch (error) {
      outcome = { error: (error as Error).message };
    }
    await golden(`write/${name}`, { ...outcome, after: await snapshot(cwd) }, cwd);
  });
}
