// Records crashes and hangs per app version so the launch screen can offer
// "Download another version" only when the installed version is unstable.
//
// - crash: the previous session never reached a clean shutdown (renderer crash,
//   force-quit of a frozen window, OS kill, ...). Detected on the next launch.
// - hang: the UI thread was blocked for longer than HANG_THRESHOLD_MS while the
//   app kept running. Detected by a heartbeat timer that notices the gap.
//
// Everything is written synchronously to localStorage so it survives a crash.

export type CrashKind = 'crash' | 'hang';
export interface CrashEntry {
  kind: CrashKind;
  version: string;
  at: string; // ISO time of detection
  detail?: string;
}

const LOG_KEY = 'gitverse.crashLog';
const SESSION_KEY = 'gitverse.session';
const MAX_ENTRIES = 200;
const HEARTBEAT_MS = 2000;
const HANG_THRESHOLD_MS = 10000;
/** Offer another version once the current version has at least this many incidents. */
export const UNSTABLE_THRESHOLD = 5;

interface Session {
  version: string;
  startedAt: string;
  lastBeat: string;
  clean: boolean;
}

function read<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

function write(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // storage unavailable or full: logging is best effort
  }
}

export function crashLog(): CrashEntry[] {
  const value = read<CrashEntry[]>(LOG_KEY, []);
  return Array.isArray(value) ? value : [];
}

export function recordIncident(entry: Omit<CrashEntry, 'at'> & { at?: string }) {
  const log = crashLog();
  log.push({ ...entry, at: entry.at ?? new Date().toISOString() });
  write(LOG_KEY, log.slice(-MAX_ENTRIES));
}

export function incidentCount(version: string): number {
  return crashLog().filter((entry) => entry.version === version).length;
}

export function isVersionUnstable(version: string): boolean {
  return incidentCount(version) >= UNSTABLE_THRESHOLD;
}

let started = false;

/**
 * Call once at startup. Logs a crash if the previous session ended uncleanly,
 * then starts tracking the current session. Returns a stop function (tests).
 */
export function startCrashMonitor(version: string): () => void {
  if (started) return () => {};
  started = true;

  const previous = read<Session | null>(SESSION_KEY, null);
  if (previous && !previous.clean) {
    recordIncident({
      kind: 'crash',
      version: previous.version,
      detail: `Session started ${previous.startedAt}, last heartbeat ${previous.lastBeat}`,
    });
  }

  const now = new Date().toISOString();
  const session: Session = { version, startedAt: now, lastBeat: now, clean: false };
  write(SESSION_KEY, session);

  let last = Date.now();
  const timer = setInterval(() => {
    const current = Date.now();
    const gap = current - last;
    last = current;
    // a large gap means the thread was blocked (ignore laptop sleep: page hidden)
    if (gap > HANG_THRESHOLD_MS && document.visibilityState === 'visible') {
      recordIncident({ kind: 'hang', version, detail: `UI blocked for ${Math.round(gap / 1000)}s` });
    }
    session.lastBeat = new Date(current).toISOString();
    session.clean = false;
    write(SESSION_KEY, session);
  }, HEARTBEAT_MS);

  const markClean = () => {
    session.clean = true;
    write(SESSION_KEY, session);
  };
  // a reload or normal quit unloads the page; the next heartbeat re-arms if we stay alive
  window.addEventListener('pagehide', markClean);
  window.addEventListener('beforeunload', markClean);
  // after sleep/background the timer gap is not a hang
  const onVisible = () => {
    last = Date.now();
  };
  document.addEventListener('visibilitychange', onVisible);

  return () => {
    clearInterval(timer);
    window.removeEventListener('pagehide', markClean);
    window.removeEventListener('beforeunload', markClean);
    document.removeEventListener('visibilitychange', onVisible);
    markClean();
    started = false;
  };
}
