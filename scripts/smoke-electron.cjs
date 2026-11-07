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
    writeFileSync(path.join(repo, 'stash-tracked.txt'), 'base\n');
    execFileSync('git', ['-C', repo, 'add', '--', 'stash-tracked.txt']);
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
    writeFileSync(path.join(repo, 'stash-tracked.txt'), 'saved change\n');
    writeFileSync(path.join(repo, 'stash-new.txt'), 'saved untracked\n');
    execFileSync('git', [
      '-C',
      repo,
      '-c',
      'user.name=Smoke Test',
      '-c',
      'user.email=smoke@example.com',
      'stash',
      'push',
      '--include-untracked',
      '-m',
      'Smoke stash fixture',
    ]);
    writeFileSync(
      path.join(userData, 'gitverse-state.json'),
      JSON.stringify({
        'gitverse.tabs': JSON.stringify({ repos: [repo], active: repo }),
      }),
    );
    const env = { ...process.env, GITVERSE_SMOKE_DIR: dir };
    delete env.ELECTRON_RUN_AS_NODE;
    for (let run = 0; run < 2; run++) {
      const result = spawnSync(require('electron'), [__filename], {
        env,
        stdio: 'inherit',
        timeout: 60000,
      });
      if (result.error) throw result.error;
      assert.equal(result.status, 0, `Electron smoke run ${run + 1} failed`);
    }
    console.log(
      'Electron smoke passed: bridge, folder dialog, repository restoration, reload, restart, missing-bridge feedback, and development update isolation.',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
} else {
  const { app, BrowserWindow, ipcMain, Menu } = require('electron');
  const dir = process.env.GITVERSE_SMOKE_DIR;
  assert.ok(dir, 'Run this script through npm run test:electron');
  app.setPath('userData', path.join(dir, 'user-data'));
  const repo = path.join(dir, 'reload-fixture');
  let releaseChecks = 0;
  const originalFetch = global.fetch;
  global.fetch = (...args) => {
    if (String(args[0]) === 'https://api.github.com/repos/prapawity/GITVerse/releases/latest') {
      releaseChecks++;
      return Promise.resolve(new Response(null, { status: 404 }));
    }
    return originalFetch(...args);
  };
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
                document.body.textContent.includes('mainHEAD') && !!document.querySelector('canvas') &&
                !document.querySelector('[aria-label="GITVerse launch screen"]')`,
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
        assert.equal(app.isPackaged, false);
        const updateItem = Menu.getApplicationMenu().getMenuItemById('check-for-updates');
        assert.ok(updateItem, 'Update menu item should exist');
        assert.equal(updateItem.enabled, false, 'Development update menu should be disabled');
        updateItem.click(updateItem, win, {});
        await new Promise((resolve) => setImmediate(resolve));
        assert.equal(releaseChecks, 0, 'Development must not request automatic or manual release checks');
        assert.equal(
          await win.webContents.executeJavaScript('window.gitApi.updates.environment().then(value => value.enabled)'),
          false,
        );
        assert.equal(
          await win.webContents.executeJavaScript('window.gitApi.updates.startup().then(value => value.kind)'),
          'development',
        );
        assert.equal(
          await win.webContents.executeJavaScript('window.gitApi.updates.check().then(value => value.kind)'),
          'development',
        );
        assert.equal(releaseChecks, 0, 'Renderer update IPC must stay offline in development');
        const commits = await win.webContents.executeJavaScript(`window.gitApi.log(${JSON.stringify(repo)}, 10, 0)`);
        assert.equal(commits[0].subject, 'Reload smoke fixture');
        assert.equal(
          await win.webContents.executeJavaScript(
            `document.querySelector('footer [aria-label^="App version "]')?.textContent.trim()`,
          ),
          `v${require('../package.json').version}`,
          'Footer version must match package metadata',
        );
        assert.equal(await win.webContents.executeJavaScript(`typeof window.gitApi.openRepoDialog`), 'function');
        assert.equal(await win.webContents.executeJavaScript(`typeof window.gitApi.discardWorkingFiles`), 'function');
        assert.equal(await win.webContents.executeJavaScript(`typeof window.gitApi.discardWorkingHunk`), 'function');
        assert.deepEqual(
          await win.webContents.executeJavaScript(`window.gitApi.fileChangeCounts(${JSON.stringify(repo)})`),
          [],
        );
        await assert.rejects(
          win.webContents.executeJavaScript(`window.gitApi.discardWorkingFiles(${JSON.stringify(repo)}, [])`),
          /Select files to discard/,
        );
        const stashes = await win.webContents.executeJavaScript(
          `window.gitApi.refs(${JSON.stringify(repo)}).then(value => value.stashes)`,
        );
        assert.equal(stashes.length, 1);
        const stash = await win.webContents.executeJavaScript(
          `window.gitApi.stashDetail(${JSON.stringify(repo)}, ${JSON.stringify(stashes[0].hash)})`,
        );
        assert.equal(stash.author, 'Smoke Test');
        assert.deepEqual(stash.files.map((file) => file.path).sort(), ['stash-new.txt', 'stash-tracked.txt']);
        assert.equal(
          await win.webContents.executeJavaScript(
            `window.gitApi.stashFileAt(${JSON.stringify(repo)}, ${JSON.stringify(stash.hash)}, 'stash-new.txt')`,
          ),
          'saved untracked\n',
        );
        assert.equal(
          await win.webContents.executeJavaScript(`!!document.querySelector('button[aria-label^="stash@{0}:"]')`),
          true,
          'Stash node should appear in the graph',
        );
        await win.webContents.executeJavaScript(`document.querySelector('button[aria-label^="stash@{0}:"]').click()`);
        for (let attempt = 0; attempt < 50; attempt++) {
          if (await win.webContents.executeJavaScript(`!!document.querySelector('button[title="stash-new.txt"]')`))
            break;
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
        assert.equal(
          await win.webContents.executeJavaScript(
            `!!document.querySelector('button[title="stash-new.txt"]') && !!document.querySelector('canvas') && document.body.textContent.includes('Smoke Test')`,
          ),
          true,
          'Stash selection should keep graph visible and show metadata/files',
        );
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
