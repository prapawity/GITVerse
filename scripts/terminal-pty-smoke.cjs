const { spawnSync } = require('node:child_process');
const { mkdtempSync, readFileSync, writeFileSync, rmSync } = require('node:fs');
const os = require('node:os');
const path = require('node:path');

if (process.env.GITVERSE_PTY_SMOKE) {
  const { app } = require('electron');
  app.setPath('userData', process.env.GITVERSE_PTY_SMOKE);
  app.whenReady().then(() => {
    const resultPath = path.join(process.env.GITVERSE_PTY_SMOKE, 'result.txt');
    try {
      const pty = require('node-pty');
      const shell = process.platform === 'win32' ? process.env.ComSpec : '/bin/sh';
      const terminal = pty.spawn(shell, [], {
        name: 'xterm-256color',
        cols: 80,
        rows: 24,
        cwd: process.env.GITVERSE_PTY_SMOKE,
        env: process.env,
      });
      let output = '';
      const timeout = setTimeout(() => finish('Timed out waiting for shell output'), 10000);
      function finish(error) {
        clearTimeout(timeout);
        writeFileSync(resultPath, error || 'ok');
        try { terminal.kill(); } catch { /* already exited */ }
        app.exit(error ? 1 : 0);
      }
      terminal.onData((data) => {
        output += data;
        if (/PTY_SMOKE_OK/.test(output)) finish();
      });
      terminal.resize(100, 30);
      setTimeout(() => terminal.write(process.platform === 'win32' ? 'echo PTY_%ComSpec:~0,0%SMOKE_OK\r' : "printf 'PTY_%s_OK\\n' SMOKE\r"), 500);
    } catch (error) {
      writeFileSync(resultPath, String(error.stack || error));
      app.exit(1);
    }
  });
} else {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'gitverse-pty-smoke-'));
  try {
    const child = spawnSync(require('electron'), [__filename], {
      env: { ...process.env, GITVERSE_PTY_SMOKE: dir },
      timeout: 20000,
    });
    const result = readFileSync(path.join(dir, 'result.txt'), 'utf8');
    if (child.error || child.status !== 0 || result !== 'ok') throw new Error(result);
    console.log('Electron PTY smoke passed: interactive shell input, output, and resize.');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
