import { memo } from "react";
import { Skeleton } from "./ui/skeleton";
import { Icon } from "./ui/icon";
import { Button } from "./ui/button";
import { Badge } from "./ui/badge";
import { IconTile } from "./ui/icon-tile";

/**
 * Loading placeholder for the review workspace — mirrors the real layout
 * (header, chapter sidebar, diff column) so the guide "settles in" instead of
 * popping from a bare line of text. Shown while the generation agent authors
 * the guide.
 */
export const ReviewSkeleton = memo(function ReviewSkeleton() {
  return (
    <div className="flex h-full min-w-0 flex-col bg-background" role="status" aria-label="Building the review guide">
      {/* Header */}
      <div className="flex items-center gap-3 border-b border-border p-3">
        <Skeleton className="size-8 shrink-0 rounded-lg" />
        <div className="min-w-0 flex-1 space-y-2">
          <Skeleton className="h-4 w-64 max-w-full" />
          <Skeleton className="h-3 w-2/3" />
        </div>
      </div>

      <div className="flex min-h-0 flex-1">
        {/* Chapter sidebar */}
        <aside className="hidden w-72 shrink-0 space-y-3 border-r border-border p-3 md:block">
          <Skeleton className="h-2.5 w-16" />
          <Skeleton className="h-1 w-full rounded-full" />
          <div className="space-y-3 pt-1">
            {Array.from({ length: 5 }).map((_, i) => (
              <div key={i} className="flex items-start gap-2.5">
                <Skeleton className="size-[22px] shrink-0 rounded-full" />
                <div className="min-w-0 flex-1 space-y-1.5">
                  <Skeleton className="h-3.5" style={{ width: `${80 - i * 7}%` }} />
                  <Skeleton className="h-3 w-1/2" />
                </div>
              </div>
            ))}
          </div>
        </aside>

        {/* Diff column */}
        <main className="flex min-w-0 flex-1 flex-col">
          <div className="flex items-center gap-2 border-b border-border px-3 py-2">
            <Skeleton className="h-6 w-28" />
            <Skeleton className="ml-auto h-4 w-24" />
          </div>
          <div className="flex-1 space-y-4 overflow-hidden p-4">
            {Array.from({ length: 3 }).map((_, f) => (
              <div key={f} className="overflow-hidden rounded-lg border border-border bg-card">
                <div className="flex items-center gap-2 border-b border-border bg-muted/40 px-3 py-2">
                  <Icon name="File" className="size-3.5 text-muted-foreground" aria-hidden />
                  <Skeleton className="h-3 w-48" />
                  <Skeleton className="ml-auto h-3 w-10" />
                </div>
                <div className="space-y-2 p-3">
                  {Array.from({ length: 4 + f }).map((_, l) => (
                    <Skeleton key={l} className="h-3" style={{ width: `${88 - ((l * 13) % 45)}%` }} />
                  ))}
                </div>
              </div>
            ))}
          </div>
        </main>
      </div>

      <div className="flex justify-center border-t border-border py-3">
        <Badge tone="warning" icon={<Icon name="Loading" className="animate-spin motion-reduce:animate-none" aria-hidden />}>Building the guide…</Badge>
      </div>
    </div>
  );
});
ReviewSkeleton.displayName = "ReviewSkeleton";

/** Terminal error state when generation failed. */
export const ReviewError = memo(function ReviewError({ title = "Generation failed", message = "The guide could not be completed. Check your coding-agent provider and try rebuilding it.", onRetry, onBack, busy = false }: { title?: string; message?: string; onRetry?: () => void; onBack?: () => void; busy?: boolean }) {
  return (
    <div role="alert" className="flex h-full flex-col items-center justify-center gap-4 p-6 text-center">
      <IconTile tone="danger" icon="AlertTriangle" className="size-12 rounded-2xl" iconClassName="size-6" />
      <div className="max-w-lg space-y-2">
        <h2 className="text-base font-semibold text-foreground">{title}</h2>
        <p className="break-words text-sm leading-relaxed text-muted-foreground">{message}</p>
      </div>
      <div className="flex flex-wrap justify-center gap-2">
        {onRetry && <Button disabled={busy} onClick={onRetry}>{busy ? "Rebuilding…" : "Try again"}</Button>}
        {onBack && <Button variant="outline" onClick={onBack}>All reviews</Button>}
      </div>
    </div>
  );
});
ReviewError.displayName = "ReviewError";
