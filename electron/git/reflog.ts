import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

/** Read the current worktree's HEAD history without changing refs or files. */
export async function reflog(cwd: string) {
  try {
    const { stdout } = await run(
      'git',
      ['reflog', 'show', '--no-abbrev', '--date=iso-strict', '--format=%H%x1f%gD%x1f%gs%x1e', '-n', '150', 'HEAD'],
      { cwd, maxBuffer: 4 * 1024 * 1024, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' } },
    );
    return stdout
      .split('\x1e')
      .map((record) => record.trim())
      .filter(Boolean)
      .map((record) => {
        const [hash, selector, ...message] = record.split('\x1f');
        return { hash, selector, message: message.join('\x1f') };
      })
      .filter((entry) => /^[0-9a-f]{40,64}$/i.test(entry.hash));
  } catch (error: any) {
    // A repository with no commits has no HEAD reflog. Other Git errors remain visible.
    try {
      await run('git', ['rev-parse', '--verify', 'HEAD'], { cwd });
    } catch (headError: any) {
      const message = String(headError.stderr ?? '');
      if (/needed a single revision|unknown revision/i.test(message)) return [];
    }
    throw new Error(String(error.stderr || error.message).trim(), { cause: error });
  }
}
