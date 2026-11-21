/** Small "LFS" tag next to files stored with Git LFS. */
export function LfsBadge() {
  return (
    <span
      title="Stored with Git LFS"
      className="shrink-0 rounded border border-accent/40 px-1 text-[10px] font-semibold leading-4 text-accent"
    >
      LFS
    </span>
  );
}
