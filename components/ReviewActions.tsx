import { useRef, useState } from "react";
import { useRpc } from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import type { rpcContract } from "../src/rpc-contract";
import type { ReviewItem } from "../lib/review-state";
import { updateDraftRecovery } from "../lib/draft-recovery";
import { cn } from "../lib/utils";
import { Button } from "./ui/button";
import { Icon } from "./ui/icon";
import { Popover, PopoverContent, PopoverTrigger } from "./ui/popover";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "./ui/dialog";

/** Archive, unarchive, or permanently delete one saved review. */
export function ReviewActions({ review, onChanged, onDeleted, describedBy, className }: {
  review: ReviewItem;
  onChanged?: () => void;
  onDeleted?: () => void;
  /** Id of the element naming this review, for screen readers. */
  describedBy?: string;
  className?: string;
}) {
  const rpc = useRpc<typeof rpcContract>();
  const trigger = useRef<HTMLButtonElement>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const title = review.title ?? review.gitRef ?? review.targetKey;
  // GitHub state archives merged and closed PRs; only the reviewer's own archive can be undone.
  const closed = review.prState === "MERGED" || review.prState === "CLOSED" || !!review.archivedAt;

  async function run(call: () => Promise<{ ok: boolean; error?: string }>, success: string) {
    setBusy(true);
    try {
      const result = await call();
      if (!result.ok) toast.error(result.error ?? "Couldn’t update this review. Try again.");
      else toast.success(success);
      return result.ok;
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Couldn’t update this review. Try again.");
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function setArchived(archived: boolean) {
    setMenuOpen(false);
    const ok = await run(() => rpc.call("archiveReview", { targetKey: review.targetKey, archived }), archived ? "Review archived" : "Review unarchived");
    if (ok) onChanged?.();
  }

  async function remove() {
    if (!await run(() => rpc.call("deleteReview", { targetKey: review.targetKey }), "Review deleted")) return;
    // This tab's unsaved-text recovery must not resurface if the PR is reviewed again.
    updateDraftRecovery(review.targetKey, { summary: undefined, composer: undefined });
    setConfirming(false);
    onDeleted?.();
  }

  return <>
    <Popover open={menuOpen} onOpenChange={setMenuOpen}>
      <PopoverTrigger asChild>
        <Button ref={trigger} variant="ghost" size="icon" aria-label="Review actions" aria-describedby={describedBy} disabled={busy} className={cn("shrink-0 text-muted-foreground", className)}>
          <Icon name="MoreHorizontal" aria-hidden />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" mobileTitle="Review actions" className="w-60 max-w-[calc(100vw-24px)] p-1">
        {!closed && <Button variant="ghost" size="sm" className="w-full justify-start text-muted-foreground hover:text-foreground" onClick={() => void setArchived(!review.userArchivedAt)}>
          <Icon name={review.userArchivedAt ? "ArchiveRestore" : "Archive"} aria-hidden />{review.userArchivedAt ? "Unarchive" : "Archive"}
        </Button>}
        <Button variant="ghost" size="sm" className="w-full justify-start text-destructive-text hover:bg-destructive/10 hover:text-destructive-text" disabled={review.status === "generating"} onClick={() => { setMenuOpen(false); setConfirming(true); }}>
          <Icon name="Trash2" aria-hidden />Delete…
        </Button>
        {review.status === "generating" && <p className="px-3 pb-2 text-xs text-muted-foreground">You can delete this review once its guide finishes generating.</p>}
      </PopoverContent>
    </Popover>
    <Dialog open={confirming} onOpenChange={(open) => { if (!busy) setConfirming(open); }}>
      <DialogContent onCloseAutoFocus={(event) => { event.preventDefault(); trigger.current?.focus(); }}>
        <DialogHeader>
          <DialogTitle>Delete this review?</DialogTitle>
          <DialogDescription>“{title}” will be permanently removed from Guided Review, with its guide, draft comments, reviewer notes, and assistant conversation. Nothing changes on GitHub.</DialogDescription>
        </DialogHeader>
        <DialogFooter className="gap-2 sm:space-x-0">
          <Button variant="outline" disabled={busy} onClick={() => setConfirming(false)}>Cancel</Button>
          <Button variant="destructive" disabled={busy} onClick={() => void remove()}>{busy ? "Deleting…" : "Delete review"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </>;
}
