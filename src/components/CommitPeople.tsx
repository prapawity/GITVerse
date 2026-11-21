import { useEffect, useState } from 'react';
import { desktopApi } from '../platform/api';
import { useRepo } from '../store/repoStore';
import { useAvatars } from '../lib/avatars';

type Person = { name: string; email: string; date: string };

const CO_AUTHOR = /^Co-authored-by:\s*(.+?)\s*<([^>]+)>\s*$/gim;
/** People named in `Co-authored-by:` trailers of a commit message. */
export function coAuthors(body: string): { name: string; email: string }[] {
  const seen = new Set<string>();
  return [...body.matchAll(CO_AUTHOR)]
    .map((m) => ({ name: m[1], email: m[2] }))
    .filter((p) => !seen.has(p.email.toLowerCase()) && seen.add(p.email.toLowerCase()));
}

function Avatar({
  name,
  email,
  photo,
  small,
}: {
  name: string;
  email: string;
  photo: HTMLImageElement | null;
  small?: boolean;
}) {
  const size = small ? 'h-7 w-7 text-2xs' : 'h-11 w-11 text-base';
  if (photo) return <img src={photo.src} alt="" className={`${size} shrink-0 rounded-md object-cover`} />;
  const initials = name
    .split(/\s+/)
    .slice(0, 2)
    .map((w) => w[0])
    .join('')
    .toUpperCase();
  return (
    <div
      aria-hidden
      title={email}
      className={`${size} flex shrink-0 items-center justify-center rounded-md bg-ai font-bold text-crust`}
    >
      {initials || '?'}
    </div>
  );
}

const when = (iso: string) => (iso ? new Date(iso).toLocaleString() : '');

/**
 * Author, committer (when someone else applied the commit, e.g. a merge on GitHub or a rebase)
 * and co-authors from the message trailers.
 */
export function CommitPeople({
  hash,
  fallback,
  body,
}: {
  hash: string;
  fallback: { author: string; email?: string; date?: string };
  body: string;
}) {
  const repoPath = useRepo((s) => s.repoPath);
  const [people, setPeople] = useState<{ author: Person; committer: Person } | null>(null);
  useEffect(() => {
    if (!repoPath || !hash) return;
    let active = true;
    setPeople(null);
    desktopApi()
      .commitPeople(repoPath, hash)
      .then((p: { author: Person; committer: Person }) => active && setPeople(p))
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [repoPath, hash]);

  const author: Person = people?.author ?? {
    name: fallback.author,
    email: fallback.email ?? '',
    date: fallback.date ?? '',
  };
  const committer = people?.committer;
  // one person when author and committer are the same; their commit date then goes on the same row
  const samePerson = (a: { name: string; email: string }, b: { name: string; email: string }) =>
    (!!a.email && a.email.toLowerCase() === b.email.toLowerCase()) || a.name === b.name;
  const showCommitter = !!committer && !samePerson(committer, author);
  const recommitted =
    !!committer &&
    !showCommitter &&
    Math.abs(new Date(committer.date).getTime() - new Date(author.date).getTime()) > 60_000;
  // co-authors already shown as author or committer are not listed twice
  const co = coAuthors(body).filter(
    (p) => !samePerson(p, author) && !(committer && showCommitter && samePerson(p, committer)),
  );
  const emails = [author.email, committer?.email ?? '', ...co.map((p) => p.email)].filter(Boolean);
  const avatars = useAvatars(repoPath, [...new Set(emails)].sort());
  void avatars.version;

  return (
    <div className="space-y-3 px-4 pb-3">
      <div className="flex items-center gap-3">
        <Avatar name={author.name} email={author.email} photo={avatars.get(author.email)} />
        <div className="min-w-0">
          <div className="truncate text-base font-medium">{author.name}</div>
          {author.email && <div className="break-all text-sm text-sub">{author.email}</div>}
          <div className="text-sm text-sub">
            {author.date ? `authored ${when(author.date)}` : 'Loading metadata...'}
          </div>
          {recommitted && committer && <div className="text-sm text-sub">committed {when(committer.date)}</div>}
        </div>
      </div>
      {showCommitter && committer && (
        <div className="slide-down flex items-center gap-3">
          <Avatar name={committer.name} email={committer.email} photo={avatars.get(committer.email)} />
          <div className="min-w-0">
            <div className="truncate text-base font-medium">{committer.name}</div>
            {committer.email && <div className="break-all text-sm text-sub">{committer.email}</div>}
            <div className="text-sm text-sub">committed {when(committer.date)}</div>
          </div>
        </div>
      )}
      {co.length > 0 && (
        <div>
          <div className="mb-1.5 text-xs font-semibold uppercase text-sub">Co-authors</div>
          <div className="flex flex-wrap gap-2">
            {co.map((p) => (
              <span
                key={p.email}
                className="flex items-center gap-2 rounded-full bg-surface/60 py-0.5 pl-0.5 pr-3 text-sm"
                title={p.email}
              >
                <Avatar name={p.name} email={p.email} photo={avatars.get(p.email)} small />
                {p.name}
              </span>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
