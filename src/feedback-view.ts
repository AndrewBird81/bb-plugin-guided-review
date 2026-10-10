// Your feedback, the PR's diffs at the commits that matter, and the assistant's
// check, assembled for the Feedback view and the assistant's tools.
import type { Store, ReviewMeta } from "./store";
import type { runGh } from "./gh";
import { ghPrDiffArgs, ghErrorMessage } from "./gh";
import { ensureGitHeaders } from "./patch";
import { interdiff, type FileInterdiff } from "./interdiff";
import { firstLine, type AssessmentItem, type FeedbackItem, type FeedbackView } from "../lib/feedback";
import { baselineOf, type AssessmentSummary } from "../lib/turn";
import type { Verdict } from "./draft";

type Run = typeof runGh;

export { baselineOf } from "../lib/turn";
export const headOf = (review: ReviewMeta) => review.latestHeadSha ?? review.headSha ?? null;

/**
 * The PR's diff at a commit: saved, the review's own diff, the PR's current
 * diff, or reconstructed by comparing the base branch with that commit.
 */
export async function diffAt(store: Store, run: Run, review: ReviewMeta, sha: string): Promise<string> {
  const saved = store.getSnapshot(review.targetKey, sha);
  if (saved !== null) return saved;
  if (sha === review.headSha) {
    const patch = store.readPatch(review.targetKey, 0, store.readPatch(review.targetKey, 0, 0).total).text;
    if (patch) { store.saveSnapshot(review.targetKey, sha, patch); return patch; }
  }
  if (!review.repo || !review.number) throw new Error("This review has no GitHub PR.");
  let patch: string;
  if (sha === headOf(review)) {
    const diff = await run(ghPrDiffArgs(review.number, review.repo));
    if (diff.code !== 0) throw new Error(ghErrorMessage(diff));
    patch = diff.stdout;
  } else {
    // GitHub diffs the base branch with that commit from their merge base, as the PR did then.
    const base = review.base ?? "HEAD";
    const diff = await run(["api", "-H", "Accept: application/vnd.github.diff", `repos/${review.repo}/compare/${encodeURIComponent(base)}...${sha}`]);
    if (diff.code !== 0) throw new Error(`Couldn't read the PR as of ${sha.slice(0, 7)}: ${ghErrorMessage(diff)}`);
    patch = diff.stdout;
  }
  patch = ensureGitHeaders(patch);
  store.saveSnapshot(review.targetKey, sha, patch);
  return patch;
}

/** Keep the diffs this review still needs: its guide's, your review's, and the PR's head. */
export function pruneDiffs(store: Store, review: ReviewMeta) {
  store.pruneSnapshots(review.targetKey, [review.headSha, baselineOf(review).sha, headOf(review)].filter((sha): sha is string => !!sha));
}

/** The displayed diff compared with the diff at your last review; null when there's nothing to compare. */
export async function sinceReview(store: Store, run: Run, review: ReviewMeta): Promise<{ baseline: { sha: string; at: number | null; verdict: Verdict | null }; files: FileInterdiff[] } | null> {
  const baseline = baselineOf(review);
  if (!baseline.sha || !review.headSha || baseline.sha === review.headSha) return null;
  const reviewed = await diffAt(store, run, review, baseline.sha);
  const current = store.readPatch(review.targetKey, 0, store.readPatch(review.targetKey, 0, 0).total).text;
  return { baseline: { ...baseline, sha: baseline.sha }, files: interdiff(reviewed, current) };
}

/** Summary asks are the assistant's items "summary:<n>". */
export const isSummaryItem = (id: string) => /^summary:\d+$/.test(id);

/** Your feedback, the assistant's latest check, and drafted replies. */
export function feedbackView(store: Store, review: ReviewMeta): FeedbackView {
  const head = headOf(review);
  const threads = store.listFeedbackThreads(review.targetKey);
  const latest = store.latestAssessmentRun(review.targetKey);
  // The check of the head now; otherwise the latest check, marked as older.
  const checkedHead = head && store.getAssessment(review.targetKey, head).items.length ? head : latest?.headSha ?? null;
  const assessment = checkedHead ? store.getAssessment(review.targetKey, checkedHead) : { items: [], run: null };
  const byId = new Map(assessment.items.map((item) => [item.id, item]));
  const drafts = store.listReplyDrafts(review.targetKey);
  const url = (commentId: number) => review.url ? `${review.url}#discussion_r${commentId}` : null;
  const items: FeedbackItem[] = threads.map(({ resolvedSeenAt: _, ...thread }) => ({
    id: thread.id, kind: "thread", title: firstLine(thread.body) || `${thread.path ?? "File"} comment`,
    thread: { ...thread, url: url(thread.commentId) }, assessment: byId.get(thread.id) ?? null, replyDraft: drafts.get(thread.id) ?? null,
  }));
  for (const item of assessment.items) {
    if (isSummaryItem(item.id)) items.push({ id: item.id, kind: "summary", title: item.title ?? "From your review summary", thread: null, assessment: item, replyDraft: null });
  }
  const run = assessment.run ?? (checkedHead ? null : latest);
  return {
    baseline: baselineOf(review), head, items,
    run: run ? { ...run, current: run.headSha === head } : null,
    fetchedAt: store.feedbackFetched(review.targetKey)?.fetchedAt ?? null,
  };
}

/** Counts for the list and the turn rules, over every thread plus the summary asks checked. */
export function summarize(headSha: string, items: AssessmentItem[], threadIds: readonly string[]): AssessmentSummary {
  const byId = new Map(items.map((item) => [item.id, item]));
  const ids = [...new Set([...threadIds, ...items.filter((item) => isSummaryItem(item.id)).map((item) => item.id)])];
  const count = (verdict: AssessmentItem["verdict"]) => ids.filter((id) => byId.get(id)?.verdict === verdict).length;
  return {
    headSha, total: ids.length, addressed: count("addressed"), partial: count("partial"), notAddressed: count("not_addressed"),
    disputed: count("disputed"), unclear: count("unclear"), assessedAt: Math.max(0, ...items.map((item) => item.assessedAt)),
  };
}

/** A Request changes summary listing the feedback that isn't addressed yet. */
export function remainingBody(view: FeedbackView): string {
  const open = view.items.filter((item) => item.assessment ? item.assessment.verdict !== "addressed" : item.thread?.status !== "resolved");
  if (!open.length) return "";
  const line = (item: FeedbackItem) => {
    const where = item.thread?.path ? ` (\`${item.thread.path}${item.thread.line ? `:${item.thread.line}` : ""}\`)` : "";
    const evidence = item.assessment?.evidence ? ` — ${item.assessment.evidence}` : "";
    return `- ${item.title}${where}${evidence}`;
  };
  return ["Thanks for the updates. A few things are still open:", "", ...open.map(line)].join("\n");
}
