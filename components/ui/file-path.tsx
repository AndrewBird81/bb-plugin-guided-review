import { cn } from "../../lib/utils";

/** A monospace path whose directory recedes, so the file's name leads. */
export function FilePath({ path, className, nameClassName }: { path: string; className?: string; nameClassName?: string }) {
  const cut = path.lastIndexOf("/") + 1;
  return (
    <span className={cn("flex min-w-0 font-mono", className)} title={path}>
      {cut > 0 && <span className="min-w-0 truncate text-muted-foreground">{path.slice(0, cut)}</span>}
      <span className={cn("shrink-0 text-foreground", nameClassName)}>{path.slice(cut)}</span>
    </span>
  );
}
