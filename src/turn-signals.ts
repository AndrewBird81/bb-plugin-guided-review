// Turns what GitHub says about a PR into the signals the turn rules read.
import type { ReviewLifecycle, ReviewMeta } from "./store";
import type { FeedbackThread, PrFacts } from "./github/types";
import type { ReviewPreferences } from "./preferences";
import { feedbackProgress, type Turn, type TurnOptions, type TurnSignals } from "../lib/turn";
import { verdictFromMine } from "./review-verdict";

export function turnOptions(preferences: ReviewPreferences): TurnOptions {
  return { wakeOnReplies: preferences.wakeOnReplies, pushChecks: preferences.pushChecks };
}

/**
 * The review's state after a read of its PR. `startedAt` is when the read began:
 * a review submitted here after that is newer than GitHub's answer and stands.
 */
export function factsUpdate(previous: ReviewMeta, facts: PrFacts, viewer: string, startedAt: number, now: number): ReviewLifecycle {
  const s = previous.signals ?? {};
  const update: ReviewLifecycle = {
    prState: facts.state, latestHeadSha: facts.headSha,
    archivedAt: facts.state === "OPEN" ? null : previous.archivedAt ?? now,
  };
  const own = verdictFromMine(facts.myReviews);
  if ((previous.submittedAt ?? 0) < startedAt) {
    // GitHub can lag immediately after a write. Never replace a newer local receipt with an older response.
    const remoteAt = own?.at ?? 0;
    if (own && (remoteAt >= (previous.submittedAt ?? 0) - 1000 || own.verdict === null) || previous.reviewer && previous.reviewer !== viewer) {
      Object.assign(update, { submittedVerdict: own?.verdict ?? null, submittedAt: remoteAt || null, submittedHeadSha: own?.sha ?? null, reviewer: viewer });
    }
  }
  const verdict = "submittedVerdict" in update ? update.submittedVerdict : previous.submittedVerdict;
  const request = facts.requests.at(-1);
  const others = facts.otherOpinions;
  const reviewedAt = own?.sha ? facts.commits.lastIndexOf(own.sha) : -1;
  update.signals = {
    ...s,
    lastReviewAt: own?.at ?? null,
    lastReviewSha: own?.sha ?? null,
    rounds: facts.myReviews.slice(-10).map((r) => ({ state: r.state, at: r.submittedAt, sha: r.sha })),
    requestedAt: request?.at ?? null,
    requestedBy: request?.by ?? null,
    requestedVia: request?.via ?? facts.requestPending?.via ?? null,
    requestPending: !!facts.requestPending,
    isDraft: facts.isDraft,
    headSeenAt: facts.headSha !== previous.latestHeadSha ? now : s.headSeenAt ?? now,
    ci: facts.ci,
    mentionAt: facts.mention?.at ?? null,
    mentionBy: facts.mention?.by ?? null,
    blocking: verdict === "REQUEST_CHANGES" && others.length > 0 && others.every((o) => o.state === "APPROVED"),
    commitsSince: reviewedAt >= 0 ? facts.commits.length - 1 - reviewedAt : null,
    author: facts.author,
  };
  return update;
}

/** Your threads' standing, as signals. */
export function threadSignals(threads: ReadonlyArray<FeedbackThread & { resolvedSeenAt?: number | null }>): Pick<TurnSignals, "threads" | "questionAt" | "replyAt" | "handledAt"> {
  const count = (status: FeedbackThread["status"]) => threads.filter((t) => t.status === status).length;
  const tally = {
    total: threads.length, resolved: count("resolved"), answered: count("answered"), questions: count("question"),
    open: count("open"), outdated: threads.filter((t) => t.isOutdated).length,
  };
  const latest = (times: Array<number | null | undefined>) => times.reduce<number | null>((max, t) => t != null && t > (max ?? 0) ? t : max, null);
  const handled = tally.total > 0 && tally.open === 0 && tally.questions === 0;
  return {
    threads: tally.total ? tally : null,
    questionAt: latest(threads.filter((t) => t.status === "question").map((t) => t.replyAt)),
    replyAt: latest(threads.filter((t) => t.status === "question" || t.status === "answered").map((t) => t.replyAt)),
    handledAt: handled ? latest(threads.map((t) => t.status === "resolved" ? t.resolvedSeenAt ?? null : t.replyAt)) : null,
  };
}

/** The Needs You alert's text: why it's your turn, then progress, CI, and commits. */
export function alertBody(review: ReviewMeta, turn: Turn): string {
  const s = review.signals ?? {};
  const author = s.author ? `@${s.author}` : "The author";
  const why: Partial<Record<Turn["reason"], string>> = {
    "re-requested": `${s.requestedBy ? `@${s.requestedBy}` : author} re-requested your review`,
    requested: `${s.requestedBy ? `@${s.requestedBy}` : author} requested your review`,
    question: `${author} asked you something on your feedback`,
    mentioned: `${s.mentionBy ? `@${s.mentionBy}` : author} mentioned you`,
    handled: "Every thread of your feedback is resolved or answered",
    "looks-ready": "The assistant found all your feedback addressed",
  };
  if (turn.reason === "question" && turn.label === "Author replied") why.question = `${author} replied to your feedback`;
  const progress = feedbackProgress(review);
  const parts = [
    why[turn.reason] ?? "It’s your turn to review",
    progress && `${progress.done}/${progress.total} ${progress.source === "assistant" ? "addressed" : "resolved or answered"}`,
    s.ci === "pass" ? "CI passing" : s.ci === "fail" ? "CI failing" : s.ci === "pending" ? "CI running" : null,
    s.commitsSince ? `${s.commitsSince} new commit${s.commitsSince === 1 ? "" : "s"}` : null,
    turn.blocking ? "only your review blocks the merge" : null,
    review.status === "ready" && turn.reason === "requested" ? "guide ready" : null,
  ];
  return parts.filter(Boolean).join(" · ").slice(0, 600);
}
