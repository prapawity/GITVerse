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
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { commitDetail, fileBlame, fileChangeCounts, fileHistory, log, opState, refs, status } from './git';
import { reflog } from './reflog';

const run = promisify(execFile);
const FIXTURES = path.resolve(__dirname, '../../fixtures/git-contract');
const UPDATE = process.env.UPDATE_FIXTURES === '1';

let clock = 1_700_000_000;
const identity = () => {
  clock += 60;
  const date = `${clock} +0700`;
  return {
    GIT_AUTHOR_NAME: 'Ada Lovelace',
    GIT_AUTHOR_EMAIL: 'ada@example.com',
    GIT_COMMITTER_NAME: 'Ada Lovelace',
    GIT_COMMITTER_EMAIL: 'ada@example.com',
    GIT_AUTHOR_DATE: date,
    GIT_COMMITTER_DATE: date,
  };
};

async function buildRepo(cwd: string) {
  const git = async (...args: string[]) =>
    (
      await run(
        'git',
        ['-c', 'commit.gpgsign=false', '-c', 'tag.gpgsign=false', '-c', 'core.autocrlf=false', ...args],
        {
          cwd,
          env: { ...process.env, ...identity(), GIT_CONFIG_NOSYSTEM: '1', HOME: cwd },
        },
      )
    ).stdout.trim();
  const put = (file: string, text: string) => writeFile(path.join(cwd, file), text);

  await git('init', '--quiet', '--initial-branch=main');
  await put('README.md', '# Demo\n\nline one\n');
  await put('app.txt', 'alpha\nbeta\ngamma\n');
  await git('add', '.');
  await git('commit', '--quiet', '-m', 'Initial commit');
  await put('app.txt', 'alpha\nbeta changed\ngamma\ndelta\n');
  await git('commit', '--quiet', '-am', 'Change app\n\nLonger body line.');
  await git('tag', 'v1.0.0');
  await git('tag', '-a', 'v1.0.1', '-m', 'Annotated release');

  await git('checkout', '--quiet', '-b', 'feature/login');
  await put('login.txt', 'login form\n');
  await git('add', 'login.txt');
  await git('commit', '--quiet', '-m', 'Add login');
  await git('checkout', '--quiet', 'main');
  await put('README.md', '# Demo\n\nline one\nline two\n');
  await git('commit', '--quiet', '-am', 'Update readme');
  await git('merge', '--quiet', '--no-ff', '-m', "Merge branch 'feature/login'", 'feature/login');

  await put('app.txt', 'alpha\nstashed\n');
  await git('stash', 'push', '--quiet', '-m', 'wip on app');

  // working tree: one staged, one modified, one untracked, one deleted
  await put('login.txt', 'login form\nremember me\n');
  await git('add', 'login.txt');
  await put('app.txt', 'alpha\nbeta changed\ngamma\ndelta\nepsilon\n');
  await put('notes.md', 'todo\n');
  await rm(path.join(cwd, 'README.md'));
  return { head: await git('rev-parse', 'HEAD') };
}

/** Make results machine-independent: temp paths become <repo>, and key order is stable. */
function normalize(value: unknown, repo: string): unknown {
  const text = JSON.stringify(value, (_k, v) => (typeof v === 'string' ? v.split(repo).join('<repo>') : v), 2);
  return JSON.parse(text);
}

async function golden(name: string, value: unknown, repo: string) {
  const file = path.join(FIXTURES, `${name}.json`);
  const actual = normalize(value, repo);
  if (UPDATE || !existsSync(file)) {
    await mkdir(FIXTURES, { recursive: true });
    await writeFile(file, JSON.stringify(actual, null, 2) + '\n');
    return;
  }
  assert.deepEqual(actual, JSON.parse(await readFile(file, 'utf8')), `${name} no longer matches ${file}`);
}

test('read-side Git API matches the golden contract fixtures', async (t) => {
  const cwd = await realpath(await mkdtemp(path.join(tmpdir(), 'gitverse-contract-')));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const prevEnv = { ...process.env };
  // git.ts spawns git with process.env; keep it deterministic and isolated from the user's config
  Object.assign(process.env, { GIT_CONFIG_NOSYSTEM: '1', HOME: cwd, LC_ALL: 'C', TZ: 'UTC' });
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
});
