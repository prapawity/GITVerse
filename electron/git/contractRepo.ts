/**
 * Shared harness for the golden contract tests (read: contract.golden.test.ts, write:
 * contract.write.test.ts). The Rust backend rebuilds the same repository in
 * src-tauri/core/tests/ and must produce the same JSON as fixtures/git-contract/.
 */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);
export const FIXTURES = path.resolve(__dirname, '../../fixtures/git-contract');
const UPDATE = process.env.UPDATE_FIXTURES === '1';

/** Identity and fixed clock for commits made by the code under test (not by the repo builder). */
export const OPERATION_ENV = {
  GIT_AUTHOR_NAME: 'Grace Hopper',
  GIT_AUTHOR_EMAIL: 'grace@example.com',
  GIT_COMMITTER_NAME: 'Grace Hopper',
  GIT_COMMITTER_EMAIL: 'grace@example.com',
  GIT_AUTHOR_DATE: '1700100000 +0700',
  GIT_COMMITTER_DATE: '1700100000 +0700',
};

/** Isolate git from the machine: no system/user config, C locale, UTC. */
export const isolatedEnv = (cwd: string) => ({ GIT_CONFIG_NOSYSTEM: '1', HOME: cwd, LC_ALL: 'C', TZ: 'UTC' });

/** Raw git for test setup, with its own advancing clock so hashes never change. */
export function rawGit(cwd: string) {
  let clock = 1_700_000_000;
  return async (...args: string[]) => {
    clock += 60;
    const date = `${clock} +0700`;
    const { stdout } = await run(
      'git',
      ['-c', 'commit.gpgsign=false', '-c', 'tag.gpgsign=false', '-c', 'core.autocrlf=false', ...args],
      {
        cwd,
        env: {
          ...process.env,
          GIT_AUTHOR_NAME: 'Ada Lovelace',
          GIT_AUTHOR_EMAIL: 'ada@example.com',
          GIT_COMMITTER_NAME: 'Ada Lovelace',
          GIT_COMMITTER_EMAIL: 'ada@example.com',
          GIT_AUTHOR_DATE: date,
          GIT_COMMITTER_DATE: date,
          GIT_CONFIG_NOSYSTEM: '1',
          HOME: cwd,
        },
      },
    );
    return stdout.trim();
  };
}

/** Must stay identical to build_repo() in src-tauri/core/tests/support/mod.rs. */
export async function buildRepo(cwd: string) {
  const git = rawGit(cwd);
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
  return { head: await git('rev-parse', 'HEAD'), git };
}

/** Make results machine-independent: temp paths (either slash style) become <repo>. */
export function normalize(value: unknown, repo: string): unknown {
  const forms = [repo, repo.split(path.sep).join('/')];
  const text = JSON.stringify(
    value,
    (_k, v) => (typeof v === 'string' ? forms.reduce((s, form) => s.split(form).join('<repo>'), v) : v),
    2,
  );
  return JSON.parse(text);
}

export async function golden(name: string, value: unknown, repo: string) {
  const file = path.join(FIXTURES, `${name}.json`);
  const actual = normalize(value, repo);
  if (UPDATE || !existsSync(file)) {
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, JSON.stringify(actual, null, 2) + '\n');
    return;
  }
  assert.deepEqual(actual, JSON.parse(await readFile(file, 'utf8')), `${name} no longer matches ${file}`);
}
