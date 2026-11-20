// Merge the per-platform records from scripts/updater-collect.mjs into the Tauri updater feed
// (latest.json), pointing at the assets of the GitHub release <tag>.
//   node scripts/updater-manifest.mjs <dir> <tag>
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const [dir, tag] = process.argv.slice(2);
if (!dir || !/^v\d+\.\d+\.\d+$/.test(tag ?? '')) throw new Error('Usage: updater-manifest.mjs <dir> <vX.Y.Z>');
const platforms = {};
for (const f of readdirSync(dir).filter((f) => /^[a-z]+-[a-z0-9_]+\.json$/.test(f))) {
  const { key, file, signature } = JSON.parse(readFileSync(path.join(dir, f), 'utf8'));
  platforms[key] = {
    signature,
    url: `https://github.com/prapawity/GITVerse-by-PRAPAWITY/releases/download/${tag}/${encodeURIComponent(file)}`,
  };
}
if (!Object.keys(platforms).length) throw new Error(`No updater records in ${dir}`);
const manifest = {
  version: tag.slice(1),
  notes: `GITVerse by PRAPAWITY ${tag}`,
  pub_date: new Date().toISOString(),
  platforms,
};
writeFileSync(path.join(dir, 'latest.json'), JSON.stringify(manifest, null, 2) + '\n');
console.log(`latest.json: ${Object.keys(platforms).join(', ')}`);
