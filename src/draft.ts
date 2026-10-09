export type Verdict = "APPROVE" | "REQUEST_CHANGES" | "COMMENT";

export interface DraftComment {
  file: string;
  line: number;
  side: "LEFT" | "RIGHT";
  chapterId?: string;
  /** Added by an agent, through a tool or `bb review comment`. Absent once the reviewer writes or edits it in the panel. */
  author?: "agent";
  body: string;
}

/** A comment's place in the diff; a draft holds at most one comment per location. */
export type CommentLocation = Pick<DraftComment, "file" | "line" | "side">;

export function sameLocation(a: CommentLocation, b: CommentLocation): boolean {
  return a.file === b.file && a.line === b.line && a.side === b.side;
}

export interface Draft {
  targetKey: string;
  verdict: Verdict;
  body: string;
  comments: DraftComment[];
}

/** Whether two lists hold the same comments, in the same order. */
export function sameComments(a: readonly DraftComment[], b: readonly Pick<DraftComment, "file" | "line" | "side" | "body">[]): boolean {
  const key = (c: Pick<DraftComment, "file" | "line" | "side" | "body">) => JSON.stringify([c.file, c.line, c.side, c.body]);
  return a.length === b.length && a.every((c, i) => key(c) === key(b[i]));
}

export function toGithubReviewPayload(draft: Draft): {
  event: Verdict;
  body: string;
  comments: { path: string; line: number; side: string; body: string }[];
} {
  return {
    event: draft.verdict,
    body: draft.body,
    comments: draft.comments.map((c) => ({ path: c.file, line: c.line, side: c.side, body: c.body })),
  };
}
