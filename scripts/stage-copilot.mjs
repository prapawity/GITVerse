// Stage the Copilot sidecar for a Tauri release build (used with src-tauri/tauri.release.conf.json):
//   src-tauri/binaries/node-<target triple>[.exe]  the Node that runs the sidecar (Tauri externalBin)
//   src-tauri/copilot/copilot-sidecar.mjs          the sidecar
//   src-tauri/copilot/node_modules/...             @github/copilot-sdk, its platform runtime and dependencies
// Run on the machine that builds the installer: the platform runtime and Node match that machine.
import { execFileSync, execSync } from 'node:child_process';
import { chmodSync, copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const tauri = path.join(root, 'src-tauri');
const stage = path.join(tauri, 'copilot');

execSync('npm run build:sidecar', { cwd: root, stdio: 'inherit' });
rmSync(stage, { recursive: true, force: true });
mkdirSync(path.join(stage, 'node_modules'), { recursive: true });
copyFileSync(path.join(root, 'sidecar', 'copilot-sidecar.mjs'), path.join(stage, 'copilot-sidecar.mjs'));

// the SDK finds `@github/copilot-sdk-<platform>` through Node's module lookup from its own folder
const platform = `${process.platform}-${process.arch}`;
const queue = ['@github/copilot-sdk', `@github/copilot-sdk-${platform}`, 'zod'];
const copied = new Set();
while (queue.length) {
  const name = queue.shift();
  if (copied.has(name)) continue;
  const from = path.join(root, 'node_modules', ...name.split('/'));
  if (!existsSync(path.join(from, 'package.json'))) throw new Error(`${name} is not installed; run npm ci first.`);
  cpSync(from, path.join(stage, 'node_modules', ...name.split('/')), { recursive: true, dereference: true });
  copied.add(name);
  const pkg = JSON.parse(readFileSync(path.join(from, 'package.json'), 'utf8'));
  queue.push(...Object.keys(pkg.dependencies ?? {}));
}

// Tauri expects external binaries named with the Rust target triple
const host = /host: (\S+)/.exec(execFileSync('rustc', ['-vV'], { encoding: 'utf8' }))?.[1];
if (!host) throw new Error('Could not read the Rust host target from `rustc -vV`.');
const ext = process.platform === 'win32' ? '.exe' : '';
mkdirSync(path.join(tauri, 'binaries'), { recursive: true });
const node = path.join(tauri, 'binaries', `node-${host}${ext}`);
copyFileSync(process.execPath, node);
chmodSync(node, 0o755);

console.log(`Staged Copilot for ${platform} (${[...copied].join(', ')}) and Node ${process.version} as ${node}`);
