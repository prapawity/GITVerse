import { app, safeStorage } from 'electron';
import { loadState, saveKey } from '../state';

/** Secrets are encrypted with the OS keychain (safeStorage) before they touch disk, and never leave the main process. */
const dir = () => app.getPath('userData');
export const canEncrypt = () => safeStorage.isEncryptionAvailable();

export function readSecret(key: string): string | null {
  const v = loadState(dir())[key];
  if (!v) return null;
  try {
    return safeStorage.decryptString(Buffer.from(v, 'base64'));
  } catch {
    return null;
  }
}
export function writeSecret(key: string, value: string | null) {
  if (value == null) {
    saveKey(dir(), key, null);
    return;
  }
  if (!canEncrypt())
    throw new Error(
      'This system has no secure storage, so the secret cannot be saved safely. Use an environment variable instead.',
    );
  saveKey(dir(), key, safeStorage.encryptString(value).toString('base64'));
}
export const readPlain = (key: string) => loadState(dir())[key] ?? null;
export const writePlain = (key: string, value: string | null) => saveKey(dir(), key, value);

export { err, errText, type Hooks } from './parse';
