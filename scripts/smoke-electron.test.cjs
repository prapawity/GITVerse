const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const { runInNewContext } = require('node:vm');

const filename = path.join(__dirname, 'smoke-electron.cjs');
const source = readFileSync(filename, 'utf8');

test('dev branding preserves the executable helper prefix while updating the display name', () => {
  const values = {
    CFBundleExecutable: 'Electron',
    CFBundleName: 'GITVerse',
    CFBundleDisplayName: 'GITVerse by PRAPAWITY',
  };
  let signatures = 0;
  runInNewContext(readFileSync(path.join(__dirname, 'brand-electron.cjs'), 'utf8'), {
    __dirname,
    process: { platform: 'darwin', exit: () => assert.fail('Unexpected early exit') },
    console: { log() {}, warn: (message) => assert.fail(message) },
    require(name) {
      if (name === 'node:fs') return { existsSync: () => true };
      if (name === 'node:child_process') {
        return {
          execFileSync(binary, args) {
            if (binary === 'codesign') {
              signatures++;
              return '';
            }
            const [action, field, ...value] = args[1].split(' ');
            const key = field.slice(1);
            if (action === 'Print') return values[key];
            values[key] = value.join(' ');
            return '';
          },
        };
      }
      return require(name);
    },
  });
  assert.equal(values.CFBundleName, values.CFBundleExecutable);
  assert.equal(values.CFBundleDisplayName, 'GITVerse by PRAPAWITY');
  assert.equal(signatures, 1);
});

for (const value of [undefined, '', '1']) {
  test(`smoke launcher removes Node mode when inherited value is ${JSON.stringify(value)}`, () => {
    const env = { PATH: 'preserved-path' };
    if (value !== undefined) env.ELECTRON_RUN_AS_NODE = value;
    let launches = 0;
    runInNewContext(source, {
      __filename: filename,
      process: { versions: {}, env },
      console: { log() {} },
      require(name) {
        if (name === 'electron') return 'electron-binary';
        if (name === 'node:fs') {
          return {
            mkdtempSync: () => 'smoke-fixture',
            mkdirSync() {},
            writeFileSync() {},
            rmSync() {},
          };
        }
        if (name === 'node:child_process') {
          return {
            execFileSync() {},
            spawnSync(binary, args, options) {
              assert.equal(binary, 'electron-binary');
              assert.equal(args[0], filename);
              assert.equal(Object.hasOwn(options.env, 'ELECTRON_RUN_AS_NODE'), false);
              assert.equal(options.env.PATH, env.PATH);
              assert.equal(options.env.GITVERSE_SMOKE_DIR, 'smoke-fixture');
              launches++;
              return { status: 0 };
            },
          };
        }
        return require(name);
      },
    });
    assert.equal(launches, 2);
    assert.equal(env.ELECTRON_RUN_AS_NODE, value);
  });
}
