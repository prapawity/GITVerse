const { createHash } = require('node:crypto');
const { readdirSync, readFileSync, writeFileSync } = require('node:fs');
const path = require('node:path');

const label = process.argv[2];
if (!/^(mac-(arm64|x64)|win-x64|linux-x64)$/.test(label ?? '')) {
  throw new Error('Expected mac-arm64, mac-x64, win-x64, or linux-x64.');
}
const dir = path.join(__dirname, '..', 'release');
const { version } = require('../package.json');
const prefix = `GITVerse-${version}-${label}.`;
const files = readdirSync(dir)
  .filter((name) => name.startsWith(prefix) && /\.(dmg|zip|exe|AppImage)$/.test(name))
  .sort();
if (!files.length) throw new Error('No installers found.');
const sums = files.map(
  (name) =>
    `${createHash('sha256')
      .update(readFileSync(path.join(dir, name)))
      .digest('hex')}  ${name}`,
);
writeFileSync(path.join(dir, `SHA256SUMS-${label}.txt`), sums.join('\n') + '\n');
