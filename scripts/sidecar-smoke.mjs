// Start the staged Copilot sidecar with the staged Node and check that the Copilot runtime starts.
// The staged folder is copied out of the repository first, so a package missing from the stage
// cannot be found in the repository's own node_modules.
//   node scripts/sidecar-smoke.mjs
import { spawn } from 'node:child_process';
import { cpSync, mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';

const tauri = path.resolve(import.meta.dirname, '..', 'src-tauri');
const isolated = mkdtempSync(path.join(tmpdir(), 'gitverse-copilot-'));
cpSync(path.join(tauri, 'copilot'), isolated, { recursive: true });
const node = path.join(
  tauri,
  'binaries',
  readdirSync(path.join(tauri, 'binaries')).find((f) => f.startsWith('node-')),
);
const script = path.join(isolated, 'copilot-sidecar.mjs');

const child = spawn(node, [script], { stdio: ['pipe', 'pipe', 'inherit'] });
const timer = setTimeout(() => fail('no answer within 120 s'), 120_000);
function fail(why) {
  console.error(`Copilot sidecar smoke test failed: ${why}`);
  child.kill();
  process.exit(1);
}
child.on('error', (e) => fail(e.message));
child.on('exit', (code) => fail(`the sidecar exited (${code}) before answering`));
createInterface({ input: child.stdout }).on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.id !== 1) return;
  console.log(JSON.stringify(msg.result ?? msg));
  if (!msg.result?.available) fail(msg.result?.message ?? msg.error ?? 'runtime unavailable');
  clearTimeout(timer);
  child.removeAllListeners('exit');
  child.stdin.end(); // the sidecar shuts the runtime down and exits
  child.on('exit', () => process.exit(0));
});
child.stdin.write(JSON.stringify({ id: 1, method: 'status' }) + '\n');
