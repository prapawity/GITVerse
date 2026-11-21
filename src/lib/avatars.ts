/**
 * Author photos for the commit graph. Privacy: emails are only sent to the repository's own host
 * (GitLab's avatar API, with the saved token), and GitHub photos only come from GitHub's no-reply
 * address IDs. Image URLs on any other host (e.g. Gravatar fallbacks) are ignored, so the graph
 * keeps its initials instead.
 */
import { useEffect, useState } from 'react';
import { desktopApi } from '../platform/api';
import { detectHostedRepo, HOST_KINDS, remoteHost, type HostedRepo, type HostKind } from '../shared/pullRequests';
import { savedKindKey } from './pullRequests';
import { useSettings } from '../store/settingsStore';

const images = new Map<string, HTMLImageElement | null>(); // email → loaded image, or null = none
const pending = new Set<string>();

async function hostedFor(cwd: string): Promise<HostedRepo | null> {
  const url: string = await desktopApi().remoteUrl(cwd);
  const host = remoteHost(url);
  const saved = host ? desktopApi().stateStorage.getItem(savedKindKey(host)) : null;
  return detectHostedRepo(url, saved && (HOST_KINDS as string[]).includes(saved) ? (saved as HostKind) : null);
}

function allowed(url: string, repo: HostedRepo) {
  try {
    const parsed = new URL(url, `https://${repo.host}`);
    if (parsed.protocol !== 'https:') return null;
    const host = parsed.host.toLowerCase();
    const ok =
      host === repo.host.toLowerCase() ||
      (repo.kind === 'github' && host.endsWith('githubusercontent.com')) ||
      (repo.kind === 'bitbucket' && host.endsWith('bitbucket.org'));
    return ok ? parsed.href : null;
  } catch {
    return null;
  }
}

async function avatarUrl(repo: HostedRepo, email: string): Promise<string | null> {
  const lower = email.toLowerCase();
  const noreply = /^(?:(\d+)\+)?[^@]+@users\.noreply\.github\.com$/.exec(lower);
  if (noreply?.[1]) return `https://avatars.githubusercontent.com/u/${noreply[1]}?s=48`;
  if (repo.kind === 'gitlab') {
    const res = await desktopApi()
      .hosting.request({
        kind: 'gitlab',
        host: repo.host,
        method: 'GET',
        path: `/avatar?email=${encodeURIComponent(email)}&size=48`,
      })
      .catch(() => null);
    const url = (res?.data as { avatar_url?: string } | null)?.avatar_url;
    return res?.status === 200 && url ? allowed(url, repo) : null;
  }
  return null;
}

function load(url: string): Promise<HTMLImageElement | null> {
  return new Promise((resolve) => {
    const img = new Image();
    img.decoding = 'async';
    img.referrerPolicy = 'no-referrer';
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = url;
  });
}

/** Returns a lookup that fills in as photos load; `version` changes whenever a new one is ready. */
export function useAvatars(repoPath: string | null, emails: string[]) {
  const enabled = useSettings((s) => s.showAvatars);
  const [version, setVersion] = useState(0);
  const key = emails.join('\n');
  useEffect(() => {
    if (!enabled || !repoPath || !emails.length) return;
    let active = true;
    void (async () => {
      const repo = await hostedFor(repoPath).catch(() => null);
      if (!repo) return;
      const todo = [...new Set(emails.map((e) => e.toLowerCase()))].filter((e) => !images.has(e) && !pending.has(e));
      // a few at a time; the graph redraws as each one arrives
      for (let i = 0; i < todo.length && active; i += 6) {
        await Promise.all(
          todo.slice(i, i + 6).map(async (email) => {
            pending.add(email);
            const url = await avatarUrl(repo, email).catch(() => null);
            images.set(email, url ? await load(url) : null);
            pending.delete(email);
            if (active && images.get(email)) setVersion((v) => v + 1);
          }),
        );
      }
    })();
    return () => {
      active = false;
    };
  }, [enabled, repoPath, key]); // eslint-disable-line react-hooks/exhaustive-deps
  return { version, get: (email: string) => (enabled ? (images.get(email.toLowerCase()) ?? null) : null) };
}
