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
      tokenStatus: (repo: string, id: string) => call<boolean>('push_token_status', { repo, id }),
      setToken: (repo: string, id: string, token: string | null) => call('push_set_token', { repo, id, token }),
      chooseKey: () => call<string | null>('push_choose_key'),
      push: (repo, remote, branch, target, profile, credentials, options) =>
        call('push_branch', { repo, remote, branch, target, profile, credentials, options }),
    },
    term: {
      spawn: (cwd, cols, rows, shell) => call<number>('term_spawn', { cwd, cols, rows, shell: shell ?? null }),
      write: (id, data) => call<void>('term_write', { id, data }),
      resize: (id, cols, rows) => call<void>('term_resize', { id, cols, rows }),
      kill: (id) => call<void>('term_kill', { id }),
      onData: (cb) => subscribe<{ id: number; data: string }>('term:data', (p) => cb(p.id, p.data)),
      onExit: (cb) => subscribe<{ id: number; code: number }>('term:exit', (p) => cb(p.id, p.code)),
    },
    ai: {
      status: () => call('ai_status'),
      copilotStatus: () => call('ai_copilot_status'),
      copilotBeginLogin: () => call('ai_copilot_begin_login'),
      copilotAdvanceLogin: () => call('ai_copilot_advance_login'),
      copilotCancelLogin: () => call('ai_copilot_cancel_login'),
      setKey: (provider: string, key: string | null) => call('ai_set_key', { provider, key }),
      openaiSignIn: () => call('ai_openai_sign_in'),
      openaiCancel: () => call('ai_openai_cancel'),
      openaiSignOut: () => call('ai_openai_sign_out'),
      models: (provider: string) => call('ai_models', { provider }),
      turn: (req: unknown) => call('ai_turn', { req }),
      abort: (reqId: number) => call('ai_abort', { reqId }),
      reset: (convId: number) => call('ai_reset', { convId }),
      toolResult: (callId: string, r: unknown) => call('ai_tool_result', { callId, r }),
      resolveConflict: (provider: string, model: string | undefined, prompt: string, count: number) =>
        call('ai_resolve_conflict', { provider, model: model ?? null, prompt, count }),
      commitMessage: (provider: string, model: string | undefined, diff: string) =>
        call('ai_commit_message', { provider, model: model ?? null, diff }),
      onDelta: (cb) => subscribe<{ reqId: number; text: string }>('ai:delta', (p) => cb(p.reqId, p.text)),
      // Copilot runs its own tool loop and hands each call back to the app
      onToolCall: (cb) => subscribe('ai:toolcall', cb),
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
