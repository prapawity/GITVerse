import { useEffect, useMemo, useState } from 'react';
import { platformApi } from '../platform/api';

/** A .gitattributes pattern as a RegExp: no slash = any folder; `*` stays in one folder; `**` crosses them. */
export function attributePattern(pattern: string): RegExp {
  const anchored = pattern.includes('/');
  const body = pattern
    .replace(/^\//, '')
    .split('')
    .map((c, i, all) => {
      if (c === '*') {
        if (all[i + 1] === '*') return '';
        return all[i - 1] === '*' ? '.*' : '[^/]*';
      }
      if (c === '?') return '[^/]';
      return /[.+^${}()|[\]\\]/.test(c) ? `\\${c}` : c;
    })
    .join('');
  return new RegExp(anchored ? `^${body}$` : `(^|/)${body}$`);
}

const cache = new Map<string, Promise<{ patterns: string[]; files: string[] }>>();

/** Whether a path is stored with Git LFS in this repository (tracked pattern or LFS file at HEAD). */
export function useLfs(repoPath: string | null) {
  const [data, setData] = useState<{ patterns: string[]; files: string[] } | null>(null);
  useEffect(() => {
    const api = platformApi();
    if (!repoPath || !api?.lfsStatus) return setData(null);
    let active = true;
    if (!cache.has(repoPath))
      cache.set(
        repoPath,
        api.lfsStatus(repoPath).then(
          (s: { used: boolean; patterns: string[]; files: string[] }) =>
            s.used ? { patterns: s.patterns, files: s.files } : { patterns: [], files: [] },
          () => ({ patterns: [], files: [] }),
        ),
      );
    void cache.get(repoPath)!.then((value) => active && setData(value));
    return () => {
      active = false;
    };
  }, [repoPath]);
  return useMemo(() => {
    if (!data || (!data.patterns.length && !data.files.length)) return () => false;
    const files = new Set(data.files);
    const patterns = data.patterns.map(attributePattern);
    return (path: string) => files.has(path) || patterns.some((re) => re.test(path));
  }, [data]);
}

/** Forget cached LFS status (after tracking / untracking a pattern). */
export const resetLfsCache = (repoPath: string) => cache.delete(repoPath);
