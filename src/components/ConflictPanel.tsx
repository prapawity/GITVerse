import { useEffect, useState } from 'react';
import { AlertTriangle, ChevronDown, ChevronRight, ExternalLink, FileMinus, FilePen, FilePlus } from 'lucide-react';
import { askConfirm } from './Dialogs';
import { useRepo } from '../store/repoStore';

const NAME = { rebase: 'Rebase', merge: 'Merge', 'cherry-pick': 'Cherry-pick', revert: 'Revert' } as const;
const Chip = ({ children, tone }: { children: React.ReactNode; tone: 'branch' | 'commit' }) => (
  <span
    className={`rounded px-1.5 py-0.5 font-medium ${tone === 'branch' ? 'bg-[#a855f7]/30 text-[#e9d5ff]' : 'bg-[#2dd4bf]/25 text-[#ccfbf1]'}`}
  >
    {children}
  </span>
);
const split = (p: string) => {
  const i = p.lastIndexOf('/');
  return [p.slice(0, i + 1), p.slice(i + 1)];
};

function Section({
  title,
  count,
  action,
  children,
}: {
  title: string;
  count: number;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(true);
  return (
    <div className="border-b border-surface/60">
      <div className="flex items-center gap-2 px-4 py-2">
        <button
          aria-expanded={open}
          onClick={() => setOpen(!open)}
          className="flex min-h-[32px] flex-1 items-center gap-1.5 text-left text-[15px]"
        >
          {open ? <ChevronDown size={15} aria-hidden /> : <ChevronRight size={15} aria-hidden />} {title} ({count})
        </button>
        {action}
      </div>
      {open && <div className="pb-2">{children}</div>}
    </div>
  );
}

/** GitKraken-style conflict workflow shown in the right panel while an operation is stopped. */
export function ConflictPanel() {
  const { operation: op, exec, repoPath, toast, conflictFile, openConflict, working } = useRepo();
  const [message, setMessage] = useState('');
  useEffect(() => setMessage(op?.message ?? ''), [op?.message, op?.step]);
  if (!op) return null;

  const name = NAME[op.kind];
  const left = op.files.length;
  const busy = !!working;
  const original = op.message;

  const headline =
    op.kind === 'rebase' ? (
      <>
        Rebasing <Chip tone="branch">{op.head}</Chip> onto <Chip tone="commit">{op.onto}</Chip>
      </>
    ) : op.kind === 'merge' ? (
      <>
        Merging <Chip tone="commit">{op.onto}</Chip> into <Chip tone="branch">{op.head}</Chip>
      </>
    ) : op.kind === 'cherry-pick' ? (
      <>
        Cherry-picking <Chip tone="commit">{op.onto}</Chip> onto <Chip tone="branch">{op.head}</Chip>
      </>
    ) : (
      <>
        Reverting <Chip tone="commit">{op.onto}</Chip> on <Chip tone="branch">{op.head}</Chip>
      </>
    );

  const markAll = async () => {
    if (
      !(await askConfirm(
        'Mark all resolved?',
        `Stage all ${left} conflicted files as they are now? Review each file first; unresolved conflict markers may remain.`,
        { label: 'Mark all resolved', danger: true },
      ))
    )
      return;
    for (const f of op.files) {
      const current = useRepo.getState();
      if (
        current.repoPath !== repoPath ||
        current.operation?.kind !== op.kind ||
        !current.operation.files.includes(f)
      ) {
        current.notify(
          'warning',
          'Mark all stopped',
          'The repository or conflict list changed. Review the remaining files.',
        );
        break;
      }
      await exec('resolveFile', f, 'mark');
      if (useRepo.getState().operation?.files.includes(f)) break;
    }
  };
  const abort = async () => {
    if (
      await askConfirm(
        `Abort ${name.toLowerCase()}`,
        `Stop the ${name.toLowerCase()} and put ${op.head} back exactly as it was before it started. Any conflict resolutions made so far are discarded.`,
        { label: `Abort ${name}`, danger: true },
      )
    )
      exec('opAbort', op.kind);
  };
  const skip = async () => {
    if (
      await askConfirm('Skip this commit', 'Drop the commit that is being applied and move on to the next one.', {
        label: 'Skip commit',
      })
    )
      exec('opSkip', op.kind);
  };
  const cont = () =>
    exec('opContinue', op.kind, message.trim() && message.trim() !== original ? message.trim() : undefined);
  const openExternal = async (f: string) => {
    try {
      await (window as any).gitApi.openFile(repoPath, f);
    } catch (e: any) {
      toast(e.message);
    }
  };

  return (
    <section aria-label={`${name} conflicts`} className="flex h-full flex-col overflow-hidden">
      <header className="flex items-center justify-center gap-2 border-b border-surface px-4 py-3 text-[15px] font-semibold">
        <AlertTriangle size={17} className="text-[#f5a623]" aria-hidden />
        {left ? `${name} conflicts detected` : `${name} ready to continue`}
      </header>
      <div className="px-4 pt-3 text-center text-[14px] leading-7">
        {headline}
        {op.step && <div className="text-[12px] text-sub">commit {op.step.replace('/', ' of ')}</div>}
      </div>
      <div role="status" className="mx-4 mt-3 rounded-lg border border-surface bg-crust/50 px-3 py-2 text-sm">
        <div className="font-medium">
          {left ? `${left} file${left === 1 ? '' : 's'} still need resolution` : 'All conflicts resolved'}
        </div>
        <p className="mt-1 text-xs leading-relaxed text-sub">
          {left
            ? 'Open each conflicted file, resolve it, then mark it resolved.'
            : `Review the staged files, then ${op.kind === 'merge' ? 'commit the merge' : `continue the ${name.toLowerCase()}`}.`}
        </p>
      </div>

      <div className="mt-2 min-h-0 flex-1 overflow-auto">
        <Section
          title="Conflicted Files"
          count={left}
          action={
            left > 0 && (
              <button
                onClick={() => void markAll()}
                disabled={busy}
                title="Stage every conflicted file as it is now"
                className="min-h-[30px] rounded border border-[#f5a623]/70 px-2.5 text-[13px] text-[#f5c26b] hover:bg-[#f5a623]/15 disabled:opacity-40"
              >
                Mark All Resolved
              </button>
            )
          }
        >
          {!left && <div className="px-6 py-1 text-[13px] text-sub">No conflicts left.</div>}
          {op.files.map((f) => {
            const [dir, base] = split(f);
            return (
              <div
                key={f}
                className={`group flex items-center ${conflictFile === f ? 'bg-[#4cc2ff]/20' : 'hover:bg-surface/40'}`}
              >
                <button
                  onClick={() => openConflict(f)}
                  aria-pressed={conflictFile === f}
                  className="flex min-h-[36px] min-w-0 flex-1 items-center gap-2 px-4 text-left"
                  title={`Resolve ${f}`}
                >
                  <AlertTriangle size={14} className="shrink-0 text-[#f5a623]" aria-hidden />
                  <span className="truncate">
                    <span className="text-sub">{dir}</span>
                    {base}
                  </span>
                </button>
                <button
                  onClick={() => openExternal(f)}
                  aria-label={`Open ${base} in editor`}
                  title="Open in editor"
                  className="mr-2 rounded p-1.5 text-sub opacity-0 hover:bg-surface hover:text-text focus:opacity-100 group-hover:opacity-100"
                >
                  <ExternalLink size={14} />
                </button>
              </div>
            );
          })}
        </Section>

        <Section title="Staged Files" count={op.resolved.length}>
          <p className="px-6 pb-1 text-xs text-sub">Includes all staged files in this operation.</p>
          {!op.resolved.length && <div className="px-6 py-1 text-[13px] text-sub">Files you stage appear here.</div>}
          {op.resolved.map((f) => {
            const [dir, base] = split(f.path);
            const I = f.status === 'A' ? FilePlus : f.status === 'D' ? FileMinus : FilePen;
            return (
              <div key={f.path} className="flex min-h-[32px] items-center gap-2 px-4" title={f.path}>
                <I
                  size={14}
                  aria-hidden
                  className={`shrink-0 ${f.status === 'A' ? 'text-[#a6e3a1]' : f.status === 'D' ? 'text-[#f38ba8]' : 'text-[#fab387]'}`}
                />
                <span className="truncate">
                  <span className="text-sub">{dir}</span>
                  {base}
                </span>
              </div>
            );
          })}
        </Section>
      </div>

      <div className="border-t border-surface p-4">
        <label htmlFor="op-msg" className="mb-1 block text-[13px] text-sub">
          Commit message
        </label>
        <textarea
          id="op-msg"
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          rows={5}
          className="w-full resize-none rounded-md border border-surface bg-crust p-3 font-sans outline-none focus:border-[#4cc2ff]"
        />
        {op.kind !== 'merge' && (
          <button
            onClick={skip}
            disabled={busy}
            className="mt-1 text-[13px] text-sub underline hover:text-text disabled:opacity-40"
          >
            Skip this commit
          </button>
        )}
        <div className="mt-3 grid grid-cols-2 gap-3">
          <button
            onClick={cont}
            disabled={left > 0 || busy}
            title={left ? `Resolve ${left} conflicted file${left === 1 ? '' : 's'} first` : undefined}
            className="min-h-[44px] rounded-md border border-[#a6e3a1]/50 bg-[#a6e3a1]/15 font-medium text-[#a6e3a1] hover:bg-[#a6e3a1]/25 disabled:border-surface disabled:bg-transparent disabled:text-sub/60"
          >
            {op.kind === 'merge' ? 'Commit Merge' : `Continue ${name}`}
          </button>
          <button
            onClick={abort}
            disabled={busy}
            className="min-h-[44px] rounded-md border border-[#f38ba8]/60 bg-[#f38ba8]/10 font-medium text-[#f38ba8] hover:bg-[#f38ba8]/20 disabled:opacity-40"
          >
            Abort {name}
          </button>
        </div>
      </div>
    </section>
  );
}

/** Clickable first row of the graph while an operation is stopped — like GitKraken's WIP conflict row. */
export function ConflictRow() {
  const { operation: op, showConflicts, conflictView } = useRepo();
  if (!op) return null;
  const n = op.files.length;
  return (
    <button
      onClick={showConflicts}
      aria-pressed={conflictView}
      className={`flex h-[30px] w-full shrink-0 items-center gap-2 px-4 text-left text-[13px] font-medium ${n ? 'bg-[#b7791f]/70 text-[#fff7e6] hover:bg-[#b7791f]/85' : 'bg-[#2f6f4f]/70 text-[#e7fff2] hover:bg-[#2f6f4f]/85'}`}
    >
      <AlertTriangle size={14} aria-hidden />
      {n
        ? `${n} file conflict${n === 1 ? ' was' : 's were'} found when attempting to ${op.kind === 'rebase' ? 'rebase' : op.kind} into ${op.head}`
        : `All conflicts resolved — continue the ${op.kind}`}
    </button>
  );
}
