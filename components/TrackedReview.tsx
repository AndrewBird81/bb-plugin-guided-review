import { memo, useState } from "react";
import { UrlLink, useRpc } from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import type { rpcContract } from "../src/rpc-contract";
import { computeTurn, type Turn, type TurnInput } from "../lib/turn";
import { Button } from "./ui/button";
import { Badge } from "./ui/badge";
import { Avatar } from "./ui/avatar";
import { Icon } from "./ui/icon";
import { IconTile } from "./ui/icon-tile";
import { InlineCode } from "./ui/inline-code";
import { kindLook } from "./ReviewStatus";

/** A PR found on GitHub with no guide yet: why it's here, and Start review. */
export const TrackedReview = memo(function TrackedReview({ review, onBack }: {
  review: TurnInput & { targetKey: string; title?: string; repo?: string; number?: number; author?: string; url?: string; turn?: Turn };
  onBack: () => void;
}) {
  const rpc = useRpc<typeof rpcContract>();
  const [starting, setStarting] = useState(false);
  const turn = review.turn ?? computeTurn(review);
  const requestedBy = review.signals?.requestedBy;
  const kind = kindLook(review);

  async function start() {
    setStarting(true);
    try {
      const result = await rpc.call("startTrackedReview", { targetKey: review.targetKey });
      // On success the review's realtime update shows the guide being built.
      if (!result.ok) toast.error(result.error ?? "Couldn’t start the review.");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Couldn’t start the review.");
    } finally {
      setStarting(false);
    }
  }

  return (
    <div className="flex h-full flex-col bg-background">
      <div className="border-b border-border px-2 py-1">
        <Button variant="ghost" size="sm" className="gap-1.5 px-2 text-muted-foreground" onClick={onBack}><Icon name="ChevronLeft" className="size-4" aria-hidden /> All reviews</Button>
      </div>
      <section aria-label="Tracked pull request" className="mx-auto flex w-full max-w-xl flex-1 flex-col items-center justify-center gap-4 p-6 text-center">
        <IconTile tone={kind.tone} icon={kind.icon} className="size-12 rounded-2xl" iconClassName="size-6" />
        <div className="space-y-2">
          <h2 className="text-base font-semibold text-foreground"><InlineCode text={review.title ?? review.targetKey} /></h2>
          <p className="flex flex-wrap items-center justify-center gap-x-2.5 gap-y-1 text-xs text-muted-foreground">
            {review.repo && <span className="font-mono text-[11px]">{review.repo}{review.number ? <span className="text-subtle-foreground"> #{review.number}</span> : null}</span>}
            {review.author && <span className="inline-flex items-center gap-1.5"><Avatar login={review.author} size={18} /><span className="text-foreground/90">@{review.author}</span></span>}
          </p>
          <p className="flex flex-wrap items-center justify-center gap-2 text-xs text-muted-foreground">
            <Badge tone={turn.group === "needs" ? "primary" : "neutral"}>{turn.label}</Badge>
            {requestedBy && <span>Requested by @{requestedBy}</span>}
          </p>
        </div>
        <p className="text-sm text-muted-foreground">No guide yet. Starting the review builds one.</p>
        <div className="flex flex-wrap justify-center gap-2">
          <Button disabled={starting} onClick={() => void start()}>
            {starting ? <Icon name="Loading" className="animate-spin motion-reduce:animate-none" aria-hidden /> : <Icon name="Play" aria-hidden />}
            {starting ? "Starting…" : "Start review"}
          </Button>
          {review.url && <Button asChild variant="outline"><UrlLink href={review.url}><Icon name="Github" aria-hidden />Open on GitHub</UrlLink></Button>}
        </div>
      </section>
    </div>
  );
});
TrackedReview.displayName = "TrackedReview";
