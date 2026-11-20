// After a signed Tauri release build: copy this platform's updater bundle and signature to
// updater-out/ under a name unique per platform, and record them for scripts/updater-manifest.mjs.
//   node scripts/updater-collect.mjs <windows-x86_64 | darwin-aarch64 | darwin-x86_64 | linux-x86_64>
import { copyFileSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const key = process.argv[2];
const where = {
  'windows-x86_64': ['nsis', /-setup\.exe$/],
  'darwin-aarch64': ['macos', /\.app\.tar\.gz$/],
  'darwin-x86_64': ['macos', /\.app\.tar\.gz$/],
  'linux-x86_64': ['appimage', /\.AppImage$/],
}[key];
if (!where) throw new Error(`Unknown updater platform: ${key}`);

const root = path.resolve(import.meta.dirname, '..');
const version = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')).version;
const dir = path.join(root, 'src-tauri', 'target', 'release', 'bundle', where[0]);
const bundle = readdirSync(dir).find((f) => where[1].test(f));
if (!bundle) throw new Error(`No updater bundle in ${dir}`);
const signature = readFileSync(path.join(dir, `${bundle}.sig`), 'utf8').trim();

const out = path.join(root, 'updater-out');
mkdirSync(out, { recursive: true });
const ext = bundle.match(/(\.app\.tar\.gz|\.[^.]+)$/)[1];
const file = `GITVerse-by-PRAPAWITY_${version}_${key}${ext}`;
copyFileSync(path.join(dir, bundle), path.join(out, file));
writeFileSync(path.join(out, `${key}.json`), JSON.stringify({ key, file, signature }));
console.log(`${key}: ${file}`);
