/** The Rust backend embeds src/shared/aiSpec.json; it must match what the TS backend sends. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { SPEC_FILE, specText } from '../../scripts/ai-spec';

test('src/shared/aiSpec.json matches aiTools.ts (run: npx tsx scripts/ai-spec.ts)', () => {
  assert.equal(readFileSync(SPEC_FILE, 'utf8'), specText());
});

test('the commit-message prompt in each TS provider matches aiSpec.json', () => {
  const { commitSystem } = JSON.parse(readFileSync(SPEC_FILE, 'utf8'));
  for (const file of ['claude.ts', 'openai.ts', 'copilot.ts']) {
    const source = readFileSync(new URL(`../../electron/ai/${file}`, `file://${__filename}`), 'utf8');
    assert.ok(source.includes(commitSystem), `${file} uses a different commit-message prompt`);
  }
});
