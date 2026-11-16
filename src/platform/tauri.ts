/**
 * Tauri implementation of PlatformApi (Rust backend in src-tauri/).
 *
 * Git methods all go through one `git_call` command, mirroring Electron's `git:<name>` channels, so
 * operations can move to Rust one at a time. Anything not ported yet rejects with a clear message
 * instead of crashing; see docs/rust-migration/migration-plan.md for what is still Electron-only.
 */
import { invoke } from '@tauri-apps/api/core';
import { getVersion } from '@tauri-apps/api/app';
import { listen } from '@tauri-apps/api/event';
import { GIT_METHODS } from '../shared/gitMethods';
import type { AnyAsync, PlatformApi } from './api';

type RustError = { kind?: string; message?: string };

/** Rust errors arrive as `{ kind, message }`; the stores expect `Error(message)` like Electron gives. */
function toError(raw: unknown): Error {
  if (raw instanceof Error) return raw;
  const e = (raw ?? {}) as RustError;
  const error = new Error(typeof raw === 'string' ? raw : (e.message ?? 'Unknown error'));
  if (e.kind) (error as Error & { kind?: string }).kind = e.kind;
  return error;
}

const call = <T>(cmd: string, args?: Record<string, unknown>) =>
  invoke<T>(cmd, args).catch((raw: unknown) => {
    throw toError(raw);
  });

const notPorted =
  (name: string): AnyAsync =>
  () =>
    Promise.reject(new Error(`'${name}' is not available in the Tauri build yet (Rust migration in progress).`));

const noopSubscription = () => () => {};

/** Subscribe to a backend event; returns an unsubscribe function like the Electron bridge. */
function subscribe<T>(event: string, cb: (payload: T) => void) {
  let stop: (() => void) | undefined;
  let stopped = false;
  void listen<T>(event, (e) => cb(e.payload)).then((unlisten) => {
    if (stopped) unlisten();
    else stop = unlisten;
  });
  return () => {
    stopped = true;
    stop?.();
  };
}

function group<K extends string>(prefix: string, names: readonly K[]): Record<K, AnyAsync> {
  return Object.fromEntries(names.map((n) => [n, notPorted(`${prefix}.${n}`)])) as Record<K, AnyAsync>;
}

export const isTauri = () => typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

/** Build the bridge. Async because Tauri has no synchronous IPC: state is loaded once up front. */
export async function createTauriApi(): Promise<PlatformApi> {
  const state: Record<string, string> = await call<Record<string, string>>('state_load').catch(() => ({}));
  const version = await getVersion().catch(() => '0.0.0');
  const save = (key: string, value: string | null) => {
    void call('state_save', { key, value }).catch((e) => console.error('[state] save failed', e));
  };

  const git = Object.fromEntries(
    GIT_METHODS.map((method) => [method, (...args: unknown[]) => call('git_call', { method, args })]),
  ) as Record<(typeof GIT_METHODS)[number], AnyAsync>;

  const development = () => Promise.resolve({ kind: 'development', currentVersion: version });

  return {
    ...git,
    openRepoDialog: () => call<string | null>('repo_open'),
    openThirdPartyNotices: notPorted('openThirdPartyNotices'),
    openRuntimeNotice: notPorted('openRuntimeNotice'),
    cloneRepo: (url: string, destination: string) => call('repo_clone', { url, destination }),
    openFile: notPorted('openFile'),
    onCloneProgress: (cb) => subscribe<string>('repo:cloneProgress', cb),
    // Tauri exposes dropped files' paths through its own drag-drop event, not on File objects.
    pathForFile: () => '',
    findRepositories: notPorted('findRepositories'),
    cancelScan: () => {},
    onScanProgress: noopSubscription,
    setActiveIdentity: (identity) => call('set_identity', { identity }),
    updates: {
      ...group('updates', ['list', 'openReleaseList', 'openDownloads', 'download', 'install'] as const),
      // until the Tauri updater lands, behave like a development build: no update prompts
      environment: () => Promise.resolve({ manualInstall: true }),
      startup: development,
      check: development,
      onStatus: noopSubscription,
    },
    pushProfiles: {
      // saved HTTPS tokens move to the OS keychain in the secrets phase
      tokenStatus: () => Promise.resolve(false),
      setToken: notPorted('pushProfiles.setToken'),
      chooseKey: () => call<string | null>('push_choose_key'),
      push: (repo, remote, branch, target, profile, credentials, options) =>
        call('push_branch', { repo, remote, branch, target, profile, credentials, options }),
    },
    term: {
      spawn: notPorted('term.spawn') as PlatformApi['term']['spawn'],
      write: notPorted('term.write') as PlatformApi['term']['write'],
      resize: notPorted('term.resize') as PlatformApi['term']['resize'],
      kill: notPorted('term.kill') as PlatformApi['term']['kill'],
      onData: noopSubscription,
      onExit: noopSubscription,
    },
    ai: {
      ...group('ai', [
        'status',
        'copilotStatus',
        'copilotBeginLogin',
        'copilotAdvanceLogin',
        'copilotCancelLogin',
        'setKey',
        'openaiSignIn',
        'openaiCancel',
        'openaiSignOut',
        'models',
        'turn',
        'abort',
        'reset',
        'toolResult',
        'resolveConflict',
        'commitMessage',
      ] as const),
      onDelta: noopSubscription,
      onToolCall: noopSubscription,
    },
    stateStorage: {
      getItem: (k) => state[k] ?? null,
      setItem: (k, v) => {
        state[k] = v;
        save(k, v);
      },
      removeItem: (k) => {
        delete state[k];
        save(k, null);
      },
    },
  };
}
