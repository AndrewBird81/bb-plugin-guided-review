import { expect, test } from "vitest";
import { baselineOf, canSnooze, computeTurn, feedbackProgress, QUIET_MS, type TurnInput, type TurnOptions } from "../lib/turn";

const NOW = Date.parse("2026-10-10T12:00:00Z");
const hour = 3_600_000;
const t = (hoursAgo: number) => NOW - hoursAgo * hour;

/** You requested changes on sha1 five hours ago, with three threads. */
function changesRequested(extra: Partial<TurnInput> = {}, signals: TurnInput["signals"] = {}): TurnInput {
  return {
    targetKey: "pr-1", kind: "pr", status: "ready", prState: "OPEN", headSha: "sha1", latestHeadSha: "sha1",
    submittedVerdict: "REQUEST_CHANGES", submittedHeadSha: "sha1",
    ...extra,
    signals: {
      lastReviewAt: t(5), lastReviewSha: "sha1", ci: "pass",
      threads: { total: 3, resolved: 0, answered: 0, questions: 0, open: 3, outdated: 0 },
      ...signals,
    },
  };
}
const turn = (review: TurnInput, options?: Partial<TurnOptions>) =>
  computeTurn(review, { wakeOnReplies: "questions", pushChecks: "off", ...options }, NOW);

test("merged, closed, and archived reviews are in Archive", () => {
  expect(turn(changesRequested({ prState: "MERGED" }))).toMatchObject({ group: "archive", label: "Merged" });
  expect(turn(changesRequested({ prState: "CLOSED" }))).toMatchObject({ group: "archive", label: "Closed" });
  expect(turn(changesRequested({ userArchivedAt: t(1) }))).toMatchObject({ group: "archive", label: "Archived" });
});

test("a re-request after you archived a review brings it back", () => {
  const review = changesRequested({ userArchivedAt: t(2) }, { requestedAt: t(1), requestedBy: "alice" });
  expect(turn(review)).toMatchObject({ group: "needs", reason: "re-requested", notify: true });
  // An older request doesn't.
  expect(turn(changesRequested({ userArchivedAt: t(0.5) }, { requestedAt: t(1) })).group).toBe("archive");
});

test("a review you haven't submitted yet is yours", () => {
  expect(turn({ targetKey: "a", status: "ready" })).toMatchObject({ group: "needs", reason: "new", label: "Ready" });
  expect(turn({ targetKey: "a", kind: "ref", status: "ready" })).toMatchObject({ group: "needs", label: "Ready" });
});

test("a request for your review alerts you; a team request is quieter", () => {
  const requested = turn({ targetKey: "a", kind: "pr", status: "tracked", signals: { requestedAt: t(1), requestedVia: "user", requestPending: true } });
  expect(requested).toMatchObject({ group: "needs", reason: "requested", notify: true, action: "Start review", signal: `requested:${t(1)}` });
  const team = turn({ targetKey: "a", kind: "pr", status: "tracked", signals: { requestedAt: t(1), requestedVia: "team", requestPending: true } });
  expect(team).toMatchObject({ group: "needs", reason: "team-requested", notify: false });
});

test("a push alone doesn't make it your turn", () => {
  const pushed = turn(changesRequested({ latestHeadSha: "sha2" }, { headSeenAt: t(3) }));
  expect(pushed).toMatchObject({ group: "waiting", reason: "waiting", label: "Changes requested", updated: true, signal: null });
});

test("a re-request after your review makes it your turn and alerts you", () => {
  const review = changesRequested({ latestHeadSha: "sha2" }, { requestedAt: t(1), requestedBy: "alice" });
  expect(turn(review)).toMatchObject({ group: "needs", reason: "re-requested", label: "Re-requested", notify: true, signal: `re-requested:${t(1)}`, at: t(1) });
  // The original request, before your review, doesn't count.
  expect(turn(changesRequested({}, { requestedAt: t(6) })).group).toBe("waiting");
});

test("Not yet hides a review until a newer signal", () => {
  const snoozed = changesRequested({ latestHeadSha: "sha2", snoozedAt: t(0.5) }, { requestedAt: t(1) });
  expect(turn(snoozed)).toMatchObject({ group: "waiting", reason: "snoozed", label: "Not yet" });
  // A push after Not yet doesn't wake it.
  expect(turn({ ...snoozed, latestHeadSha: "sha3", signals: { ...snoozed.signals, headSeenAt: t(0.1) } }).group).toBe("waiting");
  // A new re-request does.
  expect(turn({ ...snoozed, signals: { ...snoozed.signals, requestedAt: t(0.2) } })).toMatchObject({ group: "needs", reason: "re-requested" });
});

test("a question on your thread wakes the review; other replies only if you choose", () => {
  expect(turn(changesRequested({}, { questionAt: t(1), replyAt: t(1) }))).toMatchObject({ group: "needs", reason: "question", label: "Question for you", notify: true });
  expect(turn(changesRequested({}, { replyAt: t(1) })).group).toBe("waiting");
  expect(turn(changesRequested({}, { replyAt: t(1) }), { wakeOnReplies: "any" })).toMatchObject({ group: "needs", label: "Author replied" });
  // Your newer review answers it.
  expect(turn(changesRequested({}, { questionAt: t(6) })).group).toBe("waiting");
});

test("a mention after your review wakes it", () => {
  expect(turn(changesRequested({}, { mentionAt: t(1), mentionBy: "alice" }))).toMatchObject({ group: "needs", reason: "mentioned", notify: true });
});

test("feedback handled: every thread resolved or answered, new commits, CI settled, author quiet", () => {
  const handled = { threads: { total: 3, resolved: 2, answered: 1, questions: 0, open: 0, outdated: 1 }, handledAt: t(1), headSeenAt: t(2) };
  expect(turn(changesRequested({ latestHeadSha: "sha2" }, handled))).toMatchObject({ group: "needs", reason: "handled", notify: true, signal: `handled:${t(1)}`, eventAt: t(1) });
  // Without new commits, CI still running or failing, or within the quiet period, it waits.
  expect(turn(changesRequested({}, handled)).group).toBe("waiting");
  expect(turn(changesRequested({ latestHeadSha: "sha2" }, { ...handled, ci: "pending" })).group).toBe("waiting");
  expect(turn(changesRequested({ latestHeadSha: "sha2" }, { ...handled, ci: "fail" })).group).toBe("waiting");
  expect(turn(changesRequested({ latestHeadSha: "sha2" }, { ...handled, handledAt: NOW - QUIET_MS / 2 })).group).toBe("waiting");
  // Handled before your last review doesn't count.
  expect(turn(changesRequested({ latestHeadSha: "sha2" }, { ...handled, handledAt: t(6), headSeenAt: t(7) })).group).toBe("waiting");
});

test("the assistant's all-addressed check counts only when you opt in", () => {
  const review = changesRequested({ latestHeadSha: "sha2", assessment: { headSha: "sha2", total: 4, addressed: 4, partial: 0, notAddressed: 0, disputed: 0, unclear: 0, assessedAt: t(1) } });
  expect(turn(review).group).toBe("waiting");
  expect(turn(review, { pushChecks: "progress" }).group).toBe("waiting");
  expect(turn(review, { pushChecks: "ready" })).toMatchObject({ group: "needs", reason: "looks-ready", label: "Looks ready" });
  // A check of an older head doesn't.
  expect(turn({ ...review, latestHeadSha: "sha3" }, { pushChecks: "ready" }).group).toBe("waiting");
});

test("an approval stays reviewed when new commits arrive", () => {
  expect(turn(changesRequested({ submittedVerdict: "APPROVE", latestHeadSha: "sha2" }))).toMatchObject({ group: "reviewed", label: "Approved · updated", updated: true });
});

test("a dismissed review is yours again, without an alert", () => {
  expect(turn(changesRequested({ submittedVerdict: null }))).toMatchObject({ group: "needs", reason: "dismissed", notify: false });
});

test("a comment review waits on the author only while it has threads", () => {
  expect(turn(changesRequested({ submittedVerdict: "COMMENT" }, { threads: null }))).toMatchObject({ group: "reviewed", label: "Commented" });
  expect(turn(changesRequested({ submittedVerdict: "COMMENT" }))).toMatchObject({ group: "waiting", label: "Commented" });
});

test("a draft PR waits on the author", () => {
  expect(turn(changesRequested({ latestHeadSha: "sha2" }, { isDraft: true }))).toMatchObject({ group: "waiting", reason: "draft" });
});

test("generation relabels a review without moving it", () => {
  expect(turn(changesRequested({ status: "generating" }))).toMatchObject({ group: "waiting", label: "Generating" });
  expect(turn({ targetKey: "a", status: "generating" })).toMatchObject({ group: "needs", label: "Generating" });
  // A failed guide keeps why it's your turn, so its alert isn't lost.
  expect(turn(changesRequested({ status: "error" }, { requestedAt: t(1) }))).toMatchObject({ group: "needs", reason: "re-requested", label: "Failed", failed: true, signal: `re-requested:${t(1)}` });
  expect(turn(changesRequested({ status: "error" }))).toMatchObject({ group: "needs", reason: "waiting", label: "Failed", failed: true });
});

test("a local receipt counts until GitHub reports the review", () => {
  // You submitted locally an hour ago; GitHub still reports the earlier review and a request between the two.
  const review = changesRequested({ submittedAt: t(1) }, { requestedAt: t(2) });
  expect(turn(review).group).toBe("waiting");
});

test("blocking marks a changes-requested review that holds up the merge", () => {
  expect(turn(changesRequested({}, { blocking: true })).blocking).toBe(true);
  expect(turn(changesRequested({ latestHeadSha: "sha2" }, { blocking: true, requestedAt: t(1) }))).toMatchObject({ group: "needs", blocking: true });
});

test("progress prefers the assistant's check of the current head, then your threads", () => {
  const review = changesRequested({ latestHeadSha: "sha2" }, { threads: { total: 4, resolved: 1, answered: 1, questions: 0, open: 2, outdated: 0 } });
  expect(feedbackProgress(review)).toEqual({ done: 2, total: 4, source: "threads" });
  const checked = { ...review, assessment: { headSha: "sha2", total: 5, addressed: 3, partial: 1, notAddressed: 1, disputed: 0, unclear: 0, assessedAt: t(1) } };
  expect(feedbackProgress(checked)).toEqual({ done: 3, total: 5, source: "assistant" });
  expect(feedbackProgress({ targetKey: "a" })).toBeNull();
});

test("a handled turn holds until you act, even when the author pushes again", () => {
  const held = { reason: "handled" as const, label: "Feedback handled", signal: `handled:${t(1)}`, at: t(0.5) };
  // A new push restarted the quiet period, but the turn already came to you.
  const review = changesRequested({ latestHeadSha: "sha3", heldTurn: held }, { headSeenAt: NOW - 60_000, handledAt: t(1) });
  expect(turn(review)).toMatchObject({ group: "needs", reason: "handled", signal: `handled:${t(1)}`, notify: false });
  // Your next review, or Not yet, ends it.
  expect(turn({ ...review, submittedAt: NOW - 1000 }).group).toBe("waiting");
  expect(turn({ ...review, snoozedAt: NOW - 1000 }).group).toBe("waiting");
});

test("questions and mentions count whatever your verdict", () => {
  expect(turn(changesRequested({ submittedVerdict: "APPROVE" }, { questionAt: t(1) }))).toMatchObject({ group: "needs", reason: "question" });
  expect(turn(changesRequested({ submittedVerdict: "APPROVE" }, { mentionAt: t(1) }))).toMatchObject({ group: "needs", reason: "mentioned" });
  expect(turn(changesRequested({}, { questionAt: t(1), isDraft: true }))).toMatchObject({ group: "needs", reason: "question" });
});

test("the baseline is your latest review, here or on GitHub, and Not yet needs one", () => {
  expect(baselineOf(changesRequested())).toEqual({ sha: "sha1", at: t(5), verdict: "REQUEST_CHANGES" });
  expect(baselineOf(changesRequested({ submittedAt: t(1), submittedHeadSha: "sha2" }))).toEqual({ sha: "sha2", at: t(1), verdict: "REQUEST_CHANGES" });
  const needs = changesRequested({}, { requestedAt: t(1) });
  expect(canSnooze(needs, turn(needs))).toBe(true);
  expect(canSnooze({ targetKey: "a", status: "ready" }, turn({ targetKey: "a", status: "ready" }))).toBe(false);
  const failed = changesRequested({ status: "error" }, { requestedAt: t(1) });
  expect(canSnooze(failed, turn(failed))).toBe(false);
});
