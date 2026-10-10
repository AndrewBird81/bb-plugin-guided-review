import { reviewState, type ReviewItem } from "../lib/review-state";
import { cn } from "../lib/utils";
import { Badge, type Tone } from "./ui/badge";
import { Icon, type IconName } from "./ui/icon";

/** How a review's status reads: GitHub's verdict colors, amber for work in progress, chosen by whose turn it is and why. */
export function statusLook(review: ReviewItem): { label: string; tone: Tone; icon?: IconName; busy?: boolean } {
  const { label, reason } = reviewState(review);
  if (label === "Generating") return { label, tone: "warning", icon: "Loading", busy: true };
  switch (reason) {
    case "failed": return { label, tone: "danger", icon: "AlertTriangle" };
    case "merged": return { label, tone: "merged", icon: "GitMerge" };
    case "closed": return { label, tone: "danger", icon: "GitPullRequestClosed" };
    case "archived": return { label, tone: "neutral", icon: "Archive" };
    case "re-requested": return { label, tone: "primary", icon: "Repeat" };
    case "team-requested": return { label, tone: "neutral" };
    case "question": return { label, tone: "warning", icon: "MessageQuestion" };
    case "mentioned": return { label, tone: "primary", icon: "MessageSquare" };
    case "handled": return { label, tone: "success", icon: "CircleCheck" };
    case "looks-ready": return { label, tone: "agent", icon: "Sparkles" };
    case "dismissed": return { label, tone: "warning", icon: "AlertCircle" };
    case "waiting": return label === "Changes requested" ? { label, tone: "warning", icon: "FileDiff" } : { label, tone: "neutral", icon: "MessageSquare" };
    case "snoozed": return { label, tone: "neutral", icon: "Clock" };
    case "draft": return { label, tone: "neutral", icon: "GitPullRequestDraft" };
    case "approved": return { label, tone: "success", icon: "Check" };
    case "commented": return { label, tone: "neutral", icon: "MessageSquare" };
    default: return { label, tone: "primary" };
  }
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
