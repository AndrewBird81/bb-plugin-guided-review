import { diffPositions } from "./review-positions";

export interface AnchoredComment {
  file: string;
  line: number;
  side: "LEFT" | "RIGHT";
  /** The line's text when the comment was drafted, without the diff prefix; absent for older comments. */
  code?: string;
}

export type Reanchored = { status: "same" } | { status: "moved"; line: number } | { status: "lost" };

const normalize = (text: string) => text.replace(/\s+/g, " ").trim();

function sideLines(patch: string, file: string, side: "LEFT" | "RIGHT"): Map<number, string> | undefined {
  const p = diffPositions(patch).get(file);
  return p && (side === "RIGHT" ? p.right : p.left);
}

/** The text of a line in a diff: RIGHT for added/context lines by new-file number, LEFT for deleted/context by old-file number. */
export function lineText(patch: string, file: string, line: number, side: "LEFT" | "RIGHT"): string | undefined {
  return sideLines(patch, file, side)?.get(line);
}

/** Where a draft comment's line is in the current diff: same number, the nearest line with the same code, or lost. */
export function reanchor(comment: AnchoredComment, previousPatch: string, currentPatch: string): Reanchored {
  const code = comment.code ?? lineText(previousPatch, comment.file, comment.line, comment.side);
  if (code === undefined) return { status: "lost" };
  const lines = sideLines(currentPatch, comment.file, comment.side);
  if (!lines) return { status: "lost" };
  const want = normalize(code);
  const at = lines.get(comment.line);
  if (at !== undefined && normalize(at) === want) return { status: "same" };
  const distances = [...lines].filter(([, text]) => normalize(text) === want).map(([n]) => ({ n, d: Math.abs(n - comment.line) }));
  if (!distances.length) return { status: "lost" };
  const best = distances.reduce((min, c) => Math.min(min, c.d), Infinity);
  const nearest = distances.filter((c) => c.d === best);
  return nearest.length === 1 ? { status: "moved", line: nearest[0].n } : { status: "lost" };
}
