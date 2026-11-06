/**
 * Dev-only: macOS takes the bold menu-bar name from the Electron.app bundle, which says "Electron" when you
 * run `npm run dev`. This renames the dev bundle to GITVerse (idempotent; harmless elsewhere).
 * A packaged build gets its name from `productName`, so this is never needed for releases.
 */
const { execFileSync } = require('node:child_process');
const { existsSync } = require('node:fs');
const path = require('node:path');

const NAME = 'GITVerse';
if (process.platform !== 'darwin') process.exit(0);

try {
  const app = path.join(__dirname, '..', 'node_modules', 'electron', 'dist', 'Electron.app');
  const plist = path.join(app, 'Contents', 'Info.plist');
  if (!existsSync(plist)) process.exit(0);
  const buddy = (...a) => execFileSync('/usr/libexec/PlistBuddy', [...a, plist], { encoding: 'utf8' }).trim();
  const get = (k) => { try { return buddy('-c', `Print :${k}`); } catch { return null; } };
  const set = (k, v) => { try { buddy('-c', `Set :${k} ${v}`); } catch { buddy('-c', `Add :${k} string ${v}`); } };

  if (get('CFBundleName') === NAME && get('CFBundleDisplayName') === NAME) process.exit(0); // already done
  set('CFBundleName', NAME);
  set('CFBundleDisplayName', NAME);
  // editing Info.plist breaks the bundle seal; re-sign ad hoc (the dev bundle already is ad hoc) so macOS keeps launching it
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', app], { stdio: 'ignore' });
  console.log(`[brand-electron] dev app renamed to ${NAME}`);
} catch (e) {
  console.warn('[brand-electron] skipped:', e.message); // never block `npm run dev` over a cosmetic step
}
