const fs = require('node:fs');
const path = require('node:path');

function findNoticeFiles(directory, root = directory) {
  const found = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== 'node_modules' && entry.name !== '.git') found.push(...findNoticeFiles(file, root));
      continue;
    }
    if (!entry.isFile() || !/(?:^|[._-])(?:licen[cs]e|copying|notice)(?:[._-]|$)/i.test(entry.name)) continue;
    found.push(path.relative(root, file));
  }
  return found;
}

module.exports = async function generateThirdPartyNotices() {
  // Include build-time packages as well as runtime dependencies: bundlers can
  // incorporate their code into the application. Platform-specific packages
  // are collected on the machine producing each release artifact.
  const root = path.resolve(__dirname, '..');
  const packages = require('../package-lock.json').packages;
  const sections = [
    'Third-party software notices\n\nThis inventory includes installed npm packages used to build or run GITVerse. It may include packages not present in the final application. License identifiers are package metadata, not a substitute for the license text. Electron and Chromium notices are also distributed with the Electron runtime.\n',
  ];
  const missing = [];
  for (const [location, metadata] of Object.entries(packages)) {
    if (!location) continue;
    const directory = path.join(root, location);
    if (!fs.existsSync(directory)) continue;
    const manifestPath = path.join(directory, 'package.json');
    if (!fs.existsSync(manifestPath)) continue;
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    const files = findNoticeFiles(directory);
    const hasRootLicense = files.some(
      (name) => !name.includes(path.sep) && /^(licen[cs]e|copying)(\.|$)/i.test(path.basename(name)),
    );
    const title = `${manifest.name || location} ${manifest.version || metadata.version || ''}`;
    sections.push(`\n${'='.repeat(72)}\n${title}\nLicense: ${manifest.license || metadata.license || 'UNKNOWN'}\n`);
    if (!hasRootLicense) {
      missing.push(title);
      sections.push(
        'License text was not supplied in this installed package; review the upstream license before distribution.\n',
      );
    }
    for (const name of files) {
      sections.push(`\n--- ${name} ---\n${fs.readFileSync(path.join(directory, name), 'utf8')}\n`);
    }
  }
  const output = path.join(root, 'build-notices', 'THIRD_PARTY_NOTICES.txt');
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, sections.join(''));
  if (missing.length) console.warn(`License text missing from ${missing.length} installed packages; see ${output}`);
};
