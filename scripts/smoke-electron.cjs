const assert = require('node:assert/strict');
const { execFileSync, spawnSync } = require('node:child_process');
const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = require('node:fs');
const os = require('node:os');
const path = require('node:path');

if (!process.versions.electron) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'gitverse-smoke-'));
  try {
    const repo = path.join(dir, 'reload-fixture');
    const userData = path.join(dir, 'user-data');
    mkdirSync(repo);
    mkdirSync(userData);
    execFileSync('git', ['init', '-b', 'main', repo]);
    execFileSync('git', [
      '-C',
      repo,
      '-c',
      'user.name=Smoke Test',
      '-c',
      'user.email=smoke@example.com',
      'commit',
      '--allow-empty',
      '-m',
      'Reload smoke fixture',
    ]);
    writeFileSync(
      path.join(userData, 'gitverse-state.json'),
      JSON.stringify({
        'gitverse.tabs': JSON.stringify({ repos: [repo], active: repo }),
      }),
    );
    for (let run = 0; run < 2; run++) {
      const result = spawnSync(require('electron'), [__filename], {
        env: { ...process.env, GITVERSE_SMOKE_DIR: dir, ELECTRON_RUN_AS_NODE: '' },
        stdio: 'inherit',
        timeout: 60000,
      });
      if (result.error) throw result.error;
      assert.equal(result.status, 0, `Electron smoke run ${run + 1} failed`);
    }
    console.log(
      'Electron smoke passed: bridge, folder dialog, repository restoration, reload, restart, and missing-bridge feedback.',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
} else {
  const { app, BrowserWindow, ipcMain } = require('electron');
  const dir = process.env.GITVERSE_SMOKE_DIR;
  assert.ok(dir, 'Run this script through npm run test:electron');
  app.setPath('userData', path.join(dir, 'user-data'));
  const repo = path.join(dir, 'reload-fixture');
  const timeout = setTimeout(() => {
    console.error('Electron smoke timed out');
    app.exit(1);
  }, 45000);
  app.once('browser-window-created', (_event, win) => {
    win.webContents.on('preload-error', (_event, file, error) => console.error('Preload failed:', file, error));
    win.webContents.on('console-message', (event) => {
      if (event.level === 'error') console.error('Renderer:', event.message);
    });
    win.webContents.once('did-finish-load', async () => {
      try {
        const checkRestored = async () => {
          for (let attempt = 0; attempt < 100; attempt++) {
            if (
              await win.webContents.executeJavaScript(
                `document.body.textContent.includes(${JSON.stringify(repo)}) &&
                document.body.textContent.includes('mainHEAD') && !!document.querySelector('canvas')`,
              )
            )
              return;
            await new Promise((resolve) => setTimeout(resolve, 100));
          }
          assert.fail(
            `Saved repository history was not restored: ${await win.webContents.executeJavaScript(
              'document.body.textContent',
            )}`,
          );
        };
        await checkRestored();
        const commits = await win.webContents.executeJavaScript(`window.gitApi.log(${JSON.stringify(repo)}, 10, 0)`);
        assert.equal(commits[0].subject, 'Reload smoke fixture');
        assert.equal(await win.webContents.executeJavaScript(`typeof window.gitApi.openRepoDialog`), 'function');
        ipcMain.removeHandler('repo:open');
        ipcMain.handle('repo:open', () => repo);
        assert.equal(await win.webContents.executeJavaScript('window.gitApi.openRepoDialog()'), repo);
        const loaded = new Promise((resolve) => win.webContents.once('did-finish-load', resolve));
        win.webContents.reload();
        await loaded;
        await checkRestored();
        const tabs = await win.webContents.executeJavaScript(
          `JSON.parse(window.gitApi.stateStorage.getItem('gitverse.tabs'))`,
        );
        assert.deepEqual(tabs, { repos: [repo], active: repo });
        const unbridged = new BrowserWindow({ show: false, webPreferences: { contextIsolation: true } });
        await unbridged.loadFile(path.join(__dirname, '../dist/index.html'));
        assert.equal(
          await unbridged.webContents.executeJavaScript(`document.querySelector('h1')?.textContent`),
          'GITVerse could not start',
        );
        console.log('Electron smoke run passed');
        clearTimeout(timeout);
        app.exit(0);
      } catch (error) {
        console.error(error);
        clearTimeout(timeout);
        app.exit(1);
      }
    });
  });
  require('../dist-electron/main/main.js');
}
