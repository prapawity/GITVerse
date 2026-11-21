import { app, safeStorage } from 'electron';
import { loadState, saveKey } from '../state';

/** Secrets are encrypted with the OS keychain (safeStorage) before they touch disk, and never leave the main process. */
const dir = () => app.getPath('userData');
/**
 * On Linux without a keyring, Electron falls back to a fixed built-in password ("basic_text"), which
 * only obscures the data; treat that as no secure storage so secrets stay in memory instead.
 */
export const canEncrypt = () =>
  safeStorage.isEncryptionAvailable() &&
  !(process.platform === 'linux' && safeStorage.getSelectedStorageBackend?.() === 'basic_text');

/**
 * When the OS keychain refuses access (e.g. a rebuilt, ad-hoc signed app is not on the keychain item's
 * access list), secrets are kept in memory for this session instead of failing outright.
 */
const sessionSecrets = new Map<string, string>();
export const isSessionOnly = (key: string) => sessionSecrets.has(key);

export function readSecret(key: string): string | null {
  if (sessionSecrets.has(key)) return sessionSecrets.get(key)!;
  const v = loadState(dir())[key];
  if (!v) return null;
  try {
    return safeStorage.decryptString(Buffer.from(v, 'base64'));
  } catch {
    return null;
  }
}
/** Returns 'session' when the secret could only be kept in memory until the app quits. */
export function writeSecret(key: string, value: string | null): 'saved' | 'session' {
  sessionSecrets.delete(key);
  if (value == null) {
    saveKey(dir(), key, null);
    return 'saved';
  }
  if (!canEncrypt()) {
    sessionSecrets.set(key, value);
    return 'session';
  }
  saveKey(dir(), key, safeStorage.encryptString(value).toString('base64'));
  return 'saved';
}
export const readPlain = (key: string) => loadState(dir())[key] ?? null;
export const writePlain = (key: string, value: string | null) => saveKey(dir(), key, value);

export { err, errText, type Hooks } from './parse';
