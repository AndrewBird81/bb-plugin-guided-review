import type { Verdict } from "./draft";

/** One of the viewer's reviews as GitHub reports it. */
export interface ReviewNode {
  state: string;
  submittedAt: string | null;
  body?: string | null;
  commit?: { oid: string } | null;
  comments?: { totalCount: number; nodes: Array<{ replyTo: { id: string } | null }> } | null;
}

/**
 * A review that says something new: not pending, and not one GitHub made for
 * replies to existing threads (a blank COMMENTED review whose comments are replies).
 */
export function isRealReview(review: ReviewNode): boolean {
  if (review.state === "PENDING" || !review.submittedAt) return false;
  if (review.state !== "COMMENTED" || review.body?.trim()) return true;
  const comments = review.comments;
  if (!comments) return true;
  return comments.totalCount > 0 && comments.nodes.some((comment) => !comment.replyTo);
}

export interface Verdicted {
  /** null when GitHub dismissed your latest approve or changes-requested review. */
  verdict: Verdict | null;
  /** Your latest real review, and the commit it reviewed. */
  at: number;
  sha: string | null;
}

/**
 * Your standing verdict, as GitHub's reviewDecision counts it: your latest
 * approve or changes-requested review outlives later comments. Null without a real review.
 */
export function verdictOf(reviews: ReviewNode[]): Verdicted | null {
  const real = reviews.filter(isRealReview).sort((a, b) => Date.parse(a.submittedAt!) - Date.parse(b.submittedAt!));
  const latest = real.at(-1);
  if (!latest) return null;
  const opinion = real.filter((r) => r.state === "APPROVED" || r.state === "CHANGES_REQUESTED" || r.state === "DISMISSED").at(-1);
  // A comment after a dismissal is where you stand now.
  const state = !opinion || (opinion.state === "DISMISSED" && opinion !== latest) ? latest.state : opinion.state;
  const verdict: Verdict | null = state === "APPROVED" ? "APPROVE" : state === "CHANGES_REQUESTED" ? "REQUEST_CHANGES" : state === "COMMENTED" ? "COMMENT" : null;
  return { verdict, at: Date.parse(latest.submittedAt!), sha: latest.commit?.oid ?? null };
}
