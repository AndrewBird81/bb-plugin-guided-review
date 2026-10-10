import { cn } from "../../lib/utils";

const BLOCKS = 5;

/** Additions and deletions, with bb's five-block size bar. */
export function DiffStat({ add, del, className }: { add: number; del: number; className?: string }) {
  const total = add + del;
  const filled = total ? Math.min(BLOCKS, Math.max(1, Math.ceil(Math.log10(total + 1) * 2))) : 0;
  const added = total ? Math.round((add / total) * filled) : 0;
  return (
    <span className={cn("inline-flex shrink-0 items-center gap-1.5 font-mono text-[11px] tabular-nums", className)}>
      <span className="text-diff-added">+{add}</span>
      <span className="text-diff-removed">−{del}</span>
      <span aria-hidden className="flex gap-px">
        {Array.from({ length: BLOCKS }, (_, index) => (
          <span key={index} className={cn("size-1.5 rounded-[1px]", index < added ? "bg-diff-added" : index < filled ? "bg-diff-removed" : "bg-muted")} />
        ))}
      </span>
    </span>
  );
}

/** A thin progress track, green as it fills. */
export function Progress({ value, max, className, label }: { value: number; max: number; className?: string; label?: string }) {
  const ratio = max ? Math.min(1, value / max) : 0;
  return (
    <span role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={max} aria-valuenow={value} className={cn("relative block h-1 overflow-hidden rounded-full bg-muted", className)}>
      <span className={cn("absolute inset-y-0 left-0 rounded-full transition-[width] duration-300 motion-reduce:transition-none", ratio === 1 ? "bg-success" : "bg-primary")} style={{ width: `${ratio * 100}%` }} />
    </span>
  );
}
