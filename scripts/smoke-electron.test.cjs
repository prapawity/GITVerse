const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const { runInNewContext } = require('node:vm');

const filename = path.join(__dirname, 'smoke-electron.cjs');
const source = readFileSync(filename, 'utf8');

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
