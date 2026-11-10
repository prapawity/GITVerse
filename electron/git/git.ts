import { execFile, spawn } from 'node:child_process';
import { constants as fsConstants } from 'node:fs';
import { access, lstat, mkdtemp, open, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import type { Commit, FileChangeCount, FileStatus, RefLabel, StashDetail, StashRef } from '../../src/shared/types';

const run = promisify(execFile);

export async function clone(url: string, destination: string, progress: (message: string) => void): Promise<void> {
  if (typeof url !== 'string' || /[\s\0]/.test(url) || !url || url.startsWith('-'))
    throw new Error('Enter a valid HTTPS or SSH repository URL.');
  const scp = !url.includes('://') && /^(?:[a-zA-Z0-9._-]+@)?[a-zA-Z0-9.-]+:.+/.test(url);
  if (!scp) {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new Error('Enter a valid HTTPS or SSH repository URL.');
    }
    if (
      !['https:', 'ssh:'].includes(parsed.protocol) ||
      !parsed.hostname ||
      !parsed.pathname ||
      (parsed.protocol === 'https:' && (parsed.username || parsed.password)) ||
      parsed.password
    ) {
      throw new Error('Use an HTTPS or SSH repository URL without embedded credentials.');
    }
  }
  if (
    typeof destination !== 'string' ||
    !path.isAbsolute(destination) ||
    destination.includes('\0') ||
    path.resolve(destination) === path.parse(destination).root
  )
    throw new Error('Enter an absolute destination folder path.');
  try {
    await access(destination);
    throw new Error('Destination already exists. Choose a new folder path.');
  } catch (error: any) {
    if (error.code !== 'ENOENT') throw error;
  }
  await access(path.dirname(destination)).catch(() => {
    throw new Error('The destination parent folder does not exist or cannot be accessed.');
  });
  await new Promise<void>((resolve, reject) => {
    const child = spawn('git', ['clone', '--progress', '--', url, destination], {
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: '0',
        GIT_SSH_COMMAND: process.env.GIT_SSH_COMMAND || 'ssh -o BatchMode=yes',
      },
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let output = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      output = (output + chunk).slice(-16000);
      const line = chunk
        .split(/[\r\n]+/)
        .filter(Boolean)
        .pop();
      if (line) progress(line);
    });
    child.on('error', (error) => reject(new Error(`Could not start Git: ${error.message}`)));
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(output.trim() || `Git clone failed (exit ${code ?? 'unknown'}).`));
    });
  });
}
let activeIdentity: { name: string; email: string } | null = null;
export function setActiveIdentity(identity: { name: string; email: string } | null) {
  if (
    identity &&
    (!identity.name.trim() ||
      !/^[^\s@<>]+@[^\s@<>]+$/.test(identity.email.trim()) ||
      /[\r\n<>\0]/.test(identity.name + identity.email))
  )
    throw new Error('Enter a valid name and email.');
  activeIdentity = identity ? { name: identity.name.trim(), email: identity.email.trim() } : null;
}

async function git(cwd: string, args: string[], env?: Record<string, string>): Promise<string> {
  try {
    const config = activeIdentity
      ? ['-c', `user.name=${activeIdentity.name}`, '-c', `user.email=${activeIdentity.email}`]
      : [];
    const { stdout } = await run('git', [...config, ...args], {
      cwd,
      maxBuffer: 256 * 1024 * 1024,
      env: env ? { ...process.env, ...env } : process.env,
    });
    return stdout;
  } catch (e: any) {
    // git reports some failures (e.g. rebase --continue) on stdout, so fall back to it before the generic message
    throw new Error(e.stderr?.toString().trim() || e.stdout?.toString().trim() || e.message, { cause: e });
  }
}

async function gitWithInput(cwd: string, args: string[], input: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, { cwd, env: process.env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => (stdout = (stdout + chunk).slice(-1024 * 1024)));
    child.stderr.on('data', (chunk: string) => (stderr = (stderr + chunk).slice(-1024 * 1024)));
    child.on('error', (error) => reject(new Error(`Could not start Git: ${error.message}`)));
    child.on('close', (code) =>
      code === 0 ? resolve(stdout) : reject(new Error(stderr.trim() || `Git failed (exit ${code ?? 'unknown'}).`)),
    );
    child.stdin.end(input);
  });
}

const isRemoteHeadAlias = (name: string) => /^[^/]+\/HEAD$/.test(name);

function parseRefs(decoration: string): RefLabel[] {
  if (!decoration.trim()) return [];
  return decoration
    .split(', ')
    .filter((raw) => !raw.startsWith('refs/remotes/') || !isRemoteHeadAlias(raw.slice(13)))
    .map((raw): RefLabel => {
      if (raw.startsWith('HEAD -> refs/heads/')) return { name: raw.slice(19), kind: 'local', current: true };
      if (raw === 'HEAD') return { name: 'HEAD', kind: 'head', current: true };
      if (raw.startsWith('tag: refs/tags/')) return { name: raw.slice(15), kind: 'tag' };
      if (raw.startsWith('refs/heads/')) return { name: raw.slice(11), kind: 'local' };
      if (raw.startsWith('refs/remotes/')) return { name: raw.slice(13), kind: 'remote' };
      return { name: raw, kind: 'head' };
    });
}

const F = '\x1f';
const R = '\x1e';

export async function log(cwd: string, limit = 400, skip = 0): Promise<Commit[]> {
  const fmt = ['%H', '%P', '%D', '%an', '%ae', '%aI', '%s', '%b'].join('%x1f') + '%x1e';
  const hasHead = await git(cwd, ['rev-parse', '--verify', 'HEAD']).then(
    () => true,
    () => false,
  );
  const out = await git(cwd, [
    'log',
    '--branches',
    '--remotes',
    '--tags',
    '--topo-order',
    '--decorate=full',
    `--skip=${skip}`,
    `-n${limit}`,
    `--format=${fmt}`,
    ...(hasHead ? ['HEAD'] : []),
  ]);
  return out
    .split(R)
    .map((r) => r.trim())
    .filter(Boolean)
    .map((r) => {
      const [hash, parents, refs, author, email, date, subject, body = ''] = r.split(F);
      const first = body
        .split('\n')
        .map((l) => l.trim())
        .find(Boolean);
      return {
        hash,
        parents: parents ? parents.split(' ') : [],
        refs: parseRefs(refs),
        author,
        email,
        date,
        subject,
        body: first,
      };
    });
}

export async function status(cwd: string): Promise<FileStatus[]> {
  const out = await git(cwd, ['status', '--porcelain=v1', '-z', '--untracked-files=all']);
  const parts = out.split('\0').filter(Boolean);
  const files: FileStatus[] = [];
  for (let i = 0; i < parts.length; i++) {
    const e = parts[i];
    const oldPath = e[0] === 'R' || e[0] === 'C' ? parts[++i] : undefined;
    files.push({ index: e[0], worktree: e[1], path: e.slice(3), ...(oldPath ? { oldPath } : {}) });
  }
  return files;
}

export async function commit(
  cwd: string,
  summary: string,
  description = '',
  opts: { amend?: boolean; signoff?: boolean; gpgSign?: boolean } = {},
) {
  const args =
    opts.amend && !summary.trim() && !description.trim() ? ['commit', '--no-edit'] : ['commit', '-m', summary];
  if (description.trim()) args.push('-m', description);
  if (opts.amend) args.push('--amend');
  if (opts.signoff) args.push('--signoff');
  if (opts.gpgSign) args.push('-S');
  return git(cwd, args);
}

export async function stagedForCommitMessage(cwd: string) {
  const tree = (await git(cwd, ['write-tree'])).trim();
  const diff = await git(cwd, [
    'diff',
    '--cached',
    '--no-ext-diff',
    '--no-textconv',
    '--no-color',
    '--find-renames',
    '--',
  ]);
  if (!diff.trim()) throw new Error('Stage changes before generating a commit message.');
  if (diff.length > 150000)
    throw new Error('The staged diff is too large to send to AI. Stage fewer changes and try again.');
  if ((await git(cwd, ['write-tree'])).trim() !== tree)
    throw new Error('Staged changes changed while preparing the diff. Try again.');
  return { tree, diff };
}
function windowsPathBlocker(action: string, ref: string, paths: string[]) {
  const examples = paths.slice(0, 6).map((filePath) => `'${filePath}'`).join('\n');
  const more = paths.length > 6 ? `\n…and ${paths.length - 6} more.` : '';
  return `Cannot ${action} ${ref} on Windows because the target tree contains unsupported file names:\n${examples}${more}\nAsk the repository owner to rename these paths. No repository state was changed.`;
}

async function ensureTargetTreeSupported(cwd: string, ref: string, action: string) {
  const allUnsupported = await unsupportedTreePaths(cwd, ref);
  const unsupported = await sparseExcludedUnsupportedPaths(cwd, allUnsupported);
  if (unsupported.length) throw new Error(windowsPathBlocker(action, ref, unsupported));
}

export async function checkout(cwd: string, ref: string) {
  if (process.platform === 'win32') {
    const target = (await git(cwd, ['rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`])).trim();
    await ensureTargetTreeSupported(cwd, target, 'check out');
  }
  return git(cwd, ['checkout', ref]);
}

/* eslint-disable no-control-regex */
export function windowsIncompatiblePaths(paths: string[]) {
  const reservedDevice = /^(?:CON|PRN|AUX|NUL|COM[1-9¹²³]|LPT[1-9¹²³])(?:\..*)?$/i;
  return paths.filter((filePath) =>
    filePath.split('/').some((part) => /[<>:"|?*\x00-\x1f]/.test(part) || /[ .]$/.test(part) || reservedDevice.test(part)),
  );
}
/* eslint-enable no-control-regex */

async function unsupportedTreePaths(cwd: string, ref: string) {
  if (process.platform !== 'win32') return [];
  const treePaths = (await git(cwd, ['ls-tree', '-r', '-z', '--name-only', ref])).split('\0').filter(Boolean);
  return windowsIncompatiblePaths(treePaths);
}

function sparseExcludePattern(filePath: string) {
  if (/[\r\n\0]/.test(filePath)) throw new Error('Cannot safely exclude a path containing a line break from sparse checkout.');
  const escaped = filePath.replace(/[\\*?[\]]/g, '\\$&').replace(/ +$/, (spaces) => [...spaces].map(() => '\\ ').join(''));
  return `!/${escaped}`;
}

async function sparseCheckoutPatterns(cwd: string) {
  const enabled = (await git(cwd, ['config', '--bool', 'core.sparseCheckout']).catch(() => 'false')).trim() === 'true';
  if (!enabled) return { enabled: false, patterns: ['/*'] };
  const infoPath = (await git(cwd, ['rev-parse', '--git-path', 'info/sparse-checkout'])).trim();
  const filePath = path.resolve(cwd, infoPath);
  const contents = await readFile(filePath, 'utf8').catch(() => '');
  const patterns = contents.split(/\r?\n/).filter(Boolean);
  if (!patterns.length)
    throw new Error('Existing sparse-checkout rules could not be read. Review the repository sparse-checkout settings before continuing.');
  return { enabled: true, patterns };
}

async function sparseExcludedUnsupportedPaths(cwd: string, paths: string[]) {
  if (!paths.length || process.platform !== 'win32') return [];
  const { enabled, patterns } = await sparseCheckoutPatterns(cwd);
  if (!enabled) return [];
  const rules = new Set(patterns);
  return paths.filter((filePath) => !rules.has(sparseExcludePattern(filePath)));
}

export async function windowsUnsupportedPathsForRef(cwd: string, ref: string) {
  const slash = ref.indexOf('/');
  if (slash < 1 || slash === ref.length - 1) throw new Error('Invalid remote branch.');
  const remoteRef = `refs/remotes/${ref}`;
  await git(cwd, ['show-ref', '--verify', '--quiet', remoteRef]);
  const paths = await unsupportedTreePaths(cwd, remoteRef);
  return sparseExcludedUnsupportedPaths(cwd, paths);
}

async function enableWindowsSparseCheckout(cwd: string, paths: string[]) {
  if (process.platform !== 'win32' || !paths.length) return;
  const { patterns } = await sparseCheckoutPatterns(cwd);
  const next = [...patterns];
  const known = new Set(next);
  for (const filePath of paths) {
    const pattern = sparseExcludePattern(filePath);
    if (!known.has(pattern)) {
      known.add(pattern);
      next.push(pattern);
    }
  }
  await gitWithInput(cwd, ['sparse-checkout', 'set', '--no-cone', '--stdin'], `${next.join('\n')}\n`);
}

async function prepareWindowsSparsePaths(
  cwd: string,
  ref: string,
  allowSparse: boolean,
  expectedUnsupported?: string[],
) {
  const unsupported = await unsupportedTreePaths(cwd, ref);
  const unexcluded = await sparseExcludedUnsupportedPaths(cwd, unsupported);
  if (expectedUnsupported) {
    const expected = [...expectedUnsupported].sort();
    const actual = [...unexcluded].sort();
    if (expected.length !== actual.length || expected.some((filePath, index) => filePath !== actual[index]))
      throw new Error('The remote branch changed while confirmation was open. Refresh and retry so you can review the files sparse checkout would omit.');
  }
  if (unexcluded.length && !allowSparse)
    throw new Error(windowsPathBlocker('check out', ref, unexcluded));
  if (unexcluded.length) {
    const changes = await git(cwd, ['status', '--porcelain', '--untracked-files=all']);
    if (changes.trim())
      throw new Error('Cannot enable sparse checkout while the index or working tree has local changes. Commit or stash them first. No repository state was changed.');
    await enableWindowsSparseCheckout(cwd, unexcluded);
  }
  return unexcluded;
}

async function ensureFastForwardSafe(cwd: string, branch: string, ref: string) {
  const [allUnsupported, changes] = await Promise.all([
    unsupportedTreePaths(cwd, ref),
    git(cwd, ['status', '--porcelain', '--untracked-files=all']),
  ]);
  const unsupported = await sparseExcludedUnsupportedPaths(cwd, allUnsupported);
  const reasons: string[] = [];
  if (unsupported.length) {
    const examples = unsupported.slice(0, 6).map((filePath) => `'${filePath}'`).join('\n');
    const more = unsupported.length > 6 ? `\n…and ${unsupported.length - 6} more.` : '';
    reasons.push(
      `Windows cannot create file names in ${ref}:\n${examples}${more}\nAsk the repository owner to rename these paths.`,
    );
  }
  if (changes.trim()) reasons.push(`The index or working tree has local changes. Commit or stash them before fast-forwarding ${branch}.`);
  if (reasons.length)
    throw new Error(`Cannot align ${branch} with ${ref} yet:\n\n${reasons.join('\n\n')}\n\nYour local branch and work have been preserved.`);
}

async function ensureBranchNotCheckedOutElsewhere(cwd: string, branch: string) {
  const activeRoot = (await realpath(cwd)).toLowerCase();
  const rows = (await git(cwd, ['worktree', 'list', '--porcelain'])).split('\n\n');
  for (const row of rows) {
    const worktree = /^worktree (.+)$/m.exec(row)?.[1];
    const checkedOutBranch = /^branch refs\/heads\/(.+)$/m.exec(row)?.[1];
    if (worktree && checkedOutBranch === branch && path.resolve(worktree).toLowerCase() !== activeRoot)
      throw new Error(`Cannot check out ${branch}: it is already checked out in another worktree (${worktree}).`);
  }
}

export async function checkoutRemote(
  cwd: string,
  ref: string,
  allowWindowsSparse = false,
  expectedUnsupported?: string[],
) {
  const slash = ref.indexOf('/');
  if (slash < 1 || slash === ref.length - 1) throw new Error('Invalid remote branch.');
  const remoteRef = `refs/remotes/${ref}`;
  await git(cwd, ['show-ref', '--verify', '--quiet', remoteRef]);
  const name = ref.slice(slash + 1);
  const branches = (await git(cwd, ['for-each-ref', '--format=%(refname:lstrip=2)%09%(upstream)', 'refs/heads/']))
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [branch, upstream] = line.split('\t');
      return { branch, upstream };
    });
  const tracking = branches.filter((branch) => branch.upstream === remoteRef);
  const matching = tracking.find((branch) => branch.branch === name);
  if (!matching && tracking.length > 1)
    throw new Error(`Multiple local branches track ${ref}. Select the local branch to check out.`);
  const existing = matching ?? tracking[0] ?? branches.find((branch) => branch.branch === name);
  if (existing) {
    if (existing.upstream && existing.upstream !== remoteRef)
      throw new Error(
        `Local branch ${existing.branch} tracks a different remote branch. Select a local branch instead.`,
      );
    const localRef = `refs/heads/${existing.branch}`;
    await ensureBranchNotCheckedOutElsewhere(cwd, existing.branch);
    const [localHash, remoteHash] = await Promise.all([
      git(cwd, ['rev-parse', '--verify', localRef]).then((value) => value.trim()),
      git(cwd, ['rev-parse', '--verify', remoteRef]).then((value) => value.trim()),
    ]);
    const currentBranch = (await git(cwd, ['symbolic-ref', '--quiet', '--short', 'HEAD']).catch(() => '')).trim();
    if (localHash === remoteHash && currentBranch === existing.branch) {
      await prepareWindowsSparsePaths(cwd, remoteRef, allowWindowsSparse, expectedUnsupported);
      return existing.branch;
    }
    const behind = localHash !== remoteHash && await git(cwd, ['merge-base', '--is-ancestor', localRef, remoteRef]).then(
      () => true,
      () => false,
    );
    if (localHash !== remoteHash && !behind) {
      const ahead = await git(cwd, ['merge-base', '--is-ancestor', remoteRef, localRef]).then(
        () => true,
        () => false,
      );
      throw new Error(
        ahead
          ? `Cannot align ${existing.branch} with ${ref}: the local branch has commits that are not on the remote. They were preserved.`
          : `Cannot align ${existing.branch} with ${ref}: the branches have diverged. Local commits were preserved.`,
      );
    }
    if (behind) {
      await prepareWindowsSparsePaths(cwd, remoteRef, allowWindowsSparse, expectedUnsupported);
      await ensureFastForwardSafe(cwd, existing.branch, remoteRef);
    } else {
      await prepareWindowsSparsePaths(cwd, remoteRef, allowWindowsSparse, expectedUnsupported);
      await ensureTargetTreeSupported(cwd, remoteRef, 'check out');
    }
    await git(cwd, ['switch', '--', existing.branch]);
    if (behind) await git(cwd, ['merge', '--ff-only', remoteRef]);
    if (!existing.upstream) await git(cwd, ['branch', `--set-upstream-to=${remoteRef}`, existing.branch]);
    return existing.branch;
  }
  await prepareWindowsSparsePaths(cwd, remoteRef, allowWindowsSparse, expectedUnsupported);
  await ensureTargetTreeSupported(cwd, remoteRef, 'check out');
  await git(cwd, ['switch', '--track', '-c', name, '--', remoteRef]);
  return name;
}
const conflicted = (f: FileStatus) => ['DD', 'AU', 'UD', 'UA', 'DU', 'AA', 'UU'].includes(f.index + f.worktree);
export async function stage(cwd: string, paths: string[]) {
  if (!paths.length) throw new Error('No files selected.');
  const files = await status(cwd);
  if (paths.some((p) => !files.some((f) => f.path === p && !conflicted(f) && (f.worktree !== ' ' || f.index === '?'))))
    throw new Error('Some files changed or have conflicts. Refresh and review them first.');
  return git(cwd, ['--literal-pathspecs', 'add', '--', ...paths]);
}
export async function unstage(cwd: string, paths: string[]) {
  if (!paths.length) throw new Error('No files selected.');
  const files = await status(cwd);
  const selected = paths.map((p) =>
    files.find((f) => f.path === p && f.index !== ' ' && f.index !== '?' && !conflicted(f)),
  );
  if (selected.some((f) => !f)) throw new Error('Some files changed or have conflicts. Refresh and review them first.');
  const names = [...new Set(selected.flatMap((f) => [f!.path, ...(f!.oldPath ? [f!.oldPath] : [])]))];
  const hasHead = await git(cwd, ['rev-parse', '--verify', 'HEAD']).then(
    () => true,
    () => false,
  );
  return git(cwd, [
    '--literal-pathspecs',
    ...(hasHead ? ['restore', '--staged'] : ['rm', '--cached', '-r', '--ignore-unmatch']),
    '--',
    ...names,
  ]);
}

type IndexSnapshot = { index: Buffer | null; head: string; entries: string; flags: string };
type IndexChange = { before: IndexSnapshot; after: IndexSnapshot; label: string };
const indexHistory = new Map<string, { undo: IndexChange[]; redo: IndexChange[] }>();
const indexFile = async (cwd: string) =>
  path.resolve(cwd, (await git(cwd, ['rev-parse', '--git-path', 'index'])).trim());
const indexSnapshot = async (cwd: string, file: string): Promise<IndexSnapshot> => {
  const index = await readFile(file).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  const head = (await git(cwd, ['rev-parse', '--verify', 'HEAD']).catch(() => '')).trim();
  const entries = await git(cwd, ['ls-files', '--stage', '-v', '-z']);
  const debug = await git(cwd, ['ls-files', '--debug', '-z']);
  const flags = [...debug.matchAll(/\tflags: ([0-9a-f]+)/g)].map((match) => match[1]).join(',');
  return { index, head, entries, flags };
};
const sameIndex = (a: IndexSnapshot, b: IndexSnapshot) =>
  a.head === b.head && a.entries === b.entries && a.flags === b.flags && (a.index === null) === (b.index === null);

export async function indexUndoState(cwd: string) {
  const history = indexHistory.get(cwd);
  if (!history) return { undo: false, redo: false };
  const snapshot = await indexSnapshot(cwd, await indexFile(cwd));
  return {
    undo: !!history.undo.length && sameIndex(snapshot, history.undo[history.undo.length - 1].after),
    redo: !!history.redo.length && sameIndex(snapshot, history.redo[history.redo.length - 1].before),
  };
}

export async function trackedStage(cwd: string, action: 'stage' | 'unstage', paths: string[]) {
  if (action !== 'stage' && action !== 'unstage') throw new Error('Invalid stage action.');
  const file = await indexFile(cwd);
  const before = await indexSnapshot(cwd, file);
  await (action === 'stage' ? stage(cwd, paths) : unstage(cwd, paths));
  const after = await indexSnapshot(cwd, file);
  const history = indexHistory.get(cwd) ?? { undo: [], redo: [] };
  if (!sameIndex(before, after)) {
    history.undo.push({ before, after, label: action });
    history.undo = history.undo.slice(-20);
    history.redo = [];
    indexHistory.set(cwd, history);
  }
  return indexUndoState(cwd);
}

export async function moveIndexHistory(cwd: string, direction: 'undo' | 'redo') {
  if (direction !== 'undo' && direction !== 'redo') throw new Error('Invalid history action.');
  const history = indexHistory.get(cwd);
  const from = history?.[direction];
  if (!history || !from?.length) throw new Error('No stage or unstage action to undo or redo.');
  const change = from[from.length - 1];
  const expected = direction === 'undo' ? change.after : change.before;
  const target = direction === 'undo' ? change.before : change.after;
  const file = await indexFile(cwd);
  const lock = `${file}.lock`;
  let handle;
  let ownsLock = false;
  try {
    handle = await open(lock, 'wx', 0o666);
    ownsLock = true;
    if (!sameIndex(await indexSnapshot(cwd, file), expected))
      throw new Error('The index or HEAD changed since this action. Undo/redo was not applied.');
    if (target.index) await handle.writeFile(target.index);
    await handle.close();
    handle = undefined;
    if (target.index) await rename(lock, file);
    else {
      await rm(file, { force: true });
      await rm(lock, { force: true });
    }
  } catch (error: any) {
    if (handle) await handle.close().catch(() => {});
    if (ownsLock) await rm(lock, { force: true }).catch(() => {});
    throw error?.code === 'EEXIST' ? new Error('Git is using the index. Wait and try again.') : error;
  }
  from.pop();
  history[direction === 'undo' ? 'redo' : 'undo'].push(change);
  return indexUndoState(cwd);
}

export interface RefList {
  local: {
    name: string;
    current: boolean;
    hash: string;
    upstream?: string;
    ahead?: number;
    behind?: number;
    gone?: boolean;
  }[];
  remote: { name: string; hash: string }[];
  tags: { name: string }[];
  stashes: StashRef[];
  headHash: string | null;
}

export async function refs(cwd: string): Promise<RefList> {
  const out = await git(cwd, [
    'for-each-ref',
    '--format=%(refname)%09%(HEAD)%09%(objectname)%09%(upstream:short)%09%(upstream:track)',
    'refs/heads',
    'refs/remotes',
    'refs/tags',
  ]);
  const headHash = (await git(cwd, ['rev-parse', '--verify', 'HEAD']).catch(() => '')).trim() || null;
  const res: RefList = { local: [], remote: [], tags: [], stashes: [], headHash };
  for (const line of out.split('\n').filter(Boolean)) {
    const [ref, head, hash, upstream, track] = line.split('\t');
    if (ref.startsWith('refs/heads/'))
      res.local.push({
        name: ref.slice(11),
        current: head === '*',
        hash,
        upstream: upstream || undefined,
        ahead: Number(track?.match(/ahead (\d+)/)?.[1] ?? 0),
        behind: Number(track?.match(/behind (\d+)/)?.[1] ?? 0),
        gone: track?.includes('gone') || false,
      });
    else if (ref.startsWith('refs/remotes/')) {
      if (!isRemoteHeadAlias(ref.slice(13))) res.remote.push({ name: ref.slice(13), hash });
    } else if (ref.startsWith('refs/tags/')) res.tags.push({ name: ref.slice(10) });
  }
  res.stashes = await stashEntries(cwd);
  return res;
}

async function stashEntries(cwd: string): Promise<StashRef[]> {
  const st = await git(cwd, ['stash', 'list', '--format=%gd%x1f%H%x1f%P%x1f%an%x1f%ae%x1f%aI%x1f%gs%x1f%B%x1e']);
  return st
    .split(R)
    .map((record) => record.trim())
    .filter(Boolean)
    .map((record) => {
      const [id, hash, parents, author, email, date, reflogMessage, body] = record.split(F);
      return {
        id,
        hash,
        baseHash: parents.split(' ')[0],
        author,
        email,
        date,
        body: body.trim(),
        message: reflogMessage.replace(/^(?:On|WIP on) .+?: /, ''),
      };
    });
}

export async function agentCheckpoints(cwd: string) {
  const out = await git(cwd, [
    'for-each-ref',
    '--sort=-committerdate',
    '--format=%(refname)%09%(objectname:short)%09%(subject)',
    'refs/agents/',
  ]);
  return out
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [ref, hash, ...subject] = line.split('\t');
      return { ref, hash, subject: subject.join('\t') };
    });
}

export async function historyPosition(cwd: string, hash: string) {
  if (!/^[0-9a-f]{40,64}$/i.test(hash)) throw new Error('Invalid commit ID.');
  const hasHead = await git(cwd, ['rev-parse', '--verify', 'HEAD']).then(
    () => true,
    () => false,
  );
  const out = await git(cwd, [
    'rev-list',
    '--branches',
    '--remotes',
    '--tags',
    '--topo-order',
    ...(hasHead ? ['HEAD'] : []),
  ]);
  const index = out.split('\n').indexOf(hash);
  if (index < 0) throw new Error('This commit is no longer in the repository history. Refresh and try again.');
  return index;
}

export async function commitDetail(cwd: string, hash: string) {
  const body = (await git(cwd, ['show', '-s', '--format=%B', hash])).trim();
  const out = await git(cwd, ['show', '--name-status', '-z', '--format=', '--first-parent', hash]);
  const parts = out.split('\0').filter(Boolean);
  const files: { status: string; path: string; oldPath?: string }[] = [];
  for (let i = 0; i < parts.length;) {
    const status = parts[i++][0];
    const firstPath = parts[i++];
    if (status === 'R' || status === 'C') files.push({ status, oldPath: firstPath, path: parts[i++] });
    else files.push({ status, path: firstPath });
  }
  return { body, files };
}

export const commitFileDiff = (cwd: string, hash: string, path: string, oldPath?: string) =>
  git(cwd, [
    '--literal-pathspecs',
    'show',
    '--first-parent',
    '--format=',
    '--no-ext-diff',
    '--no-color',
    hash,
    '--',
    ...(oldPath ? [oldPath] : []),
    path,
  ]);

export async function workingFileDiff(
  cwd: string,
  filePath: string,
  area: 'staged' | 'unstaged' | 'untracked',
): Promise<string> {
  const file = (await status(cwd)).find((entry) => entry.path === filePath);
  if (!file || !['staged', 'unstaged', 'untracked'].includes(area))
    throw new Error('This file is no longer in the working changes. Refresh the list.');
  if (area === 'untracked') {
    if (file.index !== '?' || file.worktree !== '?')
      throw new Error('This file is no longer untracked. Refresh the list.');
    try {
      const { stdout } = await run(
        'git',
        ['diff', '--no-index', '--no-ext-diff', '--no-textconv', '--no-color', '--', '/dev/null', filePath],
        { cwd, maxBuffer: 256 * 1024 * 1024 },
      );
      return stdout;
    } catch (e: any) {
      if (e.code === 1 && typeof e.stdout === 'string') return e.stdout;
      throw new Error(e.stderr?.toString().trim() || e.message, { cause: e });
    }
  }
  const state = area === 'staged' ? file.index : file.worktree;
  if (state === ' ' || state === '?') throw new Error('This change is no longer available. Refresh the list.');
  return git(cwd, [
    '--literal-pathspecs',
    'diff',
    ...(area === 'staged' ? ['--cached'] : []),
    '--no-ext-diff',
    '--no-textconv',
    '--no-color',
    '--',
    ...(area === 'staged' && file.oldPath ? [file.oldPath] : []),
    filePath,
  ]);
}

export async function fileChangeCounts(cwd: string): Promise<FileChangeCount[]> {
  const files = await status(cwd);
  const readCounts = (text: string) => {
    const counts = new Map<string, number | null>();
    const records = text.split('\0');
    for (let index = 0; index < records.length; index++) {
      const record = /^([0-9]+|-)\t([0-9]+|-)\t(.*)$/s.exec(records[index]);
      if (!record) continue;
      let filePath = record[3];
      if (!filePath) {
        index++;
        filePath = records[++index];
      }
      if (filePath)
        counts.set(filePath, record[1] === '-' || record[2] === '-' ? null : Number(record[1]) + Number(record[2]));
    }
    return counts;
  };
  const args = ['diff', '--numstat', '-z', '--no-ext-diff', '--no-textconv'];
  const [staged, unstaged] = await Promise.all([
    git(cwd, [...args, '--cached', '--']).then(readCounts),
    git(cwd, [...args, '--']).then(readCounts),
  ]);
  const untracked = files.filter((file) => file.index === '?' && file.worktree === '?');
  for (let offset = 0; offset < untracked.length; offset += 8) {
    await Promise.all(
      untracked.slice(offset, offset + 8).map(async (file) => {
        const { full } = await workPath(cwd, file.path);
        if ((await lstat(full)).isDirectory()) {
          unstaged.set(file.path, null);
          return;
        }
        let output: string;
        try {
          const result = await run(
            'git',
            ['diff', '--numstat', '-z', '--no-index', '--no-ext-diff', '--no-textconv', '--', '/dev/null', file.path],
            { cwd, maxBuffer: 256 * 1024 * 1024 },
          );
          output = result.stdout;
        } catch (error: any) {
          if (error.code !== 1 || typeof error.stdout !== 'string') throw error;
          output = error.stdout;
        }
        unstaged.set(file.path, readCounts(output).get(file.path) ?? (output ? null : 0));
      }),
    );
  }
  return files.map((file) => ({
    path: file.path,
    staged: staged.has(file.path) ? staged.get(file.path)! : 0,
    unstaged: unstaged.has(file.path) ? unstaged.get(file.path)! : 0,
  }));
}

export async function discardWorkingFiles(
  cwd: string,
  files: { path: string; area: 'unstaged' | 'untracked'; diff: string }[],
) {
  if (!Array.isArray(files) || !files.length) throw new Error('Select files to discard.');
  if (await opState(cwd)) throw new Error('Finish or abort the current Git operation before discarding changes.');
  const entries = await status(cwd);
  const tracked: string[] = [];
  const untracked: string[] = [];
  const seen = new Set<string>();
  for (const file of files) {
    if (!file || typeof file.path !== 'string' || typeof file.diff !== 'string' || seen.has(file.path))
      throw new Error('Invalid discard selection.');
    seen.add(file.path);
    const entry = entries.find((value) => value.path === file.path);
    if (
      !entry ||
      !['unstaged', 'untracked'].includes(file.area) ||
      ['DD', 'AU', 'UD', 'UA', 'DU', 'AA', 'UU'].includes(entry.index + entry.worktree)
    )
      throw new Error('This file cannot be discarded. Refresh the working changes.');
    if ((await workingFileDiff(cwd, file.path, file.area)) !== file.diff)
      throw new Error('File changes changed since confirmation. Review the diff and try again.');
    if (file.area === 'untracked') {
      const { full } = await workPath(cwd, file.path);
      if ((await lstat(full)).isDirectory()) throw new Error('Discarding directories is not supported.');
      untracked.push(full);
    } else tracked.push(file.path);
  }
  if (tracked.length) {
    const modes = await git(cwd, ['--literal-pathspecs', 'ls-files', '--stage', '-z', '--', ...tracked]);
    if (modes.split('\0').some((entry) => entry.startsWith('160000 ')))
      throw new Error('Discard submodule changes inside the submodule repository.');
    await git(cwd, ['--literal-pathspecs', 'restore', '--worktree', '--', ...tracked]);
  }
  for (const full of untracked) await rm(full);
}

export async function discardWorkingHunk(cwd: string, filePath: string, expectedDiff: string, hunkIndex: number) {
  if (await opState(cwd)) throw new Error('Finish or abort the current Git operation before discarding changes.');
  const current = await workingFileDiff(cwd, filePath, 'unstaged');
  if (typeof expectedDiff !== 'string' || current !== expectedDiff)
    throw new Error('File changes changed since confirmation. Review the diff and try again.');
  if (
    /^(?:new file mode|deleted file mode|old mode|new mode|rename from|rename to|copy from|copy to|Binary files|GIT binary patch)/m.test(
      current,
    )
  )
    throw new Error('Discard this change as a whole file instead.');
  const { full } = await workPath(cwd, filePath);
  if (!(await lstat(full)).isFile()) throw new Error('Only regular text files support hunk discard.');
  const lines = current.split('\n');
  const starts = lines.flatMap((line, index) => (/^@@ /.test(line) ? [index] : []));
  if (!Number.isInteger(hunkIndex) || hunkIndex < 0 || hunkIndex >= starts.length)
    throw new Error('This hunk is no longer available. Refresh the diff.');
  const patch = [
    ...lines.slice(0, starts[0]),
    ...lines.slice(starts[hunkIndex], starts[hunkIndex + 1] ?? lines.length),
  ].join('\n');
  const dir = await mkdtemp(path.join(tmpdir(), 'gitverse-discard-'));
  try {
    const patchFile = path.join(dir, 'hunk.patch');
    await writeFile(patchFile, patch.endsWith('\n') ? patch : `${patch}\n`);
    await git(cwd, ['apply', '--reverse', '--check', '--whitespace=nowarn', '--', patchFile]);
    await git(cwd, ['apply', '--reverse', '--whitespace=nowarn', '--', patchFile]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export async function stageWorkingHunk(
  cwd: string,
  filePath: string,
  area: 'staged' | 'unstaged',
  expectedDiff: string,
  hunkIndex: number,
) {
  if (area !== 'staged' && area !== 'unstaged') throw new Error('Invalid change area.');
  if (await opState(cwd)) throw new Error('Finish or abort the current Git operation first.');
  const current = await workingFileDiff(cwd, filePath, area);
  if (typeof expectedDiff !== 'string' || current !== expectedDiff)
    throw new Error('File changes changed since the diff was opened. Refresh and review them first.');
  if (
    /^(?:new file mode|deleted file mode|old mode|new mode|rename from|rename to|copy from|copy to|Binary files|GIT binary patch)/m.test(
      current,
    )
  )
    throw new Error('Stage or unstage this change as a whole file instead.');
  const lines = current.split('\n');
  const starts = lines.flatMap((line, index) => (/^@@ /.test(line) ? [index] : []));
  if (!Number.isInteger(hunkIndex) || hunkIndex < 0 || hunkIndex >= starts.length)
    throw new Error('This hunk is no longer available. Refresh the diff.');
  const patch = [
    ...lines.slice(0, starts[0]),
    ...lines.slice(starts[hunkIndex], starts[hunkIndex + 1] ?? lines.length),
  ].join('\n');
  const index = await indexFile(cwd);
  const before = await indexSnapshot(cwd, index);
  const dir = await mkdtemp(path.join(tmpdir(), 'gitverse-stage-'));
  try {
    const patchFile = path.join(dir, 'hunk.patch');
    await writeFile(patchFile, patch.endsWith('\n') ? patch : `${patch}\n`);
    const args = ['apply', '--cached', ...(area === 'staged' ? ['--reverse'] : []), '--whitespace=nowarn'];
    await git(cwd, [...args, '--check', '--', patchFile]);
    await git(cwd, [...args, '--', patchFile]);
    const after = await indexSnapshot(cwd, index);
    if (!sameIndex(before, after)) {
      const history = indexHistory.get(cwd) ?? { undo: [], redo: [] };
      history.undo.push({ before, after, label: area === 'staged' ? 'unstage hunk' : 'stage hunk' });
      history.undo = history.undo.slice(-20);
      history.redo = [];
      indexHistory.set(cwd, history);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export const fetch = (cwd: string, prune = true) => git(cwd, ['fetch', '--all', ...(prune ? ['--prune'] : [])]);
export const pull = (cwd: string, mode: 'ff' | 'ff-only' | 'rebase' = 'ff') =>
  git(cwd, ['pull', mode === 'rebase' ? '--rebase' : mode === 'ff-only' ? '--ff-only' : '--ff']);
export const push = (cwd: string) => git(cwd, ['push']);
export async function commitIdentity(cwd: string) {
  const [name, email] = await Promise.all(
    ['user.name', 'user.email'].map((key) => git(cwd, ['config', '--get', key]).catch(() => '')),
  );
  return { name: name.trim(), email: email.trim() };
}

export async function setCommitIdentity(cwd: string, name: string, email: string) {
  if (!name.trim() || !email.trim() || /[\r\n<>\0]/.test(name + email) || !/^[^\s@]+@[^\s@]+$/.test(email.trim()))
    throw new Error('Enter a valid name and email.');
  const previousEmail = await git(cwd, ['config', '--local', '--get', 'user.email']).then(
    (s) => s.trim(),
    () => null,
  );
  await git(cwd, ['config', '--local', 'user.email', email.trim()]);
  try {
    await git(cwd, ['config', '--local', 'user.name', name.trim()]);
  } catch (error) {
    if (previousEmail === null) await git(cwd, ['config', '--local', '--unset-all', 'user.email']);
    else await git(cwd, ['config', '--local', 'user.email', previousEmail]);
    throw error;
  }
}
export async function pushInfo(cwd: string) {
  const branch = (await git(cwd, ['branch', '--show-current'])).trim();
  const remotes = (await git(cwd, ['remote'])).split('\n').filter(Boolean);
  const remote = branch ? (await git(cwd, ['config', '--get', `branch.${branch}.remote`]).catch(() => '')).trim() : '';
  const merge = branch ? (await git(cwd, ['config', '--get', `branch.${branch}.merge`]).catch(() => '')).trim() : '';
  const selectedRemote = remote || (remotes.includes('origin') ? 'origin' : (remotes[0] ?? ''));
  const target = merge.startsWith('refs/heads/') ? merge.slice(11) : branch;
  const remoteHash =
    selectedRemote && target
      ? (
          await git(cwd, ['rev-parse', '--verify', `refs/remotes/${selectedRemote}/${target}`]).catch(() => '')
        ).trim() || null
      : null;
  return {
    branch,
    remotes,
    remote: selectedRemote,
    target,
    remoteHash,
  };
}

export async function pushBranch(
  cwd: string,
  remote: string,
  branch: string,
  target: string,
  auth?: { kind: 'system' | 'ssh' | 'https'; username?: string; sshKey?: string; token?: string },
  options?: { forceWithLease?: boolean; expectedRemoteHash?: string },
) {
  const info = await pushInfo(cwd);
  if (!branch || info.branch !== branch) throw new Error('The current branch changed. Reopen the push dialog.');
  if (!info.remotes.includes(remote)) throw new Error('The selected remote no longer exists.');
  await git(cwd, ['check-ref-format', '--branch', target]);
  const env: Record<string, string> = { GIT_TERMINAL_PROMPT: '0' };
  const args = ['push', '--set-upstream'];
  if (options?.forceWithLease) {
    if (!options.expectedRemoteHash || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(options.expectedRemoteHash))
      throw new Error('Fetch the remote branch and reopen the push dialog before force pushing.');
    args.push(`--force-with-lease=refs/heads/${target}:${options.expectedRemoteHash}`);
  }
  args.push('--', remote, `refs/heads/${branch}:refs/heads/${target}`);
  if (auth?.kind === 'ssh') {
    if (!auth.sshKey || /[\r\n\0]/.test(auth.sshKey)) throw new Error('Choose a valid SSH private key.');
    const url = (await git(cwd, ['remote', 'get-url', '--push', remote])).trim();
    if (!/^(ssh:\/\/|[^/@:]+@[^/:]+:)/i.test(url)) throw new Error('This profile needs an SSH remote URL.');
    env.GIT_SSH_COMMAND = `ssh -o BatchMode=yes -o IdentitiesOnly=yes -i '${auth.sshKey.replace(/'/g, "'\\''")}'`;
  }
  let dir: string | undefined;
  try {
    if (auth?.kind === 'https') {
      const url = (await git(cwd, ['remote', 'get-url', '--push', remote])).trim();
      if (!/^https:\/\//i.test(url)) throw new Error('This profile needs an HTTPS remote URL.');
      if (!auth.username || !auth.token) throw new Error('Save a username and token for this profile.');
      if (process.platform === 'win32')
        throw new Error('HTTPS token profiles are not yet available on Windows. Use the system credential manager.');
      dir = await mkdtemp(path.join(tmpdir(), 'gitverse-auth-'));
      const askpass = path.join(dir, 'askpass');
      await writeFile(
        askpass,
        '#!/bin/sh\ncase "$1" in *sername*) printf "%s\\n" "$GITVERSE_PUSH_USER" ;; *) printf "%s\\n" "$GITVERSE_PUSH_TOKEN" ;; esac\n',
        { mode: 0o700 },
      );
      Object.assign(env, { GIT_ASKPASS: askpass, GITVERSE_PUSH_USER: auth.username, GITVERSE_PUSH_TOKEN: auth.token });
      args.unshift('-c', 'credential.helper=');
    }
    return await git(cwd, args, env);
  } finally {
    if (dir) await rm(dir, { recursive: true, force: true });
  }
}
export const createBranch = (cwd: string, name: string, from = 'HEAD') => git(cwd, ['checkout', '-b', name, from]);
export const stash = (cwd: string, message?: string) =>
  git(cwd, ['stash', 'push', '--include-untracked', ...(message ? ['-m', message] : [])]);
export const stashPop = (cwd: string) => git(cwd, ['stash', 'pop']);
export async function stashAction(cwd: string, hash: string, action: 'apply' | 'pop' | 'drop') {
  if (typeof hash !== 'string' || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(hash))
    throw new Error('Invalid stash identity. Refresh the repository.');
  if (!['apply', 'pop', 'drop'].includes(action)) throw new Error('Invalid stash action.');
  if (await opState(cwd)) throw new Error('Finish the current Git operation first.');
  const matches = (await stashEntries(cwd)).filter((entry) => entry.hash === hash);
  if (matches.length !== 1) throw new Error('This stash changed or is ambiguous. Refresh the repository.');
  const selector = matches[0].id;
  // A hash can identify the content for apply; pop and drop require the current reflog selector.
  return git(cwd, ['stash', action, action === 'apply' ? hash : selector]);
}
export async function stashRename(cwd: string, id: string, message: string) {
  if (typeof id !== 'string' || !/^(?:stash@\{\d+\}|[a-f0-9]{40}|[a-f0-9]{64})$/i.test(id))
    throw new Error('Invalid stash.');
  if (typeof message !== 'string' || !message.trim() || message.length > 200)
    throw new Error('Enter a stash name of 1–200 characters.');
  const entries = await stashEntries(cwd);
  const index = entries.findIndex((entry) => entry.id === id || entry.hash === id);
  const hash = entries[index]?.hash;
  if (!hash) throw new Error('This stash is no longer available. Refresh the repository.');
  await git(cwd, ['stash', 'store', '--message', message.trim(), hash]);
  try {
    await git(cwd, ['stash', 'drop', `stash@{${index + 1}}`]);
  } catch (error) {
    await git(cwd, ['stash', 'drop', 'stash@{0}']).catch(() => {});
    throw error;
  }
}

export async function reset(cwd: string, hash: string, mode: 'soft' | 'mixed' | 'hard') {
  if (mode !== 'soft') {
    const target = (await git(cwd, ['rev-parse', '--verify', '--end-of-options', `${hash}^{commit}`])).trim();
    await ensureTargetTreeSupported(cwd, target, `${mode} reset to`);
  }
  return git(cwd, ['reset', `--${mode}`, hash]);
}
export async function squashCommits(cwd: string, hashes: string[], message: string) {
  if (
    !Array.isArray(hashes) ||
    hashes.length < 2 ||
    hashes.length > 500 ||
    hashes.some((hash) => typeof hash !== 'string' || !/^[0-9a-f]{40,64}$/.test(hash)) ||
    new Set(hashes).size !== hashes.length
  )
    throw new Error('Select at least two distinct commits.');
  if (typeof message !== 'string' || !message.trim() || message.length > 10000 || message.includes('\0'))
    throw new Error('Enter a valid commit message.');
  if (await opState(cwd)) throw new Error('Finish the current Git operation before squashing.');
  if ((await status(cwd)).length) throw new Error('Commit or stash all working changes before squashing.');
  const branch = (await git(cwd, ['symbolic-ref', '-q', 'HEAD']).catch(() => '')).trim();
  if (!branch.startsWith('refs/heads/')) throw new Error('Check out a local branch before squashing.');
  const head = (await git(cwd, ['rev-parse', 'HEAD'])).trim();
  if (hashes[0] !== head) throw new Error('Select consecutive commits starting at the current branch HEAD.');
  let parent = '';
  for (let i = 0; i < hashes.length; i++) {
    const fields = (await git(cwd, ['rev-list', '--parents', '-n', '1', hashes[i]])).trim().split(' ');
    if (fields.length !== 2)
      throw new Error(
        'Squash supports only linear commits with one parent; merge and root commits cannot be included.',
      );
    parent = fields[1];
    if (i + 1 < hashes.length && hashes[i + 1] !== parent)
      throw new Error('Selected commits must be consecutive on the current branch.');
  }
  const dir = await mkdtemp(path.join(tmpdir(), 'gitverse-squash-'));
  try {
    const file = path.join(dir, 'message');
    await writeFile(file, message.trim() + '\n', { mode: 0o600 });
    const tree = (await git(cwd, ['rev-parse', `${head}^{tree}`])).trim();
    const commit = (await git(cwd, ['commit-tree', tree, '-p', parent, '-F', file])).trim();
    if (
      (await git(cwd, ['symbolic-ref', '-q', 'HEAD']).catch(() => '')).trim() !== branch ||
      (await status(cwd)).length ||
      (await opState(cwd))
    )
      throw new Error('The repository changed; review it before trying again.');
    await git(cwd, ['update-ref', '-m', `squash ${hashes.length} commits`, branch, commit, head]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
export const cherryPick = (cwd: string, hash: string) => git(cwd, ['cherry-pick', hash]);
export async function cherryPickMany(cwd: string, hashes: string[]) {
  if (
    !Array.isArray(hashes) ||
    hashes.length < 2 ||
    hashes.length > 500 ||
    new Set(hashes).size !== hashes.length ||
    hashes.some((hash) => typeof hash !== 'string' || !/^[0-9a-f]{40,64}$/.test(hash))
  )
    throw new Error('Select at least two valid commits.');
  for (const hash of hashes) {
    const parents = (await git(cwd, ['rev-list', '--parents', '-n', '1', hash])).trim().split(' ');
    if (parents.length > 2) throw new Error('Multi-commit cherry-pick does not support merge commits.');
  }
  return git(cwd, ['cherry-pick', ...hashes]);
}
export const tagCommit = async (cwd: string, name: string) => {
  if (typeof name !== 'string' || !name || name.includes('\0')) throw new Error('Invalid tag.');
  return (await git(cwd, ['rev-parse', '--verify', `refs/tags/${name}^{commit}`])).trim();
};
export const stashDiff = (cwd: string, id: string) => {
  if (typeof id !== 'string' || !/^stash@\{\d+\}$/.test(id)) throw new Error('Invalid stash.');
  return git(cwd, ['stash', 'show', '--include-untracked', '--patch', '--no-ext-diff', '--no-color', id]);
};

export async function stashDetail(cwd: string, id: string): Promise<StashDetail> {
  if (typeof id !== 'string' || !/^(?:stash@\{\d+\}|[a-f0-9]{40}|[a-f0-9]{64})$/i.test(id))
    throw new Error('Invalid stash.');
  const stash = (await stashEntries(cwd)).find((entry) => entry.id === id || entry.hash === id);
  if (!stash?.hash || !stash.baseHash) throw new Error('This stash is no longer available. Refresh the repository.');
  const tracked = await commitDetail(cwd, stash.hash);
  const files: StashDetail['files'] = [...tracked.files];
  const untracked = await git(cwd, ['rev-parse', '--verify', `${stash.hash}^3`]).catch(() => '');
  if (untracked.trim()) {
    const paths = await git(cwd, ['ls-tree', '-r', '--name-only', '-z', untracked.trim()]);
    files.push(
      ...paths
        .split('\0')
        .filter(Boolean)
        .map((filePath) => ({ status: 'A', path: filePath, untracked: true })),
    );
  }
  return { ...stash, hash: stash.hash, baseHash: stash.baseHash, body: tracked.body, files };
}

export async function stashFileDiff(cwd: string, id: string, filePath: string): Promise<string> {
  const detail = await stashDetail(cwd, id);
  const file = detail.files.find((entry) => entry.path === filePath);
  if (!file) throw new Error('This file is not in the selected stash.');
  return file.untracked
    ? git(cwd, [
        '--literal-pathspecs',
        'diff-tree',
        '--root',
        '--no-commit-id',
        '--patch',
        '-r',
        '--no-ext-diff',
        '--no-textconv',
        '--no-color',
        `${detail.hash}^3`,
        '--',
        file.path,
      ])
    : git(cwd, [
        '--literal-pathspecs',
        'diff',
        '--find-renames',
        '--no-ext-diff',
        '--no-textconv',
        '--no-color',
        detail.baseHash,
        detail.hash,
        '--',
        ...(file.oldPath ? [file.oldPath] : []),
        file.path,
      ]);
}

export async function stashFileAt(cwd: string, id: string, filePath: string): Promise<string> {
  const detail = await stashDetail(cwd, id);
  const file = detail.files.find((entry) => entry.path === filePath);
  if (!file || file.status === 'D') throw new Error('This file is not available in the selected stash.');
  return git(cwd, ['show', `${detail.hash}${file.untracked ? '^3' : ''}:${file.path}`]);
}
export const revert = (cwd: string, hash: string) => git(cwd, ['revert', '--no-edit', hash]);
export const rebaseOnto = (cwd: string, hash: string) => git(cwd, ['rebase', hash]);
export async function rebasePreview(cwd: string, base: string) {
  if (typeof base !== 'string' || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(base))
    throw new Error('Select a valid commit as the base.');
  if (await opState(cwd)) throw new Error('Finish the current Git operation first.');
  const branch = (await git(cwd, ['symbolic-ref', '--quiet', '--short', 'HEAD']).catch(() => '')).trim();
  if (!branch) throw new Error('Check out a local branch before planning a rebase.');
  const head = (await git(cwd, ['rev-parse', '--verify', 'HEAD'])).trim();
  const upstream = (await git(cwd, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}']).catch(() => '')).trim();
  if (!upstream) throw new Error('Set an upstream branch before planning unpublished commits.');
  if (!(await git(cwd, ['merge-base', '--is-ancestor', base, head]).then(() => true, () => false)))
    throw new Error('The selected base must be an ancestor of the current branch.');
  const lines = (await git(cwd, ['rev-list', '--reverse', '--parents', `${base}..${head}`])).split('\n').filter(Boolean);
  if (!lines.length) throw new Error('There are no commits after the selected base.');
  if (lines.length > 100) throw new Error('Choose a range of at most 100 commits.');
  let parent = base;
  const commits: { hash: string; subject: string }[] = [];
  for (const line of lines) {
    const [hash, ...parents] = line.split(' ');
    if (parents.length !== 1 || parents[0] !== parent) throw new Error('Choose a linear range without merge commits.');
    if (await git(cwd, ['merge-base', '--is-ancestor', hash, upstream]).then(() => true, () => false))
      throw new Error('The selected range contains commits already reachable from the upstream branch.');
    const subject = (await git(cwd, ['show', '-s', '--format=%s', hash])).trim();
    commits.push({ hash, subject });
    parent = hash;
  }
  if ((await git(cwd, ['rev-parse', '--verify', 'HEAD'])).trim() !== head)
    throw new Error('The branch changed while preparing the preview. Try again.');
  return { branch, head, base, upstream, commits };
}
export const createTag = (cwd: string, name: string, hash: string) => git(cwd, ['tag', name, hash]);
export async function branchAt(cwd: string, name: string, hash: string) {
  await ensureTargetTreeSupported(cwd, hash, 'create a branch from');
  return git(cwd, ['checkout', '-b', name, hash]);
}
export const fileAt = (cwd: string, hash: string, path: string) => git(cwd, ['show', `${hash}:${path}`]);

const MAX_BLOB_BYTES = 50 * 1024 * 1024;
export async function fileBlobAt(cwd: string, hash: string, filePath: string): Promise<string> {
  const { stdout } = await run('git', ['show', `${hash}:${filePath}`], {
    cwd,
    encoding: 'buffer',
    maxBuffer: MAX_BLOB_BYTES,
  }).catch((e: any) => {
    throw new Error(
      e.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' ? 'File is too large to preview (over 50 MB).' : e.message,
      { cause: e },
    );
  });
  return stdout.toString('base64');
}
export async function workingFileBlob(cwd: string, filePath: string): Promise<string> {
  const root = await realpath(cwd);
  const full = path.resolve(root, filePath);
  if (path.relative(root, full).startsWith('..') || path.isAbsolute(path.relative(root, full)))
    throw new Error('File is outside the repository.');
  const info = await lstat(full);
  if (!info.isFile()) throw new Error('Only regular files can be previewed.');
  if (info.size > MAX_BLOB_BYTES) throw new Error('File is too large to preview (over 50 MB).');
  return (await readFile(full)).toString('base64');
}

export async function worktreeAdd(cwd: string, path: string, hash: string) {
  await ensureTargetTreeSupported(cwd, hash, 'create a worktree from');
  return git(cwd, ['worktree', 'add', '--detach', path, hash]);
}
export const remoteUrl = async (cwd: string) => (await git(cwd, ['remote', 'get-url', 'origin'])).trim();
export const formatPatch = (cwd: string, hash: string) => git(cwd, ['format-patch', '-1', '--stdout', hash]);
export const createAnnotatedTag = (cwd: string, name: string, hash: string, message: string) =>
  git(cwd, ['tag', '-a', name, '-m', message || name, hash]);

export interface BlameLine {
  hash: string;
  author: string;
  time: number;
}
export async function fileBlame(cwd: string, hash: string, path: string): Promise<BlameLine[]> {
  const out = await git(cwd, ['blame', '--porcelain', hash, '--', path]);
  const meta = new Map<string, { author: string; time: number }>();
  const lines: BlameLine[] = [];
  let cur = '';
  for (const l of out.split('\n')) {
    if (l.startsWith('\t')) {
      const m = meta.get(cur)!;
      lines.push({ hash: cur, author: m.author, time: m.time });
      continue;
    }
    const h = /^([0-9a-f]{40}) \d+ \d+/.exec(l);
    if (h) {
      cur = h[1];
      if (!meta.has(cur)) meta.set(cur, { author: '', time: 0 });
    } else if (l.startsWith('author ')) meta.get(cur)!.author = l.slice(7);
    else if (l.startsWith('author-time ')) meta.get(cur)!.time = Number(l.slice(12)) * 1000;
  }
  return lines;
}

export async function fileHistory(cwd: string, hash: string, path: string) {
  const out = await git(cwd, ['log', '--follow', '-n200', '--format=%H%x1f%an%x1f%aI%x1f%s', hash, '--', path]);
  return out
    .split('\n')
    .filter(Boolean)
    .map((l) => {
      const [h, author, date, subject] = l.split('\x1f');
      return { hash: h, author, date, subject };
    });
}

// ---- in-progress operations (rebase / merge / cherry-pick / revert) and conflict resolution ----
export type OpKind = 'rebase' | 'merge' | 'cherry-pick' | 'revert';
export interface OpState {
  kind: OpKind;
  step?: string;
  files: string[]; // still conflicted
  resolved: { status: string; path: string }[]; // staged so far
  head: string; // branch being rebased / receiving the change
  onto: string; // what it is being rebased onto / merged from (short)
  message: string; // commit message git will use on continue
}

const exists = (p: string) =>
  access(p).then(
    () => true,
    () => false,
  );

export async function opState(cwd: string): Promise<OpState | null> {
  const dir = path.resolve(cwd, (await git(cwd, ['rev-parse', '--git-dir'])).trim());
  let kind: OpKind | null = null;
  let step: string | undefined;
  if ((await exists(path.join(dir, 'rebase-merge'))) || (await exists(path.join(dir, 'rebase-apply')))) {
    kind = 'rebase';
    try {
      const m = path.join(dir, 'rebase-merge');
      const [cur, end] = await Promise.all([
        readFile(path.join(m, 'msgnum'), 'utf8'),
        readFile(path.join(m, 'end'), 'utf8'),
      ]);
      step = `${cur.trim()}/${end.trim()}`;
    } catch {
      /* apply-style rebase has no step files */
    }
  } else if (await exists(path.join(dir, 'MERGE_HEAD'))) kind = 'merge';
  else if (await exists(path.join(dir, 'CHERRY_PICK_HEAD'))) kind = 'cherry-pick';
  else if (await exists(path.join(dir, 'REVERT_HEAD'))) kind = 'revert';
  if (!kind) return null;
  const files = (await git(cwd, ['diff', '--name-only', '--diff-filter=U'])).split('\n').filter(Boolean);
  const resolved = (await git(cwd, ['diff', '--cached', '--name-status', '--diff-filter=ACDMR']))
    .split('\n')
    .filter(Boolean)
    .map((l) => {
      const [s, ...p] = l.split('\t');
      return { status: s[0], path: p[p.length - 1] };
    })
    .filter((f) => !files.includes(f.path));
  const read = (f: string) =>
    readFile(path.join(dir, f), 'utf8').then(
      (t) => t.trim(),
      () => '',
    );
  const short = async (ref: string) =>
    ref ? (await git(cwd, ['rev-parse', '--short', ref]).catch(() => ref)).trim() : '';
  let head: string, onto: string;
  if (kind === 'rebase') {
    const base = (await exists(path.join(dir, 'rebase-merge'))) ? 'rebase-merge' : 'rebase-apply';
    head = (await read(`${base}/head-name`)).replace(/^refs\/heads\//, '') || 'HEAD';
    onto = await short(await read(`${base}/onto`));
  } else {
    head = (await git(cwd, ['branch', '--show-current']).catch(() => '')).trim() || 'HEAD';
    onto = await short(
      await read(kind === 'merge' ? 'MERGE_HEAD' : kind === 'cherry-pick' ? 'CHERRY_PICK_HEAD' : 'REVERT_HEAD'),
    );
  }
  // MERGE_MSG holds the message git will commit with; drop git's "# Conflicts:" comment block
  const message = (await read('MERGE_MSG'))
    .split('\n')
    .filter((l) => !l.startsWith('#'))
    .join('\n')
    .trim();
  return { kind, step, files, resolved, head, onto, message };
}

// GIT_EDITOR=true makes "continue" accept the existing message instead of opening an editor we cannot show
const NO_EDITOR = { GIT_EDITOR: 'true' };
const cmd = (kind: OpKind, verb: 'continue' | 'abort' | 'skip'): string[] => {
  if (kind === 'merge') return verb === 'abort' ? ['merge', '--abort'] : ['commit', '--no-edit'];
  return [kind, `--${verb}`];
};
// With a message, a tiny "editor" writes it into the file git asks us to edit, so the user's edit is kept.
export const opContinue = (cwd: string, kind: OpKind, message?: string) =>
  git(
    cwd,
    kind === 'merge' && message ? ['commit'] : cmd(kind, 'continue'),
    message ? { GIT_EDITOR: 'sh -c \'printf "%s\\n" "$GITVERSE_MSG" > "$1"\' sh', GITVERSE_MSG: message } : NO_EDITOR,
  );
export const opAbort = (cwd: string, kind: OpKind) => git(cwd, cmd(kind, 'abort'), NO_EDITOR);
export const opSkip = (cwd: string, kind: OpKind) => git(cwd, cmd(kind, 'skip'), NO_EDITOR);

export async function resolveFile(cwd: string, file: string, side: 'ours' | 'theirs' | 'mark') {
  if (side !== 'mark') {
    try {
      await git(cwd, ['checkout', `--${side}`, '--', file]);
    } catch {
      // that side deleted the file: taking its version means removing it
      await git(cwd, ['rm', '--quiet', '--', file]);
      return;
    }
  }
  await git(cwd, ['add', '--', file]);
}

// ---- working-tree file access for the merge tool (paths are confined to the repository) ----
const isWithin = (root: string, target: string) => {
  const relative = path.relative(root, target);
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
};

async function workPath(cwd: string, rel: string) {
  const root = await realpath(cwd);
  const full = path.resolve(root, rel);
  if (!isWithin(root, full)) throw new Error('Path is outside the repository');
  const parent = await realpath(path.dirname(full));
  if (parent !== root && !isWithin(root, parent)) throw new Error('Path is outside the repository');
  return { root, full: path.join(parent, path.basename(full)) };
}

export async function readWorkFile(cwd: string, rel: string) {
  const { root, full } = await workPath(cwd, rel);
  const target = await realpath(full);
  if (!isWithin(root, target)) throw new Error('Path is outside the repository');
  const file = await open(target, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
  try {
    return await file.readFile('utf8');
  } finally {
    await file.close();
  }
}

export async function writeWorkFile(cwd: string, rel: string, text: string) {
  const { full } = await workPath(cwd, rel);
  const file = await open(
    full,
    fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_TRUNC | (fsConstants.O_NOFOLLOW ?? 0),
    0o666,
  );
  try {
    await file.writeFile(text, 'utf8');
  } finally {
    await file.close();
  }
}

// GIT_EDITOR=true: accept the generated merge message instead of opening an editor we cannot show
export const merge = (cwd: string, ref: string, noFf = true, ffOnly = false) =>
  git(cwd, ['merge', ...(ffOnly ? ['--ff-only'] : noFf ? ['--no-ff'] : []), '--no-edit', ref], { GIT_EDITOR: 'true' });
/** Delete only when Git confirms the branch is merged locally or into a fetched remote tip. */
export async function deleteBranch(cwd: string, name: string, force = false) {
  if (!name || name.startsWith('-') || name.includes('\0')) throw new Error('Invalid local branch name.');
  await git(cwd, ['check-ref-format', '--branch', name]);
  const current = (await git(cwd, ['branch', '--show-current'])).trim();
  if (current === name) throw new Error(`Cannot delete ${name} while it is checked out.`);

  // Force deletion is only reachable through the explicit, separately confirmed UI action.
  // It removes the branch ref, not commits still reachable from another ref (for example,
  // a squash-merged remote branch).
  if (force) return git(cwd, ['branch', '-D', '--', name]);

  try {
    return await git(cwd, ['branch', '-d', '--', name]);
  } catch (error) {
    const detail = String((error as Error)?.message ?? error);
    if (!/not fully merged|not merged/i.test(detail)) throw error;
  }

  const refs = (await git(cwd, ['for-each-ref', '--format=%(refname)', 'refs/remotes/'])).split('\n').filter(Boolean);
  for (const remoteRef of refs) {
    try {
      await git(cwd, ['merge-base', '--is-ancestor', `refs/heads/${name}`, remoteRef]);
      // `-d` checks only HEAD and the configured upstream. We have proved
      // ancestry against this fetched remote tip, so force-delete that ref.
      return git(cwd, ['branch', '-D', '--', name]);
    } catch (error) {
      // Git exit 1 means not an ancestor. Surface other failures instead of
      // misreporting repository or executable errors as an unmerged branch.
      const code = (error as Error & { cause?: { code?: number | string } }).cause?.code;
      if (code !== 1) throw error;
    }
  }
  throw new Error(
    `Cannot delete ${name}: it is not merged into the current branch or any fetched remote branch. Fetch first, or merge it before deleting.`,
  );
}
export const deleteRemoteBranch = async (cwd: string, name: string) => {
  const slash = name.indexOf('/');
  const remote = name.slice(0, slash);
  const branch = name.slice(slash + 1);
  if (slash < 1 || !branch || name.includes('\0') || remote.startsWith('-') || branch.startsWith('-'))
    throw new Error('Invalid remote branch.');
  if (isRemoteHeadAlias(name)) throw new Error(`${name} points to the remote's default branch and cannot be deleted.`);
  if (!(await git(cwd, ['remote'])).split('\n').includes(remote))
    throw new Error('The selected remote no longer exists.');
  await git(cwd, ['check-ref-format', '--branch', branch]);
  await git(cwd, ['push', '--delete', '--', remote, branch]);
};
