import { test, expect } from "vitest";
import { hashFileDiff, normalizedFileHash } from "./diff-hash";

test("hash is stable for identical input", () => {
  const a = hashFileDiff("diff --git a/x b/x\n+hello\n");
  const b = hashFileDiff("diff --git a/x b/x\n+hello\n");
  expect(a).toBe(b);
});

test("hash changes when the diff text changes", () => {
  const a = hashFileDiff("+hello\n");
  const b = hashFileDiff("+hello world\n");
  expect(a).not.toBe(b);
});

test("hash is a lowercase hex sha256 (64 chars)", () => {
  const h = hashFileDiff("anything");
  expect(h).toMatch(/^[0-9a-f]{64}$/);
});

const fileDiff = (index: string, at: string, context: string, added = "+  run(a, b);") =>
  [
    "diff --git a/src/app.ts b/src/app.ts",
    `index ${index} 100644`,
    "--- a/src/app.ts",
    "+++ b/src/app.ts",
    at,
    context,
    "-  run(a);",
    added,
    " }",
    "",
  ].join("\n");

test("normalizedFileHash ignores @@ numbers, index SHAs and context lines", () => {
  const a = normalizedFileHash(fileDiff("1111111..2222222", "@@ -10,3 +10,3 @@", "   const a = 1;"));
  const b = normalizedFileHash(fileDiff("3333333..4444444", "@@ -14,3 +14,3 @@ start()", "   const a = 10;"));
  expect(a).toBe(b);
});

test("normalizedFileHash changes when a change line does", () => {
  const a = normalizedFileHash(fileDiff("1111111..2222222", "@@ -10,3 +10,3 @@", "   const a = 1;"));
  const b = normalizedFileHash(fileDiff("1111111..2222222", "@@ -10,3 +10,3 @@", "   const a = 1;", "+  run(b, a);"));
  expect(a).not.toBe(b);
});

test("normalizedFileHash of a binary diff keeps the new blob, ignores the base blob", () => {
  const bin = (index: string) => `diff --git a/x.png b/x.png\nindex ${index} 100644\nBinary files a/x.png and b/x.png differ\n`;
  expect(normalizedFileHash(bin("aaaaaaa..bbbbbbb"))).toBe(normalizedFileHash(bin("ccccccc..bbbbbbb")));
  expect(normalizedFileHash(bin("aaaaaaa..bbbbbbb"))).not.toBe(normalizedFileHash(bin("aaaaaaa..ddddddd")));
});
