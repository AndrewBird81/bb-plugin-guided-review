// Whose turn a review is: the reviewer's (Needs review), the author's (Waiting
// on author), nobody's (Reviewed), or done (Archive). Pure, so the server and
// the panel agree; the server attaches its result to every review it returns.
import type { Verdict } from "../src/draft";

export type TurnGroup = "needs" | "waiting" | "reviewed" | "archive";

export type TurnReason =
  | "merged" | "closed" | "archived"
  | "failed"
  | "new" | "requested" | "team-requested" | "re-requested"
  | "question" | "mentioned" | "handled" | "looks-ready" | "dismissed"
  | "waiting" | "draft" | "snoozed"
  | "approved" | "commented";

/** Your review threads on the PR, by where each stands. */
export interface ThreadTally {
  total: number;
  /** Resolved on GitHub. */
  resolved: number;
  /** The author answered after your last comment, and it isn't a question. */
  answered: number;
  /** The author asked you something after your last comment. */
  questions: number;
  /** No response since your last comment. */
  open: number;
  /** The code under the comment changed. Overlaps the others. */
  outdated: number;
}

export interface ReviewRound {
  state: "APPROVED" | "CHANGES_REQUESTED" | "COMMENTED" | "DISMISSED";
  at: number;
  sha: string | null;
}

/** What GitHub says about the PR, as the turn rules need it. Times are epoch ms. */
export interface TurnSignals {
  /** Your latest real review (reply-only reviews don't count), and the commit it reviewed. */
  lastReviewAt?: number | null;
  lastReviewSha?: string | null;
  /** Your real reviews, oldest first. */
  rounds?: ReviewRound[];
  /** The latest review request for you or a team you're on, who made it, and how. */
  requestedAt?: number | null;
  requestedBy?: string | null;
  requestedVia?: "user" | "team" | null;
  /** A request for you or your team is pending on GitHub now. */
  requestPending?: boolean;
  isDraft?: boolean;
  /** When bb first saw the current head commit. */
  headSeenAt?: number | null;
  ci?: "pass" | "fail" | "pending" | "none";
  threads?: ThreadTally | null;
  /** The latest author reply on one of your threads that asks you something. */
  questionAt?: number | null;
  /** The latest author reply on one of your threads. */
  replyAt?: number | null;
  /** When the last of your threads became resolved or answered; null while any is waiting on the author. */
  handledAt?: number | null;
  /** The latest comment on the PR, by someone else, that mentions you. */
  mentionAt?: number | null;
  mentionBy?: string | null;
  /** Your changes-requested is what's left: everyone else who reviewed approved. */
  blocking?: boolean;
  /** Commits on the PR since your last review, when known. */
  commitsSince?: number | null;
  /** The PR's author. */
  author?: string | null;
}

/** The review assistant's latest check of your feedback, for one head commit. */
export interface AssessmentSummary {
  headSha: string;
  total: number;
  addressed: number;
  partial: number;
  notAddressed: number;
  disputed: number;
  unclear: number;
  assessedAt: number;
}

/** The review fields the rules read. */
export interface TurnInput {
  targetKey?: string;
  kind?: "pr" | "ref";
  status?: "generating" | "ready" | "error" | "tracked";
  createdAt?: number;
  prState?: "OPEN" | "CLOSED" | "MERGED";
  archivedAt?: number | null;
  userArchivedAt?: number | null;
  submittedVerdict?: Verdict | null;
  submittedAt?: number | null;
  submittedHeadSha?: string | null;
  latestHeadSha?: string;
  headSha?: string;
  signals?: TurnSignals | null;
  snoozedAt?: number | null;
  assessment?: AssessmentSummary | null;
}

export interface TurnOptions {
  /** Which author replies on your threads make it your turn. */
  wakeOnReplies: "questions" | "any";
  /** "ready": the assistant judging every item addressed makes it your turn. */
  pushChecks: "off" | "progress" | "ready";
  /** How long the author must be quiet before "Feedback handled" counts. */
  quietMs?: number;
}

export interface Turn {
  group: TurnGroup;
  reason: TurnReason;
  /** The status badge. */
  label: string;
  /** What opening the review does, for the list row. */
  action: string;
  /** Identifies the event that made it your turn; a new one alerts again. Null when it isn't your turn. */
  signal: string | null;
  /** When the current state began, for "your turn for 2d". */
  at: number | null;
  /** Whether becoming your turn this way deserves a Needs You alert. */
  notify: boolean;
  /** Everyone else approved; only your changes-requested is left. */
  blocking: boolean;
  /** The head moved since your last review. */
  updated: boolean;
}

export const QUIET_MS = 10 * 60_000;
export const defaultTurnOptions: TurnOptions = { wakeOnReplies: "questions", pushChecks: "off" };

const VERDICT_LABEL: Record<Verdict, string> = { APPROVE: "Approved", REQUEST_CHANGES: "Changes requested", COMMENT: "Commented" };

/** Whether `t` is a time later than every floor. */
function after(t: number | null | undefined, ...floors: Array<number | null | undefined>): t is number {
  return typeof t === "number" && floors.every((floor) => t > (floor ?? 0));
}

export function computeTurn(review: TurnInput, options: TurnOptions = defaultTurnOptions, now = Date.now()): Turn {
  const s = review.signals ?? {};
  const head = review.latestHeadSha ?? review.headSha;
  const reviewedSha = s.lastReviewSha ?? review.submittedHeadSha ?? null;
  const updated = !!(head && reviewedSha && head !== reviewedSha);
  const base = { signal: null, at: null, notify: false, blocking: false, updated };
  const make = (group: TurnGroup, reason: TurnReason, label: string, action: string, extra: Partial<Turn> = {}): Turn =>
    ({ ...base, group, reason, label, action, ...extra });

  if (review.prState === "MERGED") return make("archive", "merged", "Merged", "View review");
  if (review.prState === "CLOSED" || review.archivedAt) return make("archive", "closed", "Closed", "View review");

  // A local receipt counts until GitHub reports the review.
  const lastReviewAt = Math.max(s.lastReviewAt ?? 0, review.submittedAt ?? 0) || null;
  const reviewed = lastReviewAt !== null || !!review.submittedVerdict;
  const snoozedAt = review.snoozedAt ?? null;
  const reRequested = reviewed && after(s.requestedAt, lastReviewAt);

  // A person asking you again outranks your own archive.
  if (review.userArchivedAt && !(reRequested && after(s.requestedAt, review.userArchivedAt))) {
    return make("archive", "archived", "Archived", "View review");
  }
  if (review.status === "error") return make("needs", "failed", "Failed", "Retry review");

  const turn = reviewerTurn();
  // Generation shows where the review stands; it doesn't move it.
  return review.status === "generating" ? { ...turn, label: "Generating", action: "View progress" } : turn;

  function reviewerTurn(): Turn {
    if (review.kind === "ref") return make("needs", "new", "Ready", "Open review", { at: review.createdAt ?? null });
    const tracked = review.status === "tracked";
    if (!reviewed) {
      if (tracked && s.isDraft) return make("waiting", "draft", "Draft", "Open review");
      if (s.requestPending || s.requestedAt) {
        const team = s.requestedVia === "team";
        return make("needs", team ? "team-requested" : "requested", team ? "Team review requested" : "Review requested", tracked ? "Start review" : "Open review", {
          signal: `requested:${s.requestedAt ?? "pending"}`, at: s.requestedAt ?? review.createdAt ?? null, notify: !team,
        });
      }
      return make("needs", "new", tracked ? "Tracked" : "Ready", tracked ? "Start review" : "Open review", { at: review.createdAt ?? null });
    }

    const verdict = review.submittedVerdict ?? null;
    const blocking = verdict === "REQUEST_CHANGES" && !!s.blocking;
    const needs = (reason: TurnReason, label: string, signal: string, at: number, notify: boolean) =>
      make("needs", reason, label, "Review changes", { signal, at, notify, blocking });

    if (reRequested && after(s.requestedAt, snoozedAt)) {
      return needs("re-requested", "Re-requested", `re-requested:${s.requestedAt}`, s.requestedAt, true);
    }
    // GitHub dismissed your review, for example a stale approval.
    if (!verdict) {
      if (after(lastReviewAt, snoozedAt)) return needs("dismissed", "Review dismissed", `dismissed:${lastReviewAt}`, lastReviewAt!, false);
      return make("waiting", "snoozed", "Not yet", "View review", { at: snoozedAt });
    }
    if (s.isDraft) return make(verdict === "APPROVE" ? "reviewed" : "waiting", "draft", "Draft", "View review", { updated });
    if (verdict === "APPROVE") return make("reviewed", "approved", updated ? "Approved · updated" : "Approved", "View review");

    const threads = s.threads;
    const hasThreads = !!threads && threads.total > 0;
    if (verdict === "COMMENT" && !hasThreads) return make("reviewed", "commented", "Commented", "View review");

    // The author answered: a question for you, or any reply if you asked for that.
    const replyAt = options.wakeOnReplies === "any" ? Math.max(s.replyAt ?? 0, s.questionAt ?? 0) || null : s.questionAt;
    if (after(replyAt, lastReviewAt, snoozedAt)) {
      const question = replyAt === s.questionAt;
      return needs("question", question ? "Question for you" : "Author replied", `reply:${replyAt}`, replyAt, true);
    }
    if (after(s.mentionAt, lastReviewAt, snoozedAt)) {
      return needs("mentioned", "Mentioned you", `mention:${s.mentionAt}`, s.mentionAt, true);
    }
    // Every thread resolved or answered, new commits, CI settled, and the author quiet for a while.
    const quietAt = Math.max(s.headSeenAt ?? 0, s.handledAt ?? 0) + (options.quietMs ?? QUIET_MS);
    if (hasThreads && updated && s.ci !== "fail" && s.ci !== "pending" && now >= quietAt && after(s.handledAt, lastReviewAt, snoozedAt)) {
      return needs("handled", "Feedback handled", `handled:${head}`, quietAt, true);
    }
    const assessment = review.assessment;
    if (options.pushChecks === "ready" && assessment && assessment.headSha === head && updated && assessment.total > 0
      && assessment.addressed === assessment.total && after(assessment.assessedAt, lastReviewAt, snoozedAt)) {
      return needs("looks-ready", "Looks ready", `looks-ready:${head}`, assessment.assessedAt, true);
    }
    if (snoozedAt && snoozedAt >= (lastReviewAt ?? 0)) return make("waiting", "snoozed", "Not yet", "View review", { at: snoozedAt, blocking });
    return make("waiting", "waiting", VERDICT_LABEL[verdict], "View review", { at: lastReviewAt, blocking });
  }
}

/** Progress on your feedback for a list row, such as "2/5 addressed". Null when there's nothing to count. */
export function feedbackProgress(review: TurnInput): { done: number; total: number; source: "assistant" | "threads" } | null {
  const head = review.latestHeadSha ?? review.headSha;
  const a = review.assessment;
  if (a && a.total > 0 && a.headSha === head) return { done: a.addressed, total: a.total, source: "assistant" };
  const t = review.signals?.threads;
  if (t && t.total > 0) return { done: t.resolved + t.answered, total: t.total, source: "threads" };
  return null;
}
