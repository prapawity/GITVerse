import type { ReactNode } from 'react';

/** Small, dependency-free Markdown renderer (headings, lists, task lists, code, bold, links). */
function inline(t: string, key = ''): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /`([^`]+)`|\*\*([^*]+)\*\*|\[([^\]]+)\]\((https?:[^)\s]+)\)/g;
  let last = 0,
    i = 0;
  for (let m; (m = re.exec(t)); i++) {
    if (m.index > last) out.push(t.slice(last, m.index));
    if (m[1] != null)
      out.push(
        <code key={key + i} className="rounded bg-white/10 px-1.5 py-0.5 font-mono text-[0.9em]">
          {m[1]}
        </code>,
      );
    else if (m[2] != null) out.push(<strong key={key + i}>{m[2]}</strong>);
    else
      out.push(
        <a key={key + i} href={m[4]} target="_blank" rel="noreferrer noopener" className="text-[#4cc2ff] underline">
          {m[3]}
        </a>,
      );
    last = m.index + m[0].length;
  }
  if (last < t.length) out.push(t.slice(last));
  return out;
}

export function Markdown({ text }: { text: string }) {
  const lines = text.split('\n');
  const out: ReactNode[] = [];
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (l.startsWith('```')) {
      const code: string[] = [];
      for (i++; i < lines.length && !lines[i].startsWith('```'); i++) code.push(lines[i]);
      out.push(
        <pre key={i} className="my-3 overflow-auto rounded-md bg-black/30 p-3 font-mono text-[13px]">
          {code.join('\n')}
        </pre>,
      );
      continue;
    }
    const h = /^(#{1,6})\s+(.*)/.exec(l);
    if (h) {
      const sz = ['text-[28px]', 'text-[22px]', 'text-[18px]', 'text-[16px]', 'text-[15px]', 'text-[14px]'][
        h[1].length - 1
      ];
      out.push(
        <div
          key={i}
          role="heading"
          aria-level={h[1].length}
          className={`${sz} mb-2 mt-5 border-b border-white/10 pb-1 font-semibold`}
        >
          {inline(h[2], `h${i}`)}
        </div>,
      );
      continue;
    }
    if (/^\s*([-*]|\d+\.)\s+/.test(l)) {
      const items: ReactNode[] = [];
      for (; i < lines.length && /^\s*([-*]|\d+\.)\s+/.test(lines[i]); i++) {
        const m = /^\s*(?:[-*]|\d+\.)\s+(?:\[( |x|X)\]\s+)?(.*)/.exec(lines[i])!;
        items.push(
          <li key={i} className="flex items-start gap-2 py-0.5">
            {m[1] != null ? (
              <input type="checkbox" checked={m[1] !== ' '} readOnly aria-label={m[2]} className="mt-1" />
            ) : (
              <span aria-hidden className="text-sub">
                •
              </span>
            )}
            <span>{inline(m[2], `l${i}`)}</span>
          </li>,
        );
      }
      i--;
      out.push(
        <ul key={`u${i}`} className="my-2">
          {items}
        </ul>,
      );
      continue;
    }
    if (/^\s*(---|\*\*\*)\s*$/.test(l)) {
      out.push(<hr key={i} className="my-4 border-white/10" />);
      continue;
    }
    if (!l.trim()) continue;
    const para: string[] = [l];
    while (i + 1 < lines.length && lines[i + 1].trim() && !/^(#{1,6}\s|```|\s*([-*]|\d+\.)\s)/.test(lines[i + 1]))
      para.push(lines[++i]);
    out.push(
      <p key={i} className="my-2 leading-relaxed">
        {inline(para.join(' '), `p${i}`)}
      </p>,
    );
  }
  return <div className="px-8 py-4 font-sans text-[15px]">{out}</div>;
}
