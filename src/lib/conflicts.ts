export type Seg = { kind: 'text'; text: string } | { kind: 'conflict'; ours: string; base?: string; theirs: string };

/** Split a file containing git conflict markers into plain text and conflict blocks (diff3 style supported). */
export function parseConflicts(src: string): Seg[] {
  const lines = src.split('\n');
  const out: Seg[] = [];
  let text: string[] = [];
  const flush = () => { if (text.length) out.push({ kind: 'text', text: text.join('\n') }); text = []; };
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].startsWith('<<<<<<<')) { text.push(lines[i]); continue; }
    const ours: string[] = [], base: string[] = [], theirs: string[] = [];
    let part: string[] = ours, j = i + 1, closed = false, hasBase = false;
    for (; j < lines.length; j++) {
      const l = lines[j];
      if (l.startsWith('|||||||') && part === ours) { part = base; hasBase = true; continue; }
      if (l.startsWith('=======') && part !== theirs) { part = theirs; continue; }
      if (l.startsWith('>>>>>>>') && part === theirs) { closed = true; break; }
      part.push(l);
    }
    if (!closed) { text.push(lines[i]); continue; } // stray marker: keep as text
    flush();
    out.push({ kind: 'conflict', ours: ours.join('\n'), base: hasBase ? base.join('\n') : undefined, theirs: theirs.join('\n') });
    i = j;
  }
  flush();
  return out;
}

export type Pick = { a: boolean; b: boolean; ai?: string; manual?: string };

/** The text a conflict contributes to the merged output under a given pick. */
export const piece = (s: Extract<Seg, { kind: 'conflict' }>, p: Pick = { a: false, b: false }) =>
  p.manual != null ? p.manual : p.ai != null ? p.ai : [p.a ? s.ours : null, p.b ? s.theirs : null].filter((x) => x != null).join('\n');

export function matchResolution(s: Extract<Seg, { kind: 'conflict' }>, text: string): Pick {
  if (text === s.ours && text === s.theirs) return { a: true, b: true };
  if (text === s.ours) return { a: true, b: false };
  if (text === s.theirs) return { a: false, b: true };
  if (text === `${s.ours}\n${s.theirs}`) return { a: true, b: true };
  return { a: false, b: false, manual: text };
}

export function buildOutput(segs: Seg[], picks: Pick[]): string {
  let k = 0;
  return segs.map((s) => (s.kind === 'text' ? s.text : piece(s, picks[k++]))).join('\n');
}

/** Prompt for "Auto-resolve with AI": numbered regions with both sides and nearby context. */
export function conflictPrompt(path: string, segs: Seg[], aLabel: string, bLabel: string, op: string): string {
  const CTX = 25;
  const parts: string[] = [`File: ${path}`, `Operation: ${op}`, `A = ${aLabel}`, `B = ${bLabel}`, ''];
  let k = -1;
  segs.forEach((s, i) => {
    if (s.kind !== 'conflict') return;
    k++;
    const before = segs[i - 1]?.kind === 'text' ? (segs[i - 1] as { text: string }).text.split('\n').slice(-CTX).join('\n') : '';
    const after = segs[i + 1]?.kind === 'text' ? (segs[i + 1] as { text: string }).text.split('\n').slice(0, CTX).join('\n') : '';
    parts.push(`<region index="${k}">`, `<context_before>\n${before}\n</context_before>`, `<A>\n${s.ours}\n</A>`);
    if (s.base != null) parts.push(`<base>\n${s.base}\n</base>`);
    parts.push(`<B>\n${s.theirs}\n</B>`, `<context_after>\n${after}\n</context_after>`, '</region>', '');
  });
  parts.push(`Return one resolution for each of the ${k + 1} region(s).`);
  return parts.join('\n');
}

export const hasMarkers = (t: string) => /^(<<<<<<<|=======|>>>>>>>)/m.test(t);

export interface Region { index: number; A: string; B: string; base?: string; context_before: string; context_after: string }

/** The conflicts of a file as numbered regions with a little surrounding code (what a model needs to decide). */
export function describeRegions(src: string, ctx = 20): Region[] {
  const segs = parseConflicts(src);
  const out: Region[] = [];
  segs.forEach((s, i) => {
    if (s.kind !== 'conflict') return;
    const before = segs[i - 1]?.kind === 'text' ? (segs[i - 1] as { text: string }).text.split('\n').slice(-ctx).join('\n') : '';
    const after = segs[i + 1]?.kind === 'text' ? (segs[i + 1] as { text: string }).text.split('\n').slice(0, ctx).join('\n') : '';
    out.push({ index: out.length, A: s.ours, B: s.theirs, ...(s.base != null ? { base: s.base } : {}), context_before: before, context_after: after });
  });
  return out;
}

/** Replace every conflict with the given text. Refuses partial answers and leftover markers, so a bad answer never reaches disk. */
export function applyResolutions(src: string, resolutions: { index: number; resolved: string }[]): { ok: true; text: string } | { ok: false; error: string } {
  const segs = parseConflicts(src);
  const n = segs.filter((s) => s.kind === 'conflict').length;
  if (!n) return { ok: false, error: 'This file has no conflict markers.' };
  const byIndex = new Map<number, string>();
  for (const r of resolutions) {
    if (!Number.isInteger(r.index) || r.index < 0 || r.index >= n) return { ok: false, error: `Region ${r.index} does not exist (this file has ${n} region(s), numbered from 0).` };
    if (byIndex.has(r.index)) return { ok: false, error: `Region ${r.index} was given twice.` };
    if (hasMarkers(r.resolved)) return { ok: false, error: `Region ${r.index}'s text still contains conflict markers.` };
    byIndex.set(r.index, r.resolved);
  }
  const missing = [...Array(n).keys()].filter((i) => !byIndex.has(i));
  if (missing.length) return { ok: false, error: `Missing resolutions for region(s) ${missing.join(', ')}. Every region must be resolved in one call.` };
  return { ok: true, text: buildOutput(segs, [...Array(n).keys()].map((i) => ({ a: false, b: false, ai: byIndex.get(i)! }))) };
}
