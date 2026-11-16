/**
 * Golden contract tests for the read-side Git API.
 *
 * Builds a fully deterministic repository (fixed authors, dates and branch names, so commit hashes
 * never change), runs each read operation, and compares the JSON result with
 * fixtures/git-contract/<name>.json. The Rust/Tauri backend must reproduce the same JSON, so these
 * fixtures are the parity target for the migration (docs/rust-migration/).
 *
 * Regenerate after an intentional change:  UPDATE_FIXTURES=1 npm test
 */
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  commitDetail,
  commitFileDiff,
  fileBlame,
  fileChangeCounts,
  fileHistory,
  historyPosition,
  log,
  opState,
  refs,
  status,
  workingFileDiff,
} from './git';
import { reflog } from './reflog';
import { buildRepo, golden, isolatedEnv } from './contractRepo';

test('read-side Git API matches the golden contract fixtures', async (t) => {
  const cwd = await realpath(await mkdtemp(path.join(tmpdir(), 'gitverse-contract-')));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const prevEnv = { ...process.env };
  // git.ts spawns git with process.env; keep it deterministic and isolated from the user's config
  Object.assign(process.env, isolatedEnv(cwd));
  t.after(() => {
    process.env = prevEnv;
  });
  const { head } = await buildRepo(cwd);

  await golden('log', await log(cwd), cwd);
  await golden('status', await status(cwd), cwd);
  await golden('refs', await refs(cwd), cwd);
  await golden('reflog', await reflog(cwd), cwd);
  await golden('commitDetail', await commitDetail(cwd, head), cwd);
  await golden('fileChangeCounts', await fileChangeCounts(cwd), cwd);
  await golden('fileBlame', await fileBlame(cwd, head, 'app.txt'), cwd);
  await golden('fileHistory', await fileHistory(cwd, head, 'app.txt'), cwd);
  await golden('opState', await opState(cwd), cwd);
  await golden('historyPosition', await historyPosition(cwd, head), cwd);
  await golden('commitFileDiff', await commitFileDiff(cwd, head, 'login.txt'), cwd);
  await golden(
    'workingFileDiff',
    {
      staged: await workingFileDiff(cwd, 'login.txt', 'staged'),
      unstaged: await workingFileDiff(cwd, 'app.txt', 'unstaged'),
      deleted: await workingFileDiff(cwd, 'README.md', 'unstaged'),
      untracked: await workingFileDiff(cwd, 'notes.md', 'untracked'),
    },
    cwd,
  );
});
