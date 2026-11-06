import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';

/**
 * Tiny key/value store persisted as one JSON file in the app's data folder.
 * Unlike the page's localStorage it does not depend on the dev-server port/origin and is written
 * to disk immediately, so quitting right after opening a repo can't lose it.
 */
export const stateFile = (dir: string) => path.join(dir, 'gitverse-state.json');

export function loadState(dir: string): Record<string, string> {
  try {
    const obj = JSON.parse(readFileSync(stateFile(dir), 'utf8'));
    return obj && typeof obj === 'object' && !Array.isArray(obj) ? obj : {};
  } catch {
    return {}; // missing or corrupt file: start fresh rather than crash
  }
}

export function saveKey(dir: string, key: string, value: string | null) {
  const next = loadState(dir);
  if (value == null) delete next[key];
  else next[key] = value;
  mkdirSync(dir, { recursive: true });
  const tmp = stateFile(dir) + '.tmp';
  writeFileSync(tmp, JSON.stringify(next), 'utf8');
  renameSync(tmp, stateFile(dir)); // atomic swap: a crash mid-write never leaves a half-written file
}
