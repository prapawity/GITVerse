/**
 * Persistent key/value storage: the app-data file via Electron when available (survives port changes
 * and abrupt quits), otherwise localStorage (browser preview). Every call is safe to make when storage is blocked.
 */
const native = () =>
  (window as any).gitApi?.stateStorage as
    { getItem(k: string): string | null; setItem(k: string, v: string): void; removeItem(k: string): void } | undefined;

export const storage = {
  getItem(k: string): string | null {
    const n = native();
    if (n) {
      const v = n.getItem(k);
      if (v != null) return v;
    }
    try {
      return localStorage.getItem(k);
    } catch {
      return null;
    } // also migrates values saved by older versions
  },
  setItem(k: string, v: string) {
    native()?.setItem(k, v);
    if (!native()) {
      try {
        localStorage.setItem(k, v);
      } catch {
        /* ignore */
      }
    }
  },
  removeItem(k: string) {
    native()?.removeItem(k);
    try {
      localStorage.removeItem(k);
    } catch {
      /* ignore */
    }
  },
};
