import { contextBridge, ipcRenderer, webUtils } from 'electron';

const names = ['log', 'status', 'commit', 'checkout', 'checkoutRemote', 'stage', 'unstage', 'refs', 'historyPosition', 'commitDetail', 'commitFileDiff', 'workingFileDiff', 'fetch', 'pull', 'push', 'pushInfo', 'commitIdentity', 'setCommitIdentity', 'createBranch', 'stash', 'stashPop', 'reset', 'cherryPick', 'revert', 'rebaseOnto', 'createTag', 'branchAt', 'fileAt', 'worktreeAdd', 'remoteUrl', 'formatPatch', 'createAnnotatedTag', 'fileBlame', 'fileHistory', 'opState', 'opContinue', 'opAbort', 'opSkip', 'resolveFile', 'merge', 'deleteBranch', 'readWorkFile', 'writeWorkFile'];
const gitApi: Record<string, (...a: unknown[]) => Promise<any>> = {
  openRepoDialog: () => ipcRenderer.invoke('repo:open'),
  cloneRepo: (url: unknown, destination: unknown) => ipcRenderer.invoke('repo:clone', url, destination),
  openFile: (...a) => ipcRenderer.invoke('repo:openFile', ...a),
};
(gitApi as any).onCloneProgress = (cb: (message: string) => void) => {
  const handler = (_event: unknown, message: string) => cb(message);
  ipcRenderer.on('repo:cloneProgress', handler);
  return () => ipcRenderer.removeListener('repo:cloneProgress', handler);
};
(gitApi as any).pathForFile = (file: File) => webUtils.getPathForFile(file);
(gitApi as any).findRepositories = (folder: string) => ipcRenderer.invoke('repo:findRepositories', folder);
for (const n of names) gitApi[n] = (...a) => ipcRenderer.invoke(`git:${n}`, ...a);
gitApi.squashCommits = (...a) => ipcRenderer.invoke('git:squashCommits', ...a);
gitApi.stagedForCommitMessage = (...a) => ipcRenderer.invoke('git:stagedForCommitMessage', ...a);
gitApi.cherryPickMany = (...a) => ipcRenderer.invoke('git:cherryPickMany', ...a);
gitApi.tagCommit = (...a) => ipcRenderer.invoke('git:tagCommit', ...a);
gitApi.stashDiff = (...a) => ipcRenderer.invoke('git:stashDiff', ...a);
gitApi.trackedStage = (...a) => ipcRenderer.invoke('git:trackedStage', ...a);
gitApi.indexUndoState = (...a) => ipcRenderer.invoke('git:indexUndoState', ...a);
gitApi.moveIndexHistory = (...a) => ipcRenderer.invoke('git:moveIndexHistory', ...a);
(gitApi as any).setActiveIdentity = (identity: { name: string; email: string } | null) => ipcRenderer.invoke('profile:setIdentity', identity);
(gitApi as any).pushProfiles = {
  tokenStatus: (repo: string, id: string) => ipcRenderer.invoke('push:tokenStatus', repo, id),
  setToken: (repo: string, id: string, token: string | null) => ipcRenderer.invoke('push:setToken', repo, id, token),
  chooseKey: () => ipcRenderer.invoke('push:chooseKey'),
  push: (repo: string, remote: string, branch: string, target: string, profile?: unknown, credentials?: { username: string; password: string }) => ipcRenderer.invoke('push:branch', repo, remote, branch, target, profile, credentials),
};

// terminal: data arrives as events, so expose subscribe helpers that return an unsubscribe function
(gitApi as any).term = {
  spawn: (cwd: string, cols: number, rows: number, shell?: string) => ipcRenderer.invoke('term:spawn', cwd, cols, rows, shell),
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
  resolveConflict: (provider: string, model: string | undefined, prompt: string, count: number) => ipcRenderer.invoke('ai:resolveConflict', provider, model, prompt, count),
  commitMessage: (provider: string, model: string | undefined, diff: string) => ipcRenderer.invoke('ai:commitMessage', provider, model, diff),
  onDelta: (cb: (reqId: number, text: string) => void) => sub('ai:delta', cb),
  onToolCall: (cb: (call: unknown) => void) => sub('ai:toolcall', cb),
};

// persisted state: loaded once synchronously, then written through to the main process on every change
const initialState: Record<string, string> = ipcRenderer.sendSync('state:load') ?? {};
(gitApi as any).stateStorage = {
  getItem: (k: string) => initialState[k] ?? null,
  setItem: (k: string, v: string) => { initialState[k] = v; ipcRenderer.send('state:save', k, v); },
  removeItem: (k: string) => { delete initialState[k]; ipcRenderer.send('state:save', k, null); },
};

contextBridge.exposeInMainWorld('gitApi', gitApi);
