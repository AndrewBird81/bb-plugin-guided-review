import { memo, useCallback, useEffect, useRef, useState } from "react";
import { useRpc, useRealtime } from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import type { rpcContract } from "../src/rpc-contract";
import { cn } from "../lib/utils";
import { Button } from "./ui/button";
import { Badge } from "./ui/badge";
import { Icon } from "./ui/icon";

export const RereviewBanner = memo(function RereviewBanner({ targetKey }: { targetKey: string }) {
  const rpc = useRpc<typeof rpcContract>();
  const [hasNewCommits, setHasNewCommits] = useState(false);
  const [busy, setBusy] = useState(false);
  const cancelledRef = useRef(false);

  const recheck = useCallback(async () => {
    try {
      const r = await rpc.call("checkForUpdates", { targetKey });
      if (!cancelledRef.current) setHasNewCommits(r.hasNewCommits);
    } catch {
      // Non-fatal: staleness check just won't show a banner.
    }
  }, [rpc, targetKey]);

  useEffect(() => {
    cancelledRef.current = false;
    void recheck();
    return () => {
      cancelledRef.current = true;
    };
  }, [recheck]);

  // Re-check on every review update (e.g. after Re-review completes and the
  // guide is rebuilt against the new head) so the banner doesn't stay stale.
  useRealtime(`review:${targetKey}`, () => {
    void recheck();
  });

  async function reReview() {
    setBusy(true);
    try {
      const res = await rpc.call("rereview", { targetKey });
      if (res.ok) toast.success("Re-review started");
      else toast.error(res.error ?? "Re-review failed");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Something went wrong");
    } finally {
      setBusy(false);
    }
  }

  // Sits at the end of the review's title row. New commits add a pill and
  // promote the button, so the nudge reads without a band of its own.
  return (
    <span className="inline-flex items-center gap-2">
      {hasNewCommits && <Badge tone="primary" icon={<Icon name="GitCommit" aria-hidden />} title="New commits on this PR since the guide was built.">New commits on this PR</Badge>}
      <Button variant={hasNewCommits ? "soft" : "ghost"} size="sm" className={cn("h-7 gap-1.5 px-2", !hasNewCommits && "text-muted-foreground")} disabled={busy} onClick={reReview}>
        <Icon name="ArrowReloadHorizontal" className={cn("size-3.5", busy && "animate-spin motion-reduce:animate-none")} aria-hidden />
        {busy ? "Re-reviewing…" : "Re-review"}
      </Button>
    </span>
  );
});
RereviewBanner.displayName = "RereviewBanner";
