// The review assistant's check of whether your feedback was addressed: how it
// starts, and what its tools return. Nothing here writes to GitHub.
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { Store, ReviewMeta } from "./store";
import type { runGh } from "./gh";
import { messageAssistant } from "./agent";
import { baselineOf, diffAt, feedbackView, headOf, isSummaryItem, summarize } from "./feedback-view";
import { describeInterdiff, interdiff } from "./interdiff";
import type { AssessmentItem, AssessmentVerdict } from "../lib/feedback";
import type { Verdict } from "./draft";

type Run = typeof runGh;
const short = (sha: string | null | undefined) => sha ? sha.slice(0, 7) : "unknown";
const date = (ms: number | null | undefined) => ms ? new Date(ms).toISOString().slice(0, 16).replace("T", " ") + " UTC" : "an earlier time";

/** What the assistant needs to know before checking, sent only to it. */
export function verificationContext(review: ReviewMeta, reason: string): string {
  const baseline = baselineOf(review);
  const head = headOf(review);
  const s = review.signals ?? {};
  return [
    `Why now: ${reason}.`,
    `The reviewer's last review: ${baseline.verdict ?? "a review"} on commit ${short(baseline.sha)} (${date(baseline.at)}). The PR's head is now ${short(head)}${s.commitsSince ? `, ${s.commitsSince} commit${s.commitsSince === 1 ? "" : "s"} later` : ""}.`,
    review.headSha && head && review.headSha !== head
      ? `The guide and read_review_patch still show commit ${short(review.headSha)}. For the code now, use read_changes_since_review and read_file with ref "current".`
      : "read_review_patch shows the PR as it is now.",
    `Use list_feedback for the reviewer's feedback, read_changes_since_review for what changed since their review, and record every item with assess_feedback (it applies to head ${short(head)}). Only the reviewer posts to GitHub.`,
  ].join("\n");
}

/** Ask the review's assistant to check your feedback. False when it's turned off or can't start. */
export async function startVerification(bb: BbPluginApi, store: Store, targetKey: string, reason: string): Promise<boolean> {
  const prompt = store.getPreferences().preferences.verificationPrompt.trim();
  const review = store.getReview(targetKey);
  if (!prompt || !review || review.kind !== "pr" || !baselineOf(review).at) return false;
  try {
    await messageAssistant(bb, store, targetKey, prompt, verificationContext(review, reason));
  } catch (error) {
    bb.log.warn(`The feedback check for ${targetKey} didn't start: ${String(error)}`);
    return false;
  }
  store.setLifecycle(targetKey, { verifyingSince: Date.now() });
  bb.realtime.publish(`conversation:${targetKey}`, {});
  return true;
}

/** list_feedback: your threads, their replies and state, and your review summaries. */
export function describeFeedback(store: Store, review: ReviewMeta): string {
  const view = feedbackView(store, review);
  const threads = view.items.filter((item) => item.thread);
  const lines: string[] = [];
  lines.push(threads.length ? `${threads.length} review thread${threads.length === 1 ? "" : "s"} the reviewer started:` : "The reviewer started no review threads.");
  for (const { thread, assessment } of threads) {
    if (!thread) continue;
    const where = thread.path ? `${thread.path}${thread.line ? `:${thread.line}` : thread.originalLine ? ` (was line ${thread.originalLine}; the code there changed)` : ""}${thread.side === "LEFT" ? " (LEFT side)" : ""}` : "the PR";
    const state = [thread.status === "resolved" ? `resolved${thread.resolvedBy ? ` by @${thread.resolvedBy}` : ""}` : thread.status === "question" ? "the author asked a question" : thread.status === "answered" ? "the author replied" : "no reply yet",
      thread.isOutdated ? "code changed since the comment" : ""].filter(Boolean).join(", ");
    lines.push("", `[${thread.id}] ${where} · ${state}`, ...thread.body.split("\n").map((l) => `  > ${l}`));
    for (const reply of thread.replies.slice(-5)) lines.push(`  @${reply.author}${reply.mine ? " (reviewer)" : ""}${reply.bot ? " (bot)" : ""}: ${reply.body.replace(/\s+/g, " ").slice(0, 1500)}`);
    if (assessment) lines.push(`  Earlier check: ${assessment.verdict} — ${assessment.evidence}`);
  }
  const bodies = review.reviewBodies ?? [];
  if (bodies.length) {
    lines.push("", "The reviewer's review summaries, newest last. Record each distinct ask in them as an item with id \"summary:1\", \"summary:2\", … and a short title:");
    for (const body of bodies) lines.push("", `(${body.state}, ${date(body.at)})`, ...body.body.split("\n").map((l) => `  > ${l}`));
  }
  return lines.join("\n");
}

/** read_changes_since_review: the diff of diffs since your review, with the commits made since. */
export async function changesSinceReview(store: Store, run: Run, review: ReviewMeta, file?: string): Promise<string> {
  const baseline = baselineOf(review);
  const head = headOf(review);
  if (!baseline.sha || !head) return "The reviewer hasn't reviewed this PR yet, so there's nothing to compare.";
  if (baseline.sha === head) return `No commits since the reviewer's last review (${short(head)}).`;
  const [before, now] = await Promise.all([diffAt(store, run, review, baseline.sha), diffAt(store, run, review, head)]);
  const commits = await commitsSince(run, review, baseline.sha).catch(() => null);
  return [
    `Changes to the PR between the reviewer's last review (${short(baseline.sha)}) and now (${short(head)}), diffed PR to PR so rebases and base-branch merges don't show.`,
    commits ? `Commits since:\n${commits}` : "",
    describeInterdiff(interdiff(before, now), { file }),
  ].filter(Boolean).join("\n\n");
}

async function commitsSince(run: Run, review: ReviewMeta, sha: string): Promise<string> {
  const out = await run(["api", `repos/${review.repo}/pulls/${review.number}/commits?per_page=100`, "--jq", ".[] | [.sha, (.commit.message | split(\"\\n\")[0])] | @tsv"]);
  if (out.code !== 0) throw new Error(out.stderr);
  const rows = out.stdout.trim().split("\n").filter(Boolean).map((row) => row.split("\t"));
  const index = rows.findIndex(([oid]) => oid === sha);
  // After a force-push the reviewed commit may be gone from the PR; show them all.
  const after = index >= 0 ? rows.slice(index + 1) : rows;
  return after.length ? after.map(([oid, message]) => `- ${short(oid)} ${message}`).join("\n") + (index < 0 ? "\n(The reviewed commit is no longer on the branch; it was rebased or force-pushed.)" : "") : "None.";
}

/** read_file: a file at your reviewed commit or the PR's head, with line numbers. */
export async function readFileAt(run: Run, review: ReviewMeta, path: string, ref: "current" | "reviewed", startLine = 1, endLine?: number): Promise<string> {
  const sha = ref === "reviewed" ? baselineOf(review).sha : headOf(review);
  if (!sha || !review.repo) return "There's no such commit for this review.";
  const encoded = path.split("/").map(encodeURIComponent).join("/");
  const out = await run(["api", "-H", "Accept: application/vnd.github.raw", `repos/${review.repo}/contents/${encoded}?ref=${sha}`]);
  if (out.code !== 0) return `Couldn't read ${path} at ${short(sha)}: ${out.stderr.trim() || "not found"}`;
  const lines = out.stdout.split("\n");
  const from = Math.max(1, startLine);
  const to = Math.min(lines.length, endLine ?? from + 399);
  const body = lines.slice(from - 1, to).map((line, i) => `${String(from + i).padStart(5)}  ${line}`).join("\n");
  return `${path} at ${short(sha)}, lines ${from}–${to} of ${lines.length}:\n${body}${to < lines.length ? `\n[Call again with startLine=${to + 1} for more.]` : ""}`;
}

export interface AssessInput {
  items: Array<{ id: string; verdict: AssessmentVerdict; evidence: string; title?: string; file?: string; line?: number }>;
  summary?: string;
  suggestedVerdict?: Verdict;
  suggestedBody?: string;
}

/** assess_feedback: record the assistant's verdicts for the PR's head. */
export function assess(store: Store, review: ReviewMeta, input: AssessInput): { ok: true; text: string } | { ok: false; error: string } {
  const head = headOf(review);
  if (!head) return { ok: false, error: "This review has no commit to check against." };
  const threadIds = store.listFeedbackThreads(review.targetKey).map((t) => t.id);
  const unknown = input.items.filter((item) => !threadIds.includes(item.id) && !isSummaryItem(item.id)).map((item) => item.id);
  if (unknown.length) return { ok: false, error: `Unknown item ids: ${unknown.join(", ")}. Use the thread ids from list_feedback, or "summary:<n>" for asks in a review summary. Nothing was recorded.` };
  const untitled = input.items.filter((item) => isSummaryItem(item.id) && !item.title?.trim() && !store.getAssessment(review.targetKey, head).items.some((i) => i.id === item.id && i.title));
  if (untitled.length) return { ok: false, error: `Give each summary ask a title: ${untitled.map((i) => i.id).join(", ")}. Nothing was recorded.` };
  const now = Date.now();
  const items: AssessmentItem[] = input.items.map((item) => ({
    id: item.id, verdict: item.verdict, evidence: item.evidence.trim().slice(0, 1000), assessedAt: now,
    ...(item.title?.trim() ? { title: item.title.trim().slice(0, 300) } : {}),
    ...(item.file ? { file: item.file } : {}), ...(item.line ? { line: item.line } : {}),
  }));
  store.saveAssessmentItems(review.targetKey, head, items);
  const previous = store.getAssessment(review.targetKey, head).run;
  store.saveAssessmentRun(review.targetKey, {
    headSha: head, assessedAt: now,
    summary: input.summary?.trim() ?? previous?.summary ?? "",
    suggestedVerdict: input.suggestedVerdict ?? previous?.suggestedVerdict ?? null,
    suggestedBody: input.suggestedBody?.trim() ?? previous?.suggestedBody ?? "",
  });
  const summary = summarize(head, store.getAssessment(review.targetKey, head).items, threadIds);
  store.setLifecycle(review.targetKey, { assessment: summary });
  const missing = summary.total - summary.addressed - summary.partial - summary.notAddressed - summary.disputed - summary.unclear;
  return { ok: true, text: `Recorded ${items.length} item${items.length === 1 ? "" : "s"} for ${short(head)}: ${summary.addressed} of ${summary.total} addressed.${missing ? ` ${missing} item${missing === 1 ? " has" : "s have"} no verdict yet.` : ""} The reviewer sees them in the Feedback view.` };
}
