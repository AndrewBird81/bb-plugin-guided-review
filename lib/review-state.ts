import type { ReviewMeta } from "../src/store";
export type ReviewItem = Pick<ReviewMeta, "targetKey"> & Partial<ReviewMeta>;
export function reviewState(review: ReviewItem) {
  if (review.prState === "MERGED") return { label: "Merged", action: "View review", group: "archive" as const };
  if (review.prState === "CLOSED" || review.archivedAt) return { label: "Closed", action: "View review", group: "archive" as const };
  if (review.userArchivedAt) return { label: "Archived", action: "View review", group: "archive" as const };
  if (review.status === "generating") return { label: "Generating", action: "View progress", group: "active" as const };
  if (review.status === "error") return { label: "Failed", action: "Retry review", group: "active" as const };
  if (review.submittedVerdict) {
    if (review.submittedHeadSha && (review.latestHeadSha ?? review.headSha) && review.submittedHeadSha !== (review.latestHeadSha ?? review.headSha)) {
      return { label: `${review.submittedVerdict === "APPROVE" ? "Approved" : review.submittedVerdict === "REQUEST_CHANGES" ? "Changes requested" : "Commented"} · new commits`, action: "Review changes", group: "active" as const };
    }
    return { label: review.submittedVerdict === "APPROVE" ? "Approved" : review.submittedVerdict === "REQUEST_CHANGES" ? "Changes requested" : "Commented", action: "View review", group: "reviewed" as const };
  }
  return { label: "Ready", action: "Open review", group: "active" as const };
}
