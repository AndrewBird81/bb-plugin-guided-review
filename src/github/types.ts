// What the sync reads from GitHub, normalized. Times are epoch milliseconds.
import type { runGh } from "../gh";

export type RunGh = typeof runGh;

/** A tracked PR to read. */
export interface PrRef { targetKey: string; repo: string; number: number }

export type ReviewState = "APPROVED" | "CHANGES_REQUESTED" | "COMMENTED" | "DISMISSED";

/** One of the viewer's real reviews: not pending, and not made only of replies to existing threads. */
export interface MyReview {
  id: string;
  state: ReviewState;
  submittedAt: number;
  /** The commit the review was made on. */
  sha: string | null;
  body: string;
}

/** A request for the viewer's review, directly or through a team the viewer is on. */
export interface ReviewRequestEvent {
  at: number;
  /** Who requested it. */
  by: string | null;
  via: "user" | "team";
  /** "org/slug" for a team request. */
  team?: string;
}

export interface PrFacts {
  targetKey: string;
  repo: string;
  number: number;
  state: "OPEN" | "CLOSED" | "MERGED";
  isDraft: boolean;
  title: string;
  url: string;
  author: string | null;
  baseRefName: string;
  headRefName: string;
  headSha: string;
  updatedAt: number;
  /** The head commit's combined status checks. */
  ci: "pass" | "fail" | "pending" | "none";
  reviewDecision: "APPROVED" | "CHANGES_REQUESTED" | "REVIEW_REQUIRED" | null;
  /** The viewer's real reviews, oldest first. */
  myReviews: MyReview[];
  /** Every other reviewer's latest approve or changes-requested review. */
  otherOpinions: Array<{ login: string; state: "APPROVED" | "CHANGES_REQUESTED" }>;
  /** Review requests for the viewer from the timeline, oldest first. */
  requests: ReviewRequestEvent[];
  /** The latest removal of a review request for the viewer, or a team the viewer is on. */
  requestRemovedAt: number | null;
  /** A request for the viewer, or a team the viewer is on, is pending now. */
  requestPending: { via: "user" | "team"; team?: string } | null;
  readyAt: number | null;
  draftAt: number | null;
  /** The latest dismissal of one of the viewer's reviews. */
  dismissedAt: number | null;
  forcePushedAt: number | null;
  /** The latest comment on the PR conversation, by someone else and not a bot, that mentions the viewer. */
  mention: { at: number; by: string } | null;
  /** Commit oids on the PR, oldest first (the last 100). */
  commits: string[];
}

/** One review thread the viewer started, with where it stands. */
export interface FeedbackThread {
  /** GraphQL node id, used to resolve the thread. */
  id: string;
  /** The first comment's database id, used to reply over REST. */
  commentId: number;
  reviewId: string | null;
  path: string | null;
  line: number | null;
  originalLine: number | null;
  startLine: number | null;
  side: "LEFT" | "RIGHT" | null;
  subjectType: "LINE" | "FILE";
  /** The viewer's first comment. */
  body: string;
  createdAt: number;
  isResolved: boolean;
  resolvedBy: string | null;
  isOutdated: boolean;
  /** The latest replies after the first comment, oldest first. */
  replies: Array<{ author: string; bot: boolean; mine: boolean; body: string; createdAt: number }>;
  /**
   * resolved: resolved on GitHub. question: the latest reply from someone else, after the
   * viewer's last comment, asks something or mentions the viewer. answered: such a reply
   * that isn't a question. open: no reply from anyone else since the viewer's last comment.
   */
  status: "resolved" | "question" | "answered" | "open";
  /** That latest reply from someone else after the viewer's last comment. */
  replyAt: number | null;
}

/** A PR the viewer was asked to review or has reviewed, from search. */
export interface DiscoveredPr {
  repo: string;
  number: number;
  title: string;
  url: string;
  author: string | null;
  updatedAt: number;
  isDraft: boolean;
  /** The viewer's review is requested, directly or through a team. */
  requested: boolean;
  /** The viewer has reviewed it. */
  reviewed: boolean;
}
