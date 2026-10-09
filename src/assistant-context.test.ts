import { test, expect } from "vitest";
import { contextLabel, contextQuote, extractSelectedLines } from "./assistant-context";

const linePatch = [
  "diff --git a/x.ts b/x.ts",
  "--- a/x.ts",
  "+++ b/x.ts",
  "@@ -1,3 +1,4 @@",
  " a",
  "-b",
  "+b2",
  "+c",
  " d",
  "",
].join("\n");

test("extractSelectedLines pulls the exact new-side lines of a range", () => {
  expect(extractSelectedLines(linePatch, "x.ts", 2, 3, "additions")).toBe("+b2\n+c");
});

test("extractSelectedLines pulls old-side (deletions) lines", () => {
  expect(extractSelectedLines(linePatch, "x.ts", 2, 2, "deletions")).toBe("-b");
});

test("a line selection is quoted with exactly those lines", () => {
  expect(contextQuote({ file: "x.ts", startLine: 2, endLine: 3, side: "additions" }, linePatch)).toBe("In `x.ts` lines 2-3:\n```diff\n+b2\n+c\n```");
  expect(contextLabel({ file: "src/x.ts", startLine: 2, endLine: 3 })).toBe("x.ts:2–3");
});

test("highlighted code is quoted as written, and a file alone is named for the assistant to read", () => {
  expect(contextQuote({ file: "a.ts", code: "const x = 1" }, "")).toBe("In `a.ts`:\n```\nconst x = 1\n```");
  expect(contextQuote({ file: "src/a.ts", chapterId: "c1" }, linePatch)).toBe("About `src/a.ts`.");
  expect(contextQuote({ file: "x.ts", startLine: 40 }, linePatch)).toBe("About `x.ts` line 40.");
  expect(contextQuote({}, linePatch)).toBe("");
});
