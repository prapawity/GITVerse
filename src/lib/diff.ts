export interface DiffLine {
  type: 'ctx' | 'add' | 'del';
  oldNo?: number;
  newNo?: number;
  text: string;
}
export interface Hunk {
  header: string;
  lines: DiffLine[];
}

export function parseDiff(text: string): { hunks: Hunk[]; binary: boolean } {
  const hunks: Hunk[] = [];
  let cur: Hunk | null = null;
  let o = 0,
    n = 0;
  if (/^Binary files .* differ$/m.test(text)) return { hunks, binary: true };
  for (const raw of text.split('\n')) {
    const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);
    if (m) {
      o = +m[1];
      n = +m[2];
      cur = { header: raw, lines: [] };
      hunks.push(cur);
      continue;
    }
    if (!cur) continue; // skip "diff --git / index / --- / +++" preamble
    if (raw.startsWith('+')) cur.lines.push({ type: 'add', newNo: n++, text: raw.slice(1) });
    else if (raw.startsWith('-')) cur.lines.push({ type: 'del', oldNo: o++, text: raw.slice(1) });
    else if (raw.startsWith(' ')) cur.lines.push({ type: 'ctx', oldNo: o++, newNo: n++, text: raw.slice(1) });
  }
  return { hunks, binary: false };
}

/** Pair deletions with the additions that follow so split view lines up. */
export function toSplit(lines: DiffLine[]): [DiffLine | null, DiffLine | null][] {
  const out: [DiffLine | null, DiffLine | null][] = [];
  for (let i = 0; i < lines.length;) {
    if (lines[i].type === 'ctx') {
      out.push([lines[i], lines[i]]);
      i++;
      continue;
    }
    const dels: DiffLine[] = [],
      adds: DiffLine[] = [];
    while (i < lines.length && lines[i].type === 'del') dels.push(lines[i++]);
    while (i < lines.length && lines[i].type === 'add') adds.push(lines[i++]);
    for (let k = 0; k < Math.max(dels.length, adds.length); k++) out.push([dels[k] ?? null, adds[k] ?? null]);
  }
  return out;
}

const TOKEN =
  /(\/\/.*$|\/\*.*?\*\/)|("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`)|\b(const|let|var|function|return|if|else|for|while|await|async|import|export|from|class|new|true|false|null|undefined|public|private|protected|static|final|void|int|extends|implements|try|catch|throw|of|in|default|type|interface|package)\b|\b(\d+(?:\.\d+)?)\b/g;
const CLS = ['', 'text-[#6c7a89]', 'text-[#f0a07a]', 'text-[#4fc1e9]', 'text-[#fab387]'];

export type Tok = { t: string; c: string };
export function highlight(line: string): Tok[] {
  const out: Tok[] = [];
  let last = 0;
  TOKEN.lastIndex = 0;
  for (let m; (m = TOKEN.exec(line));) {
    if (m.index > last) out.push({ t: line.slice(last, m.index), c: '' });
    const g = m.slice(1).findIndex(Boolean) + 1;
    out.push({ t: m[0], c: CLS[g] });
    last = m.index + m[0].length;
  }
  if (last < line.length) out.push({ t: line.slice(last), c: '' });
  return out;
}
