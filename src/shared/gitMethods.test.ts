/**
 * IPC contract: every method the renderer can call must have a backend handler, and vice versa.
 * The future Tauri backend gets the same check against its registered commands.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { GIT_METHODS } from './gitMethods';

test('GIT_METHODS matches the git:* handlers registered in electron/main.ts', () => {
  const main = readFileSync(path.resolve(__dirname, '../../electron/main.ts'), 'utf8');
  const block = main.match(/const handlers = \{([\s\S]*?)\n\} as const;/);
  assert.ok(block, 'could not find the handlers table in electron/main.ts');
  const registered = [...block[1].matchAll(/^\s+(\w+)(?:,|:)/gm)].map((m) => m[1]).sort();
  assert.deepEqual([...GIT_METHODS].sort(), registered);
});

test('GIT_METHODS has no duplicates', () => {
  assert.equal(new Set(GIT_METHODS).size, GIT_METHODS.length);
});
