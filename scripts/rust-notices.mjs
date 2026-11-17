// Append the licenses of the Rust crates compiled into the Tauri build to
// build-notices/THIRD_PARTY_NOTICES.txt (run after scripts/third-party-notices.cjs).
// Crates come from `cargo metadata` for this machine's target; license texts from each crate's
// own LICENSE/COPYING/NOTICE files in the cargo registry.
import { execFileSync } from 'node:child_process';
import { appendFileSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const host = /host: (\S+)/.exec(execFileSync('rustc', ['-vV'], { encoding: 'utf8' }))?.[1];
const meta = JSON.parse(
  execFileSync(
    'cargo',
    [
      'metadata',
      '--format-version',
      '1',
      '--locked',
      '--manifest-path',
      path.join(root, 'src-tauri', 'Cargo.toml'),
      '--filter-platform',
      host,
    ],
    { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 },
  ),
);

// only crates reachable from the app through normal (non-dev, non-build) dependencies
const nodes = new Map(meta.resolve.nodes.map((n) => [n.id, n]));
const used = new Set();
const queue = [...meta.workspace_members];
while (queue.length) {
  const id = queue.pop();
  if (used.has(id)) continue;
  used.add(id);
  for (const dep of nodes.get(id)?.deps ?? []) if (dep.dep_kinds.some((k) => k.kind === null)) queue.push(dep.pkg);
}
const members = new Set(meta.workspace_members);
const crates = meta.packages
  .filter((p) => used.has(p.id) && !members.has(p.id))
  .sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version));

const licenseFile = /^(?:licen[cs]e|copying|notice)(?:[._-].*)?$/i;
const sections = [
  `\n\nRust crates compiled into the Tauri build (${host})\n\nLicense identifiers are crate metadata, not a substitute for the license text.\n`,
];
const missing = [];
for (const crate of crates) {
  const dir = path.dirname(crate.manifest_path);
  const files = readdirSync(dir)
    .filter((f) => licenseFile.test(f) && statSync(path.join(dir, f)).isFile())
    .sort();
  let section = `\n${'='.repeat(80)}\n${crate.name} ${crate.version}\nLicense: ${crate.license ?? crate.license_file ?? 'unknown'}\n`;
  if (crate.repository) section += `Repository: ${crate.repository}\n`;
  if (!files.length) missing.push(`${crate.name} ${crate.version}`);
  for (const f of files) section += `\n--- ${f} ---\n${readFileSync(path.join(dir, f), 'utf8').trim()}\n`;
  sections.push(section);
}
appendFileSync(path.join(root, 'build-notices', 'THIRD_PARTY_NOTICES.txt'), sections.join(''));
console.log(
  `Rust notices: ${crates.length} crates${missing.length ? `, ${missing.length} without a license file` : ''}`,
);
