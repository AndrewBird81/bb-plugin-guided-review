import { memo, useState, type ReactNode } from "react";
import { Markdown, UrlLink } from "@get-bb/plugin-sdk/app";
import { reviewState } from "../lib/review-state";
import { computeTurn, type ReviewRound, type Turn } from "../lib/turn";
import { cn } from "../lib/utils";
import { Icon } from "./ui/icon";
import { Badge } from "./ui/badge";
import { Avatar } from "./ui/avatar";
import { StatusBadge, kindLook } from "./ReviewStatus";
import { IconTile } from "./ui/icon-tile";
import { InlineCode } from "./ui/inline-code";
import { Button } from "./ui/button";
import { timeAgo } from "./time-ago";

type ChecksSummary = { bucket: string; checks: any[] } | null | undefined;

/** CI status as a pill: green passing, red failing, amber pending. Hovering lists the checks. */
function CiBadge({ checks }: { checks: ChecksSummary }) {
  if (!checks || checks.bucket === "none") return null;
  const title = checks.checks.map((c: any) => `${c.name}: ${c.bucket}`).join("\n");
  if (checks.bucket === "fail") {
    const n = checks.checks.filter((c: any) => c.bucket === "fail").length;
    return <Badge tone="danger" title={title} icon={<Icon name="X" aria-hidden />}>{n} failing</Badge>;
  }
  if (checks.bucket === "pending") {
    const n = checks.checks.filter((c: any) => c.bucket === "pending").length;
    return <Badge tone="warning" title={title} dot pulse>{n} pending</Badge>;
  }
  return <Badge tone="success" title={title} icon={<Icon name="Check" aria-hidden />}>Checks passing</Badge>;
}

/** A branch name, GitHub-style. */
export function BranchChip({ children, className }: { children: ReactNode; className?: string }) {
  return <span className={cn("max-w-56 truncate rounded-md bg-primary/10 px-1.5 py-0.5 font-mono text-[11px] leading-4 text-primary", className)}>{children}</span>;
}

/** Review title that opens its GitHub PR when one is known; place in a flex container. */
export function ReviewTitleLink({ url, children }: { url?: string; children: ReactNode }) {
  if (!url) return <span className="truncate">{children}</span>;
  return (
    <UrlLink href={url} title="Open on GitHub" className="group flex min-w-0 items-center gap-1.5 rounded-sm">
      <span className="truncate decoration-primary/50 underline-offset-4 group-hover:underline">{children}</span>
      <Icon name="ArrowUpRight" className="size-[1em] shrink-0 text-muted-foreground transition-colors group-hover:text-primary" aria-hidden />
    </UrlLink>
  );
}

const INTENT_TOGGLE_THRESHOLD = 160;

const ROUND_LABEL: Record<ReviewRound["state"], string> = { APPROVED: "Approved", CHANGES_REQUESTED: "Changes requested", COMMENTED: "Commented", DISMISSED: "Dismissed" };

/** Your latest reviews on the PR, oldest first: "Changes requested 3d ago → Commented 1d ago". */
function RoundTimeline({ rounds }: { rounds: ReviewRound[] }) {
  return (
    <ol aria-label="Your reviews" className="inline-flex flex-wrap items-center gap-x-1.5 gap-y-1">
      {rounds.slice(-4).map((round, index) => (
        <li key={`${round.at}:${index}`} className="inline-flex items-center gap-1.5">
          {index > 0 && <span aria-hidden className="text-subtle-foreground">→</span>}
          <span><span className="text-foreground/90">{ROUND_LABEL[round.state]}</span>{timeAgo(round.at) ? ` ${timeAgo(round.at)}` : ""}</span>
        </li>
      ))}
    </ol>
  );
}

export const ReviewHeader = memo(function ReviewHeader({
  review,
  checks,
  intent,
  trailing,
  onShowFeedback,
  onSnooze,
  snoozing = false,
}: {
  review: any;
  checks?: ChecksSummary;
  intent?: string;
  /** Actions at the end of the title row, such as Re-review. */
  trailing?: ReactNode;
  /** The progress pill opens the Feedback view. */
  onShowFeedback?: () => void;
  /** "Not yet" (true) or "Back to Needs review" (false). */
  onSnooze?: (snoozed: boolean) => void;
  snoozing?: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  if (!review) return null;
  const showIntentToggle = !!intent && intent.length > INTENT_TOGGLE_THRESHOLD;
  const kind = kindLook(review);
  const state = reviewState(review);
  const turn: Turn = review.turn ?? computeTurn(review);
  const reviewed = !!(review.submittedVerdict || review.submittedAt || review.signals?.lastReviewAt);
  const rounds: ReviewRound[] = review.signals?.rounds ?? [];
  const progress: { done: number; total: number; source: "assistant" | "threads" } | null = review.progress ?? null;

  return (
    <header className="flex items-start gap-3">
      <IconTile tone={kind.tone} icon={kind.icon} className="mt-0.5 hidden size-9 @min-[640px]/review:flex" />
      <div className="min-w-0 flex-1 space-y-2">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
          <h2 className="flex min-w-0 flex-1 basis-80 text-base font-semibold leading-snug text-foreground @min-[640px]/review:text-lg">
            <ReviewTitleLink url={review.url}><InlineCode text={review.title ?? review.gitRef ?? review.targetKey} /></ReviewTitleLink>
          </h2>
          <div className="flex shrink-0 flex-wrap items-center gap-2">
            <CiBadge checks={checks} />
            {state.label !== "Ready" && <StatusBadge review={review} />}
            {turn.blocking && <Badge tone="warning" icon={<Icon name="Lock" aria-hidden />} title="Everyone else approved; only your changes requested is left.">Blocks merge</Badge>}
            {progress && progress.total > 0 && (
              <button type="button" onClick={onShowFeedback} title="Show your feedback" className="rounded-full focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring">
                <Badge tone={progress.done === progress.total ? "success" : "primary"} className="cursor-pointer tabular-nums" icon={progress.source === "assistant" ? <Icon name="Sparkles" aria-hidden /> : <Icon name="MessageSquare" aria-hidden />}>
                  {progress.done}/{progress.total} {progress.source === "assistant" ? "addressed" : "resolved"}
                </Badge>
              </button>
            )}
            {onSnooze && turn.reason === "snoozed" ? (
              <Button variant="ghost" size="sm" className="h-7 px-2 text-muted-foreground" disabled={snoozing} onClick={() => onSnooze(false)}>Back to Needs review</Button>
            ) : onSnooze && turn.group === "needs" && reviewed && (
              <Button variant="ghost" size="sm" className="h-7 px-2 text-muted-foreground" disabled={snoozing} onClick={() => onSnooze(true)}>
                <Icon name="Clock" className="size-3.5" aria-hidden />Not yet
              </Button>
            )}
            {trailing}
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1 text-xs text-muted-foreground">
          {review.author && <span className="inline-flex items-center gap-1.5"><Avatar login={review.author} size={18} /><span className="text-foreground/90">@{review.author}</span></span>}
          {review.repo && <span className="font-mono text-[11px]">{review.repo}{review.number ? <span className="text-subtle-foreground"> #{review.number}</span> : null}</span>}
          {review.base && review.head
            ? <span className="inline-flex min-w-0 items-center gap-1"><BranchChip>{review.base}</BranchChip><Icon name="ArrowRight" className="size-3 shrink-0 rotate-180 text-subtle-foreground" aria-hidden /><BranchChip>{review.head}</BranchChip></span>
            : review.gitRef && <BranchChip>{review.gitRef}</BranchChip>}
          {rounds.length > 0 && <RoundTimeline rounds={rounds} />}
        </div>
        {intent && (
          <div className="max-w-[80ch] border-l-2 border-primary/40 pl-3">
            <div className={cn("relative text-foreground/90", !expanded && showIntentToggle && "max-h-[3.4rem] overflow-hidden [mask-image:linear-gradient(to_bottom,black_2.85rem,transparent)]")}>
              <Markdown content={intent} className="text-sm leading-relaxed" />
            </div>
            {showIntentToggle && (
              <button
                type="button"
                className="mt-0.5 inline-flex items-center gap-0.5 rounded-sm text-xs text-muted-foreground hover:text-foreground"
                aria-expanded={expanded}
                onClick={() => setExpanded((e) => !e)}
              >
                {expanded ? "less" : "more"}
                <Icon name={expanded ? "ChevronUp" : "ChevronDown"} className="size-3" aria-hidden />
              </button>
            )}
          </div>
        )}
      </div>
    </header>
  );
});
ReviewHeader.displayName = "ReviewHeader";
