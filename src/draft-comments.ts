// Draft comments as agents and `bb review comment` change them. Everything
// here edits this bb's local draft; only the reviewer submits it to GitHub.
import type { ReviewMeta, Store } from "./store";
import { sameLocation, type CommentLocation } from "./draft";
import { diffPositions } from "./review-positions";

/** A comment's location as callers give it; side defaults to RIGHT. */
export interface LocationInput { file: string; line: number; side?: "LEFT" | "RIGHT" }
export interface NewComment extends LocationInput {
  /** The line's text, which catches a miscounted line number. */
  code: string;
  body: string;
}
export type DraftResult = { ok: true; text: string } | { ok: false; error: string };

const normalize = (text: string) => text.replace(/\s+/g, " ").trim();
const located = (input: LocationInput): CommentLocation => ({ file: input.file, line: input.line, side: input.side ?? "RIGHT" });
const where = (at: CommentLocation) => `${at.file}:${at.line}${at.side === "LEFT" ? " (LEFT side)" : ""}`;

/** The review whose assistant conversation this thread is. */
export function assistantReview(store: Store, threadId: string): string | null {
  return store.listAssistantThreads().find((thread) => thread.threadId === threadId)?.targetKey ?? null;
}

function unchangeable(review: ReviewMeta | null): string | null {
  if (!review) return "This review no longer exists.";
  if (review.status === "generating") return "The review is being regenerated. Wait until it finishes, then read the new diff.";
  if (review.prState === "MERGED" || review.prState === "CLOSED") return `This PR is ${review.prState.toLowerCase()}, so its draft can't be submitted.`;
  return null;
}

/** The draft's comments, who added each, and whether the diff changed since it was drafted. */
export function listComments(store: Store, targetKey: string) {
  const stale = store.staleDraftComments(targetKey);
  return store.getDraft(targetKey).comments.map((c) => ({
    file: c.file, line: c.line, side: c.side, author: c.author ?? "reviewer", body: c.body,
    stale: stale.some((s) => sameLocation(s, c)),
  }));
}

export function describeComments(store: Store, targetKey: string): string {
  const comments = listComments(store, targetKey);
  if (!comments.length) return "The draft has no comments.";
  return [
    `${comments.length} draft comment${comments.length === 1 ? "" : "s"}:`,
    ...comments.map((c) => [
      `${c.file}:${c.line} ${c.side} · added by ${c.author === "agent" ? "an agent" : "the reviewer"}${c.stale ? " · drafted against an older diff, so submitting refuses it" : ""}`,
      ...c.body.split("\n").map((line) => `  ${line}`),
    ].join("\n")),
  ].join("\n");
}

/** Add an agent's comment. It must sit on a line of the current diff whose text matches `code`, where the draft has no comment yet. */
export function addComment(store: Store, targetKey: string, input: NewComment): DraftResult {
  const refused = unchangeable(store.getReview(targetKey));
  if (refused) return { ok: false, error: refused };
  const at = located(input);
  const patch = store.readPatch(targetKey, 0, store.readPatch(targetKey, 0, 0).total).text;
  const lines = diffPositions(patch).get(at.file)?.[at.side === "RIGHT" ? "right" : "left"];
  if (!lines) return { ok: false, error: `${at.file} isn't in this review's diff. Use the path exactly as the diff shows it. Nothing was added.` };
  const text = lines.get(at.line);
  const code = normalize(input.code);
  if (text === undefined || normalize(text) !== code) {
    const actual = text === undefined
      ? `Line ${at.line} isn't on the ${at.side} side of ${at.file} in this diff.`
      : `Line ${at.line} on the ${at.side} side of ${at.file} is \`${text.trim().slice(0, 500)}\`.`;
    const matches = [...lines].filter(([, line]) => normalize(line) === code).map(([number]) => number);
    const hint = matches.length ? ` The code you sent is on line ${matches.slice(0, 5).join(", ")}.` : ` The code you sent isn't on the ${at.side} side of ${at.file}.`;
    return { ok: false, error: `${actual}${hint} Nothing was added.` };
  }
  const existing = store.getDraft(targetKey).comments.find((c) => sameLocation(c, at));
  if (existing) return { ok: false, error: `${where(at)} already has a draft comment: "${existing.body.slice(0, 300)}". Edit it instead, or make your point elsewhere. Nothing was added.` };
  store.upsertDraftComment(targetKey, { ...at, author: "agent", body: input.body.trim() });
  return { ok: true, text: `Added a draft comment on ${where(at)}. It stays in bb until the reviewer submits the review.` };
}

/** Replace a comment's text. Its location, author, and the diff it was drafted against stay. */
export function editComment(store: Store, targetKey: string, input: LocationInput & { body: string }): DraftResult {
  const refused = unchangeable(store.getReview(targetKey));
  if (refused) return { ok: false, error: refused };
  const at = located(input);
  if (!store.editDraftComment(targetKey, at, input.body.trim())) return { ok: false, error: `There's no draft comment on ${where(at)}.` };
  return { ok: true, text: `Updated the draft comment on ${where(at)}.` };
}

export function deleteComment(store: Store, targetKey: string, input: LocationInput): DraftResult {
  const refused = unchangeable(store.getReview(targetKey));
  if (refused) return { ok: false, error: refused };
  const at = located(input);
  if (!store.deleteDraftComment(targetKey, at)) return { ok: false, error: `There's no draft comment on ${where(at)}.` };
  return { ok: true, text: `Deleted the draft comment on ${where(at)}.` };
}
