import { reviewState, type ReviewItem } from "../lib/review-state";
import { cn } from "../lib/utils";
import { Badge, type Tone } from "./ui/badge";
import { Icon, type IconName } from "./ui/icon";

/** How a review's status reads: GitHub's verdict colors, amber for work in progress. */
export function statusLook(review: ReviewItem): { label: string; tone: Tone; icon?: IconName; busy?: boolean } {
  const { label } = reviewState(review);
  if (label === "Generating") return { label, tone: "warning", icon: "Loading", busy: true };
  if (label === "Failed") return { label, tone: "danger", icon: "AlertTriangle" };
  if (label === "Merged") return { label, tone: "merged", icon: "GitMerge" };
  if (label === "Closed") return { label, tone: "danger", icon: "GitPullRequestClosed" };
  if (label === "Archived") return { label, tone: "neutral", icon: "Archive" };
  if (label.endsWith("new commits")) return { label, tone: "primary", icon: "GitCommit" };
  if (label === "Approved") return { label, tone: "success", icon: "Check" };
  if (label === "Changes requested") return { label, tone: "warning", icon: "FileDiff" };
  if (label === "Commented") return { label, tone: "neutral", icon: "MessageSquare" };
  return { label, tone: "primary" };
}

/** The pull request (or local change) itself, colored like GitHub: open, merged, closed. */
export function kindLook(review: ReviewItem): { tone: Tone; icon: IconName } {
  if (review.prState === "MERGED") return { tone: "merged", icon: "GitMerge" };
  if (review.prState === "CLOSED" || review.archivedAt) return { tone: "danger", icon: "GitPullRequestClosed" };
  if (review.kind === "ref" || (review.kind !== "pr" && review.number == null)) return { tone: "primary", icon: "GitBranch" };
  if (review.userArchivedAt) return { tone: "neutral", icon: "GitPullRequest" };
  return { tone: "success", icon: "GitPullRequest" };
}

export function StatusBadge({ review, className }: { review: ReviewItem; className?: string }) {
  const look = statusLook(review);
  return (
    <Badge tone={look.tone} className={className} dot={!look.icon} icon={look.icon && <Icon name={look.icon} className={cn(look.busy && "animate-spin motion-reduce:animate-none")} aria-hidden />}>
      {look.label}
    </Badge>
  );
}
