import { execFile } from 'node:child_process';
import { readdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import type { ScanProgress, ScanResult } from '../src/shared/repositoryScan';

const run = promisify(execFile);
const excluded = new Set(['node_modules', 'vendor', 'dist', 'build']);

export async function scanRepositories(
  folder: string,
  signal: AbortSignal,
  onProgress: (progress: ScanProgress) => void,
): Promise<ScanResult> {
  if (typeof folder !== 'string' || !path.isAbsolute(folder) || folder.includes('\0'))
    throw new Error('Choose a valid folder.');
  const root = path.resolve(folder);
  const pending = [root];
  const repos: string[] = [];
  let scanned = 0;
  let skipped = 0;
  let lastProgress = 0;
  let current = root;
  const report = () => {
    onProgress({ scanned, repositories: repos.length, skipped, folder: current });
    lastProgress = Date.now();
  };
  report();
  while (pending.length && !signal.aborted) {
    current = pending.pop()!;
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch (error) {
      if (current === root)
        throw new Error(
          `Could not read the dropped folder: ${error instanceof Error ? error.message : String(error)}`,
          { cause: error },
        );
      skipped++;
      continue;
    }
    if (signal.aborted) break;
    scanned++;
    if (entries.some((entry) => entry.name === '.git' && (entry.isDirectory() || entry.isFile()))) {
      try {
        const { stdout } = await run('git', ['rev-parse', '--show-toplevel'], {
          cwd: current,
          signal,
          timeout: 10_000,
        });
        if ((await realpath(stdout.trim())) === (await realpath(current))) repos.push(current);
      } catch {
        if (signal.aborted) break;
        skipped++;
      }
    }
    for (const entry of entries) {
      if (entry.isDirectory() && !entry.name.startsWith('.') && !excluded.has(entry.name))
        pending.push(path.join(current, entry.name));
    }
    if (Date.now() - lastProgress >= 150) report();
  }
  report();
  return { root, group: path.basename(root), repos, skipped, cancelled: signal.aborted };
}
