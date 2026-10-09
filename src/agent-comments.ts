import type { Store } from "./store";
import { diffPositions } from "./review-positions";

export interface AgentComment {
  file: string;
  line: number;
  side?: "LEFT" | "RIGHT";
  /** The line's text, which catches a miscounted line number. */
  code: string;
  body: string;
}

const normalize = (text: string) => text.replace(/\s+/g, " ").trim();

/**
 * Add a review assistant's comment to its own review's local draft; only the
 * reviewer submits drafts to GitHub. Refuses instead of guessing, and never
 * changes a comment already in the draft.
 */
export function addAgentComment(store: Store, threadId: string, input: AgentComment):
  { ok: true; targetKey: string; text: string } | { ok: false; error: string } {
  const targetKey = store.listAssistantThreads().find((thread) => thread.threadId === threadId)?.targetKey;
  const review = targetKey ? store.getReview(targetKey) : null;
  if (!targetKey || !review) return { ok: false, error: "This conversation is no longer a review's assistant, so it has no draft to add to." };
  if (review.status === "generating") return { ok: false, error: "The review is being regenerated. Wait until it finishes, then read the new diff." };
  if (review.prState === "MERGED" || review.prState === "CLOSED") return { ok: false, error: `This PR is ${review.prState.toLowerCase()}, so its draft can't be submitted.` };
  const side = input.side ?? "RIGHT";
  const patch = store.readPatch(targetKey, 0, store.readPatch(targetKey, 0, 0).total).text;
  const lines = diffPositions(patch).get(input.file)?.[side === "RIGHT" ? "right" : "left"];
  if (!lines) return { ok: false, error: `${input.file} isn't in this review's diff. Use the path exactly as the diff shows it. Nothing was added.` };
  const text = lines.get(input.line);
  const code = normalize(input.code);
  if (text === undefined || normalize(text) !== code) {
    const actual = text === undefined
      ? `Line ${input.line} isn't on the ${side} side of ${input.file} in this diff.`
      : `Line ${input.line} on the ${side} side of ${input.file} is \`${text.trim().slice(0, 500)}\`.`;
    const matches = [...lines].filter(([, line]) => normalize(line) === code).map(([number]) => number);
    const hint = matches.length ? ` The code you sent is on line ${matches.slice(0, 5).join(", ")}.` : ` The code you sent isn't on the ${side} side of ${input.file}.`;
    return { ok: false, error: `${actual}${hint} Nothing was added.` };
  }
  const existing = store.getDraft(targetKey).comments.find((c) => c.file === input.file && c.line === input.line && c.side === side);
  if (existing) return { ok: false, error: `${input.file} line ${input.line} already has a draft comment: "${existing.body.slice(0, 300)}". It was kept; make your point in your reply instead.` };
  store.upsertDraftComment(targetKey, { file: input.file, line: input.line, side, body: input.body.trim() });
  return { ok: true, targetKey, text: `Added to the reviewer's draft on ${input.file} line ${input.line}. It stays in bb until the reviewer submits the review.` };
}
