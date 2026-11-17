/**
 * Platform adapter: the only place the renderer touches the desktop bridge.
 *
 * Today the bridge is Electron's preload (`window.gitApi`). A Tauri build will provide the same
 * `PlatformApi` shape from `invoke()` instead, so components and stores never need to know which
 * runtime they are on. See docs/rust-migration/.
 */
import type { GitMethodName } from '../shared/gitMethods';
import type { ScanProgress } from '../shared/repositoryScan';

type Unsubscribe = () => void;
// Git payloads are typed at the call site for now; tighten per method as the contract is generated.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyAsync = (...args: any[]) => Promise<any>;

export interface StateStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface UpdateStatus {
  state: string;
  percent?: number;
  version?: string;
  message?: string;
}

export interface PlatformApi extends Record<GitMethodName, AnyAsync> {
  openRepoDialog: AnyAsync;
  openThirdPartyNotices: AnyAsync;
  openRuntimeNotice: AnyAsync;
  cloneRepo: AnyAsync;
  openFile: AnyAsync;
  onCloneProgress(cb: (message: string) => void): Unsubscribe;
  pathForFile(file: File): string;
  findRepositories: AnyAsync;
  cancelScan(id: string): void;
  onScanProgress(cb: (id: string, progress: ScanProgress) => void): Unsubscribe;
  /** Native file drag-and-drop (Tauri): the web view's own drop events carry no file paths there. */
  onFileDrop?(cb: (event: { type: 'enter' | 'leave' | 'drop'; paths: string[] }) => void): Unsubscribe;
  setActiveIdentity(identity: { name: string; email: string } | null): Promise<unknown>;
  updates: Record<
    'environment' | 'startup' | 'check' | 'list' | 'openReleaseList' | 'openDownloads' | 'download' | 'install',
    AnyAsync
  > & {
    onStatus(cb: (status: UpdateStatus) => void): Unsubscribe;
  };
  pushProfiles: Record<'tokenStatus' | 'setToken' | 'chooseKey' | 'push', AnyAsync>;
  term: {
    spawn(cwd: string, cols: number, rows: number, shell?: string): Promise<number>;
    write(id: number, data: string): Promise<void>;
    resize(id: number, cols: number, rows: number): Promise<void>;
    kill(id: number): Promise<void>;
    onData(cb: (id: number, data: string) => void): Unsubscribe;
    onExit(cb: (id: number, code: number) => void): Unsubscribe;
  };
  ai: Record<
    | 'status'
    | 'copilotStatus'
    | 'copilotBeginLogin'
    | 'copilotAdvanceLogin'
    | 'copilotCancelLogin'
    | 'setKey'
    | 'openaiSignIn'
    | 'openaiCancel'
    | 'openaiSignOut'
    | 'models'
    | 'turn'
    | 'abort'
    | 'reset'
    | 'toolResult'
    | 'resolveConflict'
    | 'commitMessage',
    AnyAsync
  > & {
    onDelta(cb: (reqId: number, text: string) => void): Unsubscribe;
    onToolCall<T = unknown>(cb: (call: T) => void): Unsubscribe;
  };
  stateStorage: StateStorage;
}

/** The desktop bridge, or undefined in the browser preview / before the bridge loads. */
export function platformApi(): PlatformApi | undefined {
  if (typeof window === 'undefined') return undefined;
  return (window as Window & { gitApi?: PlatformApi }).gitApi;
}

/** The desktop bridge; throws when it is missing. Use where a call cannot work without it. */
export function desktopApi(): PlatformApi {
  const bridge = platformApi();
  if (!bridge) throw new Error('The GITVerse desktop bridge is not available.');
  return bridge;
}

/**
 * Install the desktop bridge before the app renders. Electron's preload has already set
 * `window.gitApi`; under Tauri it is built here (async, because state is loaded over IPC).
 */
export async function initPlatform(): Promise<void> {
  if (platformApi()) return;
  const { isTauri, createTauriApi } = await import('./tauri');
  if (isTauri()) (window as Window & { gitApi?: PlatformApi }).gitApi = await createTauriApi();
}
