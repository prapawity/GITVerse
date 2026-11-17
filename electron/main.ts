import { app, BrowserWindow, dialog, ipcMain, Menu, shell } from 'electron';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import * as git from './git/git';
import { reflog } from './git/reflog';
import { inspectWorkspace } from './git/workspaceInspection';
import { registerTerminal } from './terminal';
import { loadState, saveKey } from './state';
import { registerAi } from './ai';
import { readSecret, writeSecret } from './ai/common';
import { checkAppUpdate, downloadMacUpdate, isReleaseDownloadUrl, listReleases, RELEASES_URL } from './updates';
import type { AppUpdateCheck } from '../src/shared/updates';
import { scanRepositories } from './repositoryScan';

// name shown in the macOS menu bar, About box and dock (a packaged build also gets it from productName)
app.setName('GITVerse');
const appIcon = app.isPackaged
  ? path.join(process.resourcesPath, 'icon.png')
  : path.join(__dirname, '../../resources/icon.png');

try {
  const saved = JSON.parse(loadState(app.getPath('userData'))['gitverse.settings'] ?? '{}').state;
  const profile = saved?.sharedIdentityProfiles?.find((p: { id: string }) => p.id === saved.activeIdentityProfile);
  if (profile) git.setActiveIdentity({ name: profile.authorName, email: profile.email });
} catch {
  /* use Git configuration if saved settings cannot be read */
}

ipcMain.handle('profile:setIdentity', (_e, identity: { name: string; email: string } | null) =>
  git.setActiveIdentity(identity),
);

const handlers = {
  log: git.log,
  status: git.status,
  commit: git.commit,
  stagedForCommitMessage: git.stagedForCommitMessage,
  checkout: git.checkout,
  checkoutRemote: git.checkoutRemote,
  windowsUnsupportedPathsForRef: git.windowsUnsupportedPathsForRef,
  stage: git.stage,
  unstage: git.unstage,
  trackedStage: git.trackedStage,
  indexUndoState: git.indexUndoState,
  moveIndexHistory: git.moveIndexHistory,
  refs: git.refs,
  reflog,
  inspectWorkspace,
  historyPosition: git.historyPosition,
  agentCheckpoints: git.agentCheckpoints,
  commitDetail: git.commitDetail,
  commitFileDiff: git.commitFileDiff,
  workingFileDiff: git.workingFileDiff,
  fileChangeCounts: git.fileChangeCounts,
  discardWorkingFiles: git.discardWorkingFiles,
  discardWorkingHunk: git.discardWorkingHunk,
  stageWorkingHunk: git.stageWorkingHunk,
  fetch: git.fetch,
  pull: git.pull,
  push: git.push,
  pushInfo: git.pushInfo,
  commitIdentity: git.commitIdentity,
  setCommitIdentity: git.setCommitIdentity,
  createBranch: git.createBranch,
  stash: git.stash,
  stashPop: git.stashPop,
  stashAction: git.stashAction,
  stashRename: git.stashRename,
  reset: git.reset,
  squashCommits: git.squashCommits,
  cherryPick: git.cherryPick,
  cherryPickMany: git.cherryPickMany,
  tagCommit: git.tagCommit,
  stashDiff: git.stashDiff,
  stashDetail: git.stashDetail,
  stashFileDiff: git.stashFileDiff,
  stashFileAt: git.stashFileAt,
  revert: git.revert,
  rebaseOnto: git.rebaseOnto,
  rebasePreview: git.rebasePreview,
  createTag: git.createTag,
  branchAt: git.branchAt,
  fileAt: git.fileAt,
  fileBlobAt: git.fileBlobAt,
  workingFileBlob: git.workingFileBlob,
  worktreeAdd: git.worktreeAdd,
  remoteUrl: git.remoteUrl,
  formatPatch: git.formatPatch,
  createAnnotatedTag: git.createAnnotatedTag,
  fileBlame: git.fileBlame,
  fileHistory: git.fileHistory,
  opState: git.opState,
  opContinue: git.opContinue,
  opAbort: git.opAbort,
  opSkip: git.opSkip,
  resolveFile: git.resolveFile,
  merge: git.merge,
  deleteBranch: git.deleteBranch,
  deleteRemoteBranch: git.deleteRemoteBranch,
  readWorkFile: git.readWorkFile,
  writeWorkFile: git.writeWorkFile,
} as const;

for (const [name, fn] of Object.entries(handlers)) {
  ipcMain.handle(`git:${name}`, (_e, ...args) => (fn as (...a: any[]) => unknown)(...args));
}
// open a conflicted file in the user's editor; refuse paths that escape the repository
ipcMain.handle('repo:openFile', async (_e, cwd: string, rel: string) => {
  const full = path.resolve(cwd, rel);
  if (!full.startsWith(path.resolve(cwd) + path.sep)) throw new Error('Path is outside the repository');
  const err = await shell.openPath(full);
  if (err) throw new Error(err);
});
ipcMain.handle('app:openThirdPartyNotices', async () => {
  const noticesPath = app.isPackaged
    ? path.join(process.resourcesPath, 'THIRD_PARTY_NOTICES.txt')
    : path.resolve(__dirname, '../../build-notices/THIRD_PARTY_NOTICES.txt');
  if (!existsSync(noticesPath)) throw new Error('Third-party notices are unavailable in this build.');
  const err = await shell.openPath(noticesPath);
  if (err) throw new Error(err);
});
ipcMain.handle('app:openRuntimeNotice', async (_e, kind: 'electron' | 'chromium') => {
  const filename = kind === 'electron' ? 'LICENSE.electron.txt' : kind === 'chromium' ? 'LICENSES.chromium.html' : null;
  if (!filename) throw new Error('Unknown runtime notice.');
  const noticesPath = app.isPackaged
    ? path.join(process.resourcesPath, filename)
    : path.resolve(__dirname, '../../node_modules/electron/dist', kind === 'electron' ? 'LICENSE' : filename);
  if (!existsSync(noticesPath)) throw new Error('Runtime license notices are unavailable in this build.');
  const err = await shell.openPath(noticesPath);
  if (err) throw new Error(err);
});
registerTerminal();
registerAi();

// persisted UI state (settings, open tabs): read synchronously at startup so the renderer can hydrate before first paint
ipcMain.on('state:load', (e) => {
  e.returnValue = loadState(app.getPath('userData'));
});
ipcMain.on('state:save', (_e, key: string, value: string | null) => {
  try {
    saveKey(app.getPath('userData'), String(key), value == null ? null : String(value));
  } catch {
    /* disk full / read-only: keep running */
  }
});

ipcMain.handle('repo:open', async () => {
  const r = await dialog.showOpenDialog({ properties: ['openDirectory'] });
  return r.canceled ? null : r.filePaths[0];
});

const scans = new Map<number, { id: string; controller: AbortController }>();
ipcMain.on('repo:cancelScan', (event, id: string) => {
  const scan = scans.get(event.sender.id);
  if (scan?.id === id) scan.controller.abort();
});
ipcMain.handle('repo:findRepositories', async (event, folder: string, id: string) => {
  if (typeof id !== 'string' || !id || scans.has(event.sender.id))
    throw new Error('A folder scan is already running or the request is invalid.');
  const controller = new AbortController();
  const senderId = event.sender.id;
  const abort = () => controller.abort();
  scans.set(senderId, { id, controller });
  event.sender.once('destroyed', abort);
  try {
    return await scanRepositories(folder, controller.signal, (progress) => {
      if (!event.sender.isDestroyed()) event.sender.send('repo:scanProgress', id, progress);
    });
  } finally {
    event.sender.removeListener('destroyed', abort);
    scans.delete(senderId);
  }
});

ipcMain.handle('repo:clone', (event, url: string, destination: string) =>
  git.clone(url, destination, (message) => {
    if (!event.sender.isDestroyed()) event.sender.send('repo:cloneProgress', message);
  }),
);

const pushTokenKey = (repo: string, id: string) =>
  `push.token.${createHash('sha256')
    .update(JSON.stringify([repo, id]))
    .digest('hex')}`;
ipcMain.handle('push:tokenStatus', (_e, repo: string, id: string) => !!readSecret(pushTokenKey(repo, id)));
ipcMain.handle('push:setToken', (_e, repo: string, id: string, token: string | null) =>
  writeSecret(pushTokenKey(repo, id), token?.trim() || null),
);
ipcMain.handle('push:chooseKey', async () => {
  const result = await dialog.showOpenDialog({ properties: ['openFile'], title: 'Choose SSH private key' });
  return result.canceled ? null : result.filePaths[0];
});
ipcMain.handle(
  'push:branch',
  (
    _e,
    repo: string,
    remote: string,
    branch: string,
    target: string,
    profile?: { id: string; kind: 'system' | 'ssh' | 'https'; username: string; sshKey: string },
    credentials?: { username: string; password: string },
    options?: { forceWithLease?: boolean; expectedRemoteHash?: string },
  ) =>
    git.pushBranch(
      repo,
      remote,
      branch,
      target,
      credentials
        ? { kind: 'https', username: credentials.username, token: credentials.password }
        : profile && {
            ...profile,
            token: profile.kind === 'https' ? (readSecret(pushTokenKey(repo, profile.id)) ?? undefined) : undefined,
          },
      options,
    ),
);

app.whenReady().then(async () => {
  if (process.platform === 'darwin') app.dock?.setIcon(appIcon);
  let startupUpdate: Promise<AppUpdateCheck> | null = null;
  let manualUpdate: Promise<AppUpdateCheck> | null = null;
  const requestUpdate = () => {
    if (!manualUpdate)
      manualUpdate = checkAppUpdate(app.getVersion(), app.isPackaged).finally(() => {
        manualUpdate = null;
      });
    return manualUpdate;
  };
  const updater = app.isPackaged ? (await import('electron-updater')).autoUpdater : null;
  if (updater) {
    updater.autoDownload = false;
    updater.autoInstallOnAppQuit = false;
    updater.allowPrerelease = false;
  }
  let macInstaller: string | null = null;
  let downloading = false;
  const sendUpdateStatus = (status: { state: string; percent?: number; version?: string; message?: string }) => {
    if (!win.isDestroyed()) win.webContents.send('updates:status', status);
  };
  updater?.on('download-progress', ({ percent }) => sendUpdateStatus({ state: 'downloading', percent }));
  updater?.on('update-downloaded', (info) => sendUpdateStatus({ state: 'downloaded', version: info.version }));
  const downloadUpdate = async (version: string) => {
    if (!app.isPackaged) throw new Error('Updates are only available in packaged builds.');
    if (downloading) throw new Error('An update is already downloading.');
    downloading = true;
    try {
      const latest = await requestUpdate();
      if (latest.kind !== 'optional' || latest.version !== version) throw new Error('Check for updates again.');
      sendUpdateStatus({ state: 'downloading', percent: 0, version });
      if (process.platform === 'darwin') {
        macInstaller = null;
        macInstaller = await downloadMacUpdate(version, process.arch, app.getPath('downloads'), (percent) => {
          if (!win.isDestroyed()) win.setProgressBar(percent / 100);
          sendUpdateStatus({ state: 'downloading', percent, version });
        });
        sendUpdateStatus({ state: 'downloaded', version });
      } else {
        if (!updater) throw new Error('Updates are only available in packaged builds.');
        const result = await updater.checkForUpdates();
        if (!result || result.updateInfo.version !== version)
          throw new Error('This release is not available for this platform.');
        await updater.downloadUpdate();
      }
    } finally {
      downloading = false;
      if (!win.isDestroyed()) win.setProgressBar(-1);
    }
  };
  const installUpdate = async () => {
    if (process.platform === 'darwin') {
      if (!macInstaller) throw new Error('Download an update first.');
      const error = await shell.openPath(macInstaller);
      if (error) throw new Error(error);
      return;
    }
    if (!updater) throw new Error('Updates are only available in packaged builds.');
    updater.quitAndInstall(false, true);
  };
  ipcMain.handle('updates:download', (_event, version: string) => downloadUpdate(version));
  ipcMain.handle('updates:install', () => installUpdate());
  ipcMain.handle('updates:environment', () => ({
    enabled: app.isPackaged,
    currentVersion: app.getVersion(),
    manualInstall: process.platform === 'darwin',
  }));
  ipcMain.handle('updates:startup', () => (startupUpdate ??= requestUpdate()));
  ipcMain.handle('updates:check', () => requestUpdate());
  ipcMain.handle('updates:list', () => listReleases());
  ipcMain.handle('updates:openReleaseList', () => shell.openExternal(RELEASES_URL));
  ipcMain.handle('updates:openDownloads', (_event, url: string) => {
    if (!isReleaseDownloadUrl(url)) throw new Error('Invalid release download URL.');
    return shell.openExternal(url);
  });
  let checking = false;
  const checkUpdates = async (manual: boolean) => {
    if (!app.isPackaged || checking) return;
    checking = true;
    try {
      const update = await requestUpdate();
      if (win.isDestroyed()) return;
      if (update.kind === 'error') throw new Error(update.message);
      if (update.kind === 'optional') {
        const { response } = await dialog.showMessageBox(win, {
          type: 'info',
          title: 'Update available',
          message: `GITVerse ${update.version} is available`,
          detail:
            process.platform === 'darwin'
              ? 'Download the installer, then quit GITVerse and drag the new app to Applications.'
              : `You are using ${app.getVersion()}. Download and install the update from the app, or choose Later.`,
          buttons: ['Download update', 'Later'],
          defaultId: 0,
          cancelId: 1,
        });
        if (response === 0) {
          try {
            await downloadUpdate(update.version);
            const { response: install } = await dialog.showMessageBox(win, {
              type: 'info',
              message: 'Update downloaded',
              detail:
                process.platform === 'darwin'
                  ? 'Open the installer, quit GITVerse, then drag the new app to Applications.'
                  : 'Restart GITVerse to install the update.',
              buttons: [process.platform === 'darwin' ? 'Open installer' : 'Restart and install', 'Later'],
              cancelId: 1,
            });
            if (install === 0) await installUpdate();
          } catch (error) {
            await dialog.showMessageBox(win, {
              type: 'warning',
              message: 'Could not install the update',
              detail: String(error),
            });
          }
        }
      } else if (manual && update.kind === 'current') {
        await dialog.showMessageBox(win, {
          type: 'info',
          message: 'No newer stable release is available.',
          detail: `Current version: ${app.getVersion()}`,
        });
      }
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      console.error('[updates]', detail);
      if (!win.isDestroyed()) {
        await dialog.showMessageBox(win, {
          type: 'warning',
          message: 'Could not check for updates',
          detail: `${detail}\nYou can continue using GITVerse and retry from Help > Check for Updates.`,
          buttons: ['Continue'],
          cancelId: 0,
          defaultId: 0,
        });
      }
    } finally {
      checking = false;
    }
  };
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      ...(process.platform === 'darwin' ? [{ role: 'appMenu' as const }] : []),
      { role: 'fileMenu' as const },
      { role: 'editMenu' as const },
      { role: 'viewMenu' as const },
      { role: 'windowMenu' as const },
      {
        role: 'help' as const,
        submenu: [
          {
            id: 'check-for-updates',
            label: 'Check for Updates…',
            enabled: app.isPackaged,
            click: () => {
              void checkUpdates(true);
            },
          },
          { label: 'Download another version…', click: () => void shell.openExternal(RELEASES_URL) },
        ],
      },
    ]),
  );
  const win = new BrowserWindow({
    title: 'GITVerse',
    icon: appIcon,
    width: 1500,
    height: 900,
    backgroundColor: '#1e1e2e',
    webPreferences: { preload: path.join(__dirname, '../preload/preload.js'), contextIsolation: true },
  });
  if (process.env.VITE_DEV_SERVER_URL) win.loadURL(process.env.VITE_DEV_SERVER_URL);
  else win.loadFile(path.join(__dirname, '../../dist/index.html'));
});
