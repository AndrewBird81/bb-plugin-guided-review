// Your feedback on a PR and the review assistant's check of it, shared by the
// server and the Feedback view.
import type { Verdict } from "../src/draft";
import type { FeedbackThread } from "../src/github/types";

export type AssessmentVerdict = "addressed" | "partial" | "not_addressed" | "disputed" | "unclear";

/** The assistant's verdict on one piece of feedback, for one head commit. */
export interface AssessmentItem {
  /** A thread id, or "summary:<n>" for an ask in a review summary. */
  id: string;
  verdict: AssessmentVerdict;
  /** One line: what changed, or what's missing. */
  evidence: string;
  /** For a summary ask, the ask itself. */
  title?: string;
  /** Where the evidence is in the current diff. */
  file?: string;
  line?: number;
  assessedAt: number;
}

/** The assistant's overall check of one head commit. */
export interface AssessmentRun {
  headSha: string;
  summary: string;
  /** What the assistant would submit; the reviewer decides. */
  suggestedVerdict: Verdict | null;
  suggestedBody: string;
  assessedAt: number;
}

export interface ReplyDraft { body: string; author: "agent" | "reviewer"; updatedAt: number }

/** One piece of your feedback, as the Feedback view shows it. */
export interface FeedbackItem {
  id: string;
  kind: "thread" | "summary";
  /** The first line of your comment, or the summary ask. */
  title: string;
  thread: (FeedbackThread & { url: string | null }) | null;
  assessment: AssessmentItem | null;
  replyDraft: ReplyDraft | null;
}

export interface FeedbackView {
  /** The review your feedback came from: your latest real review. */
  baseline: { sha: string | null; at: number | null; verdict: Verdict | null };
  /** The PR's head now. */
  head: string | null;
  items: FeedbackItem[];
  /** The assistant's latest check; `current` when it checked this head. */
  run: (AssessmentRun & { current: boolean }) | null;
  /** When your threads were last read from GitHub. */
  fetchedAt: number | null;
}

/** The first line of a comment, trimmed for a list. */
export function firstLine(text: string, max = 140): string {
  const line = text.split("\n").map((part) => part.trim()).find((part) => part && !part.startsWith(">") && !part.startsWith("```")) ?? "";
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}
