import { contextBridge, ipcRenderer, webUtils } from 'electron';
import type { ScanProgress } from '../src/shared/repositoryScan';
import { GIT_METHODS } from '../src/shared/gitMethods';

const gitApi: Record<string, (...a: unknown[]) => Promise<any>> = {
  openRepoDialog: () => ipcRenderer.invoke('repo:open'),
  openThirdPartyNotices: () => ipcRenderer.invoke('app:openThirdPartyNotices'),
  openRuntimeNotice: (kind: unknown) => ipcRenderer.invoke('app:openRuntimeNotice', kind),
  cloneRepo: (url: unknown, destination: unknown, credentials?: unknown, options?: unknown) =>
    ipcRenderer.invoke('repo:clone', url, destination, credentials, options),
  editors: () => ipcRenderer.invoke('app:editors'),
  openIn: (editor: unknown, target: unknown) => ipcRenderer.invoke('app:openIn', editor, target),
  setZoom: (factor: unknown) => ipcRenderer.invoke('app:setZoom', factor),
  openFile: (...a) => ipcRenderer.invoke('repo:openFile', ...a),
};
(gitApi as any).onCloneProgress = (cb: (message: string) => void) => {
  const handler = (_event: unknown, message: string) => cb(message);
  ipcRenderer.on('repo:cloneProgress', handler);
  return () => ipcRenderer.removeListener('repo:cloneProgress', handler);
};
(gitApi as any).pathForFile = (file: File) => webUtils.getPathForFile(file);
(gitApi as any).updates = {
  environment: () => ipcRenderer.invoke('updates:environment'),
  startup: () => ipcRenderer.invoke('updates:startup'),
  check: () => ipcRenderer.invoke('updates:check'),
  list: () => ipcRenderer.invoke('updates:list'),
  openReleaseList: () => ipcRenderer.invoke('updates:openReleaseList'),
  openDownloads: (url: string) => ipcRenderer.invoke('updates:openDownloads', url),
  download: (version: string) => ipcRenderer.invoke('updates:download', version),
  install: () => ipcRenderer.invoke('updates:install'),
  onStatus: (cb: (status: { state: string; percent?: number; version?: string; message?: string }) => void) => {
    const handler = (
      _event: unknown,
      status: { state: string; percent?: number; version?: string; message?: string },
    ) => cb(status);
    ipcRenderer.on('updates:status', handler);
    return () => ipcRenderer.removeListener('updates:status', handler);
  },
};
(gitApi as any).findRepositories = (folder: string, id: string) =>
  ipcRenderer.invoke('repo:findRepositories', folder, id);
(gitApi as any).cancelScan = (id: string) => ipcRenderer.send('repo:cancelScan', id);
(gitApi as any).onScanProgress = (cb: (id: string, progress: ScanProgress) => void) => {
  const handler = (_event: unknown, id: string, progress: ScanProgress) => cb(id, progress);
  ipcRenderer.on('repo:scanProgress', handler);
  return () => ipcRenderer.removeListener('repo:scanProgress', handler);
};
for (const n of GIT_METHODS) gitApi[n] = (...a) => ipcRenderer.invoke(`git:${n}`, ...a);
(gitApi as any).setActiveIdentity = (identity: { name: string; email: string } | null) =>
  ipcRenderer.invoke('profile:setIdentity', identity);
(gitApi as any).pushProfiles = {
  tokenStatus: (repo: string, id: string) => ipcRenderer.invoke('push:tokenStatus', repo, id),
  setToken: (repo: string, id: string, token: string | null) => ipcRenderer.invoke('push:setToken', repo, id, token),
  chooseKey: () => ipcRenderer.invoke('push:chooseKey'),
  push: (
    repo: string,
    remote: string,
    branch: string,
    target: string,
    profile?: unknown,
    credentials?: { username: string; password: string },
    options?: { forceWithLease?: boolean; expectedRemoteHash?: string },
  ) => ipcRenderer.invoke('push:branch', repo, remote, branch, target, profile, credentials, options),
};

// terminal: data arrives as events, so expose subscribe helpers that return an unsubscribe function
(gitApi as any).term = {
  spawn: (cwd: string, cols: number, rows: number, shell?: string) =>
    ipcRenderer.invoke('term:spawn', cwd, cols, rows, shell),
  write: (id: number, data: string) => ipcRenderer.invoke('term:write', id, data),
  resize: (id: number, cols: number, rows: number) => ipcRenderer.invoke('term:resize', id, cols, rows),
  kill: (id: number) => ipcRenderer.invoke('term:kill', id),
  onData: (cb: (id: number, data: string) => void) => {
    const h = (_e: unknown, id: number, data: string) => cb(id, data);
    ipcRenderer.on('term:data', h);
    return () => ipcRenderer.removeListener('term:data', h);
  },
  onExit: (cb: (id: number, code: number) => void) => {
    const h = (_e: unknown, id: number, code: number) => cb(id, code);
    ipcRenderer.on('term:exit', h);
    return () => ipcRenderer.removeListener('term:exit', h);
  },
};

// AI: every call goes through the main process, which holds all credentials and sign-ins
const sub = <T extends unknown[]>(ch: string, cb: (...a: T) => void) => {
  const h = (_e: unknown, ...a: unknown[]) => cb(...(a as T));
  ipcRenderer.on(ch, h);
  return () => ipcRenderer.removeListener(ch, h);
};
(gitApi as any).ai = {
  status: () => ipcRenderer.invoke('ai:status'),
  copilotStatus: () => ipcRenderer.invoke('ai:copilotStatus'),
  copilotBeginLogin: () => ipcRenderer.invoke('ai:copilotBeginLogin'),
  copilotAdvanceLogin: () => ipcRenderer.invoke('ai:copilotAdvanceLogin'),
  copilotCancelLogin: () => ipcRenderer.invoke('ai:copilotCancelLogin'),
  setKey: (provider: string, key: string | null) => ipcRenderer.invoke('ai:setKey', provider, key),
  openaiSignIn: () => ipcRenderer.invoke('ai:openaiSignIn'),
  openaiCancel: () => ipcRenderer.invoke('ai:openaiCancel'),
  openaiSignOut: () => ipcRenderer.invoke('ai:openaiSignOut'),
  models: (provider: string) => ipcRenderer.invoke('ai:models', provider),
  turn: (req: unknown) => ipcRenderer.invoke('ai:turn', req),
  abort: (reqId: number) => ipcRenderer.invoke('ai:abort', reqId),
  reset: (convId: number) => ipcRenderer.invoke('ai:reset', convId),
  toolResult: (callId: string, r: unknown) => ipcRenderer.invoke('ai:toolResult', callId, r),
  resolveConflict: (provider: string, model: string | undefined, prompt: string, count: number) =>
    ipcRenderer.invoke('ai:resolveConflict', provider, model, prompt, count),
  commitMessage: (provider: string, model: string | undefined, diff: string) =>
    ipcRenderer.invoke('ai:commitMessage', provider, model, diff),
  task: (provider: string, model: string | undefined, task: string, prompt: string) =>
    ipcRenderer.invoke('ai:task', provider, model, task, prompt),
  pullRequest: (provider: string, model: string | undefined, prompt: string) =>
    ipcRenderer.invoke('ai:pullRequest', provider, model, prompt),
  onDelta: (cb: (reqId: number, text: string) => void) => sub('ai:delta', cb),
  onToolCall: (cb: (call: unknown) => void) => sub('ai:toolcall', cb),
};

// Undo / Redo from the native Edit menu
(gitApi as any).onEditKey = (cb: (key: string) => void) => {
  const h = (_e: unknown, key: string) => cb(key);
  ipcRenderer.on('app:editKey', h);
  return () => ipcRenderer.removeListener('app:editKey', h);
};

// zoom shortcuts come from the native View menu
(gitApi as any).onZoomKey = (cb: (key: string) => void) => {
  const h = (_e: unknown, key: string) => cb(key);
  ipcRenderer.on('app:zoomKey', h);
  return () => ipcRenderer.removeListener('app:zoomKey', h);
};

// pull/merge request hosting: tokens and API calls stay in the main process
(gitApi as any).hosting = {
  tokenStatus: (kind: string, host: string) => ipcRenderer.invoke('hosting:tokenStatus', kind, host),
  setToken: (kind: string, host: string, token: string | null) =>
    ipcRenderer.invoke('hosting:setToken', kind, host, token),
  request: (request: unknown) => ipcRenderer.invoke('hosting:request', request),
  open: (kind: string, host: string, url: string) => ipcRenderer.invoke('hosting:open', kind, host, url),
  connect: (kind: string, host: string, options?: unknown) =>
    ipcRenderer.invoke('hosting:connect', kind, host, options),
};

// persisted state: loaded once synchronously, then written through to the main process on every change
const initialState: Record<string, string> = ipcRenderer.sendSync('state:load') ?? {};
(gitApi as any).stateStorage = {
  getItem: (k: string) => initialState[k] ?? null,
  setItem: (k: string, v: string) => {
    initialState[k] = v;
    ipcRenderer.send('state:save', k, v);
  },
  removeItem: (k: string) => {
    delete initialState[k];
    ipcRenderer.send('state:save', k, null);
  },
};

contextBridge.exposeInMainWorld('gitApi', gitApi);
