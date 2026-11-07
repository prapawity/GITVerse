import type { RefLabel } from '../shared/types';

export function groupRefs(refs: RefLabel[]): { ref: RefLabel; remotes: string[] }[] {
  const locals = new Map(refs.filter((ref) => ref.kind === 'local').map((ref) => [ref.name, ref]));
  const groups = new Map<RefLabel, { ref: RefLabel; remotes: string[] }>();
  for (const ref of refs) {
    const slash = ref.name.indexOf('/');
    const local = ref.kind === 'remote' && slash > 0 ? locals.get(ref.name.slice(slash + 1)) : undefined;
    const primary = local ?? ref;
    if (!groups.has(primary)) groups.set(primary, { ref: primary, remotes: [] });
    if (local) groups.get(primary)!.remotes.push(ref.name.slice(0, slash));
  }
  return [...groups.values()];
}
