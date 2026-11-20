import { useSettings } from '../store/settingsStore';

/** Ref key used for hide/solo settings. */
export const refKey = (kind: 'local' | 'remote' | 'tag', name: string) => `${kind}:${name}`;

const FULL = { local: 'refs/heads/', remote: 'refs/remotes/', tag: 'refs/tags/' } as const;

/**
 * History filter for the backend's `log` / `historyPosition`: refs that no longer exist are left out,
 * so a deleted branch cannot break the graph. Returns undefined when nothing is filtered.
 */
export function historyScope(
  repo: string,
  existing: { local: { name: string }[]; remote: { name: string }[]; tags: { name: string }[] },
) {
  const { graphHidden, graphSolo } = useSettings.getState();
  const names = {
    local: new Set(existing.local.map((r) => r.name)),
    remote: new Set(existing.remote.map((r) => r.name)),
    tag: new Set(existing.tags.map((r) => r.name)),
  };
  const parse = (key: string) => {
    const at = key.indexOf(':');
    const kind = key.slice(0, at) as keyof typeof FULL;
    const name = key.slice(at + 1);
    return kind in FULL && names[kind].has(name) ? { kind, name } : null;
  };
  const solo = (graphSolo[repo] ?? []).map(parse).filter((r) => r !== null);
  if (solo.length) return { solo: solo.map((r) => FULL[r.kind] + r.name) };
  const hidden = (graphHidden[repo] ?? []).map(parse).filter((r) => r !== null);
  if (!hidden.length) return undefined;
  return {
    hide: {
      branches: hidden.filter((r) => r.kind === 'local').map((r) => r.name),
      remotes: hidden.filter((r) => r.kind === 'remote').map((r) => r.name),
      tags: hidden.filter((r) => r.kind === 'tag').map((r) => r.name),
    },
  };
}
