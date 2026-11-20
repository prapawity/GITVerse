// Apps started from Finder / the Dock get a minimal PATH (/usr/bin:/bin…), so Git hooks cannot find
// tools the terminal can — e.g. git-lfs from Homebrew in a pre-push hook. Merge in the login shell's
// PATH (and the usual install folders) once at startup, before any Git command runs.
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';

export function fixPath() {
  if (process.platform === 'win32') return;
  const parts: string[] = [];
  try {
    const shell = process.env.SHELL || (process.platform === 'darwin' ? '/bin/zsh' : '/bin/sh');
    const out = spawnSync(shell, ['-ilc', 'printf "__GV_PATH__%s__GV_END__" "$PATH"'], {
      encoding: 'utf8',
      timeout: 3000,
      stdio: ['ignore', 'pipe', 'ignore'],
      env: { ...process.env, TERM: 'dumb' },
    });
    const found = /__GV_PATH__(.*?)__GV_END__/s.exec(out.stdout ?? '')?.[1];
    if (found) parts.push(...found.split(path.delimiter));
  } catch {
    // keep the fallback folders below
  }
  const home = os.homedir();
  parts.push(
    ...(process.env.PATH ?? '').split(path.delimiter),
    '/opt/homebrew/bin',
    '/opt/homebrew/sbin',
    '/usr/local/bin',
    path.join(home, '.local', 'bin'),
    '/usr/bin',
    '/bin',
    '/usr/sbin',
    '/sbin',
  );
  process.env.PATH = [...new Set(parts.filter(Boolean))].join(path.delimiter);
}
