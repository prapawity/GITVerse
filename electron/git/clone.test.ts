import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { clone } from './git';

test(
  'HTTPS clone supplies credentials to Git without embedding them in the URL',
  { skip: process.platform === 'win32' },
  async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'gitverse-clone-test-'));
    const originalPath = process.env.PATH;
    try {
      await writeFile(
        path.join(dir, 'git'),
        `#!/bin/sh
[ "$1" = "-c" ] && [ "$2" = "credential.helper=" ] || exit 1
[ "$("$GIT_ASKPASS" Username)" = "test-user" ] || exit 2
[ "$("$GIT_ASKPASS" Password)" = "test-token" ] || exit 3
[ "$6" = "https://example.com/repo.git" ] || exit 4
`,
        { mode: 0o700 },
      );
      process.env.PATH = `${dir}:${originalPath}`;
      await clone('https://example.com/repo.git', path.join(dir, 'repo'), () => {}, {
        username: 'test-user',
        password: 'test-token',
      });
      await assert.rejects(
        clone('git@example.com:repo.git', path.join(dir, 'other'), () => {}, {
          username: 'test-user',
          password: 'test-token',
        }),
        /HTTPS credentials/,
      );
    } finally {
      process.env.PATH = originalPath;
      await rm(dir, { recursive: true, force: true });
    }
  },
);
