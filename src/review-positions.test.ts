import { test, expect } from "vitest";
import { diffPositions, invalidComments } from "./review-positions";

const patch = [
  "diff --git a/x.ts b/x.ts",
  "--- a/x.ts",
  "+++ b/x.ts",
  "@@ -1,3 +1,4 @@",
  " a", // new 1 / old 1 (context)
  "-b", // old 2 (deleted)
  "+b2", // new 2 (added)
  "+c", // new 3 (added)
  " d", // new 4 / old 3 (context)
  "",
].join("\n");

test("diffPositions enumerates valid right/left lines with their text", () => {
  const p = diffPositions(patch).get("x.ts")!;
  expect([...p.right].sort(([a], [b]) => a - b)).toEqual([[1, "a"], [2, "b2"], [3, "c"], [4, "d"]]);
  expect([...p.left].sort(([a], [b]) => a - b)).toEqual([[1, "a"], [2, "b"], [3, "d"]]);
});

test("a RIGHT comment on an added line is valid", () => {
  expect(invalidComments(patch, [{ file: "x.ts", line: 2, side: "RIGHT", body: "x" }])).toHaveLength(0);
});

test("a RIGHT comment on a line past the diff is rejected", () => {
  const bad = invalidComments(patch, [{ file: "x.ts", line: 99, side: "RIGHT", body: "x" }]);
  expect(bad).toHaveLength(1);
});

test("a comment on a file not in the diff is rejected", () => {
  expect(invalidComments(patch, [{ file: "other.ts", line: 1, side: "RIGHT", body: "x" }])).toHaveLength(1);
});

test("a LEFT comment on a deleted line is valid", () => {
  expect(invalidComments(patch, [{ file: "x.ts", line: 2, side: "LEFT", body: "x" }])).toHaveLength(0);
});
