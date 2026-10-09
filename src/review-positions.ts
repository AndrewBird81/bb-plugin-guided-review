import { splitPatchByFile } from "./patch";
import type { DraftComment } from "./draft";

export interface FilePositions {
  /** New-file lines a RIGHT-side comment may target (added + context), by number, with their text. */
  right: Map<number, string>;
  /** Old-file lines a LEFT-side comment may target (deleted + context), by number, with their text. */
  left: Map<number, string>;
}

// GitHub's review API rejects (422) any comment whose (path, line, side) is not
// part of the diff. Walk each file's hunks to enumerate the lines that ARE, so
// we can validate a draft before we ever call `gh` and give a clear message
// instead of an opaque "Unprocessable Entity".
export function diffPositions(patch: string): Map<string, FilePositions> {
  const map = new Map<string, FilePositions>();
  for (const f of splitPatchByFile(patch)) {
    if (!f.path) continue;
    const right = new Map<number, string>();
    const left = new Map<number, string>();
    let oldLine = 0;
    let newLine = 0;
    for (const line of f.text.split("\n")) {
      const h = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
      if (h) {
        oldLine = Number(h[1]);
        newLine = Number(h[2]);
        continue;
      }
      if (/^(diff --git|index |--- |\+\+\+ )/.test(line)) continue;
      const c = line[0];
      if (c === "+") {
        right.set(newLine, line.slice(1));
        newLine++;
      } else if (c === "-") {
        left.set(oldLine, line.slice(1));
        oldLine++;
      } else if (c === " ") {
        right.set(newLine, line.slice(1));
        left.set(oldLine, line.slice(1));
        newLine++;
        oldLine++;
      }
      // else: blank line / "\ No newline at end of file" / artifact — not a
      // diff row, don't count it.
    }
    map.set(f.path, { right, left });
  }
  return map;
}

/** Draft comments GitHub would reject because their position isn't in the diff. */
export function invalidComments(patch: string, comments: DraftComment[]): DraftComment[] {
  const pos = diffPositions(patch);
  return comments.filter((c) => {
    const p = pos.get(c.file);
    if (!p) return true; // file isn't in the diff at all
    return c.side === "RIGHT" ? !p.right.has(c.line) : !p.left.has(c.line);
  });
}
