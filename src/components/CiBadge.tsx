import { useEffect, useState } from 'react';
import { CheckCircle2, CircleDot, XCircle } from 'lucide-react';
import type { HostedRepo } from '../shared/pullRequests';
import { ciStatus, type CiStatus } from '../lib/pullRequests';

/** Results are shared by every badge for the same commit and reused for a minute. */
const cache = new Map<string, { at: number; result: Promise<CiStatus | null> }>();
const FRESH_MS = 60_000;
/** While checks are still running, look again this often. */
const POLL_MS = 30_000;

function load(repo: HostedRepo, sha: string, force = false): Promise<CiStatus | null> {
  const key = `${repo.kind}:${repo.host}/${repo.path}@${sha}`;
  const hit = cache.get(key);
  if (hit && !force && Date.now() - hit.at < FRESH_MS) return hit.result;
  // no token, no CI or no access: show nothing rather than an error on every row
  const result = ciStatus(repo, sha).catch(() => null);
  cache.set(key, { at: Date.now(), result });
  return result;
}

const LOOK = {
  success: { Icon: CheckCircle2, cls: 'text-success', label: 'Checks passed' },
  failure: { Icon: XCircle, cls: 'text-danger', label: 'Checks failed' },
  pending: { Icon: CircleDot, cls: 'text-warning', label: 'Checks running' },
} as const;

function describe(s: CiStatus) {
  const parts = [
    s.failed && `${s.failed} failed`,
    s.pending && `${s.pending} running`,
    s.passed && `${s.passed} passed`,
  ].filter(Boolean);
  return `${LOOK[s.state as keyof typeof LOOK].label}${parts.length ? ` (${parts.join(', ')})` : ''}`;
}

/**
 * CI result of a pull request's head commit: a green check, red cross or amber dot. Nothing is
 * shown when the commit has no checks or the host does not report them.
 */
export function CiBadge({
  repo,
  sha,
  fallbackUrl,
  onOpen,
}: {
  repo: HostedRepo | null;
  sha: string;
  /** opened when the host gave no checks page (Bitbucket) */
  fallbackUrl?: string;
  /** when set the badge is a button that opens the checks page */
  onOpen?: (url: string) => void;
}) {
  const [status, setStatus] = useState<CiStatus | null>(null);
  useEffect(() => {
    setStatus(null);
    if (!repo || !sha) return;
    let on = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const run = (force: boolean) =>
      load(repo, sha, force).then((s) => {
        if (!on) return;
        setStatus(s);
        if (s?.state === 'pending') timer = setTimeout(() => run(true), POLL_MS);
      });
    void run(false);
    return () => {
      on = false;
      clearTimeout(timer);
    };
  }, [repo, sha]);

  if (!status || status.state === 'none') return null;
  const { Icon, cls } = LOOK[status.state];
  const text = describe(status);
  const url = status.url ?? fallbackUrl;
  if (onOpen && url)
    return (
      <button
        type="button"
        onClick={() => onOpen(url)}
        title={`${text}. Open checks`}
        aria-label={`${text}. Open checks`}
        className={`shrink-0 rounded p-1 hover:bg-surface ${cls}`}
      >
        <Icon size={15} aria-hidden />
      </button>
    );
  return (
    <span title={text} className={`shrink-0 ${cls}`}>
      <Icon size={14} aria-hidden />
      <span className="sr-only">{text}</span>
    </span>
  );
}
