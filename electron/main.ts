import { app, BrowserWindow, dialog, ipcMain, Menu, shell } from 'electron';
import path from 'node:path';
import { createHash } from 'node:crypto';
import * as git from './git/git';
import { registerTerminal } from './terminal';
import { loadState, saveKey } from './state';
import { registerAi } from './ai';
import { readSecret, writeSecret } from './ai/common';
import { checkForRelease } from './updates';
import { scanRepositories } from './repositoryScan';

// name shown in the macOS menu bar, About box and dock (a packaged build also gets it from productName)
app.setName('GITVerse');

try {
  const saved = JSON.parse(loadState(app.getPath('userData'))['gitverse.settings'] ?? '{}').state;
  const profile = saved?.sharedIdentityProfiles?.find((p: { id: string }) => p.id === saved.activeIdentityProfile);
  if (profile) git.setActiveIdentity({ name: profile.authorName, email: profile.email });
} catch { /* use Git configuration if saved settings cannot be read */ }

ipcMain.handle('profile:setIdentity', (_e, identity: { name: string; email: string } | null) => git.setActiveIdentity(identity));

const handlers = {
  log: git.log,
  status: git.status,
  commit: git.commit,
  stagedForCommitMessage: git.stagedForCommitMessage,
  checkout: git.checkout,
  checkoutRemote: git.checkoutRemote,
  stage: git.stage,
  unstage: git.unstage,
  trackedStage: git.trackedStage,
  indexUndoState: git.indexUndoState,
  moveIndexHistory: git.moveIndexHistory,
  refs: git.refs,
  historyPosition: git.historyPosition,
  agentCheckpoints: git.agentCheckpoints,
  commitDetail: git.commitDetail,
  commitFileDiff: git.commitFileDiff,
  workingFileDiff: git.workingFileDiff,
  fetch: git.fetch,
  pull: git.pull,
  push: git.push,
  pushInfo: git.pushInfo,
  commitIdentity: git.commitIdentity,
  setCommitIdentity: git.setCommitIdentity,
  createBranch: git.createBranch,
  stash: git.stash,
  stashPop: git.stashPop,
  reset: git.reset,
  squashCommits: git.squashCommits,
  cherryPick: git.cherryPick,
  cherryPickMany: git.cherryPickMany,
  tagCommit: git.tagCommit,
  stashDiff: git.stashDiff,
  revert: git.revert,
  rebaseOnto: git.rebaseOnto,
  createTag: git.createTag,
  branchAt: git.branchAt,
  fileAt: git.fileAt,
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
registerTerminal();
registerAi();

// persisted UI state (settings, open tabs): read synchronously at startup so the renderer can hydrate before first paint
ipcMain.on('state:load', (e) => { e.returnValue = loadState(app.getPath('userData')); });
ipcMain.on('state:save', (_e, key: string, value: string | null) => {
  try { saveKey(app.getPath('userData'), String(key), value == null ? null : String(value)); } catch { /* disk full / read-only: keep running */ }
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
  if (typeof id !== 'string' || !id || scans.has(event.sender.id)) throw new Error('A folder scan is already running or the request is invalid.');
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
  git.clone(url, destination, (message) => { if (!event.sender.isDestroyed()) event.sender.send('repo:cloneProgress', message); }));

const pushTokenKey = (repo: string, id: string) => `push.token.${createHash('sha256').update(JSON.stringify([repo, id])).digest('hex')}`;
ipcMain.handle('push:tokenStatus', (_e, repo: string, id: string) => !!readSecret(pushTokenKey(repo, id)));
ipcMain.handle('push:setToken', (_e, repo: string, id: string, token: string | null) => writeSecret(pushTokenKey(repo, id), token?.trim() || null));
ipcMain.handle('push:chooseKey', async () => {
  const result = await dialog.showOpenDialog({ properties: ['openFile'], title: 'Choose SSH private key' });
  return result.canceled ? null : result.filePaths[0];
});
ipcMain.handle('push:branch', (_e, repo: string, remote: string, branch: string, target: string, profile?: { id: string; kind: 'system' | 'ssh' | 'https'; username: string; sshKey: string }, credentials?: { username: string; password: string }) =>
  git.pushBranch(repo, remote, branch, target, credentials ? { kind: 'https', username: credentials.username, token: credentials.password } : profile && { ...profile, token: profile.kind === 'https' ? readSecret(pushTokenKey(repo, profile.id)) ?? undefined : undefined }));

app.whenReady().then(() => {
  let checking = false;
  const checkUpdates = async (manual: boolean) => {
    if (checking) return;
    checking = true;
    try {
      const update = await checkForRelease(app.getVersion());
      if (win.isDestroyed()) return;
      if (update) {
        const { response } = await dialog.showMessageBox(win, {
          type: 'info',
          title: 'Update available',
          message: `GITVerse ${update.version} is available`,
          detail: `You are using ${app.getVersion()}. Open GitHub Releases to download the installer for your platform. Quit GITVerse before installing; no files will be replaced automatically.`,
          buttons: ['Open downloads', 'Later'],
          defaultId: 0,
          cancelId: 1,
        });
        if (response === 0) await shell.openExternal(update.url);
      } else if (manual) {
        await dialog.showMessageBox(win, { type: 'info', message: 'No newer stable release is available.', detail: `Current version: ${app.getVersion()}` });
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
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    ...(process.platform === 'darwin' ? [{ role: 'appMenu' as const }] : []),
    { role: 'fileMenu' as const },
    { role: 'editMenu' as const },
    { role: 'viewMenu' as const },
    { role: 'windowMenu' as const },
    { role: 'help' as const, submenu: [
      { label: 'Check for Updates…', click: () => { void checkUpdates(true); } },
    ] },
  ]));
  const win = new BrowserWindow({
    title: 'GITVerse',
    width: 1500,
    height: 900,
    backgroundColor: '#1e1e2e',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true },
  });
  win.webContents.once('did-finish-load', () => {
    if (app.isPackaged) void checkUpdates(false);
  });
  if (process.env.VITE_DEV_SERVER_URL) win.loadURL(process.env.VITE_DEV_SERVER_URL);
  else win.loadFile(path.join(__dirname, '../dist/index.html'));
});
