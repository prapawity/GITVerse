import { Archive, Cloud, Laptop, PanelLeftOpen, Tag } from 'lucide-react';
import { useRepo } from '../store/repoStore';

/** Collapsed sidebar shown while a file is open (like GitKraken's icon rail). */
export function FileRail({ onExpand }: { onExpand: () => void }) {
  const { refs } = useRepo();
  const items = [
    { icon: Laptop, label: 'Local branches', n: refs.local.length },
    { icon: Cloud, label: 'Remote branches', n: refs.remote.length },
    { icon: Archive, label: 'Stashes', n: refs.stashes.length },
    { icon: Tag, label: 'Tags', n: refs.tags.length },
  ];
  return (
    <nav aria-label="Repository" className="flex h-full w-[56px] shrink-0 flex-col items-center gap-1 border-r border-surface bg-mantle py-3">
      <button aria-label="Expand sidebar" title="Expand sidebar" onClick={onExpand} className="mb-2 flex h-10 w-10 items-center justify-center rounded-md text-sub hover:bg-surface hover:text-text">
        <PanelLeftOpen size={20} />
      </button>
      {items.map(({ icon: I, label, n }) => (
        <button key={label} aria-label={`${label}: ${n}`} title={`${label} (${n})`} onClick={onExpand} className="flex min-h-[48px] w-11 flex-col items-center justify-center rounded-md text-sub hover:bg-surface hover:text-text">
          <I size={19} aria-hidden />
          <span className="text-[11px] font-semibold text-[#4cc2ff]">{n}</span>
        </button>
      ))}
    </nav>
  );
}
