import { test, expect } from "vitest";
import { interdiff, describeInterdiff } from "./interdiff";
import { diffPositions } from "./review-positions";
import { splitPatchByFile } from "./patch";

const diff = (...lines: string[]) => lines.join("\n") + "\n";

const appHeaders = (index: string) =>
  [`diff --git a/src/app.ts b/src/app.ts`, `index ${index} 100644`, "--- a/src/app.ts", "+++ b/src/app.ts"];

const startHunk = diff(
  "@@ -10,5 +10,6 @@ export function start() {",
  "   const a = 1;",
  "   const b = 2;",
  "-  run(a);",
  "+  run(a, b);",
  '+  log("started");',
  "   return a;",
  " }",
);
const stopHunk = diff("@@ -40,3 +41,4 @@ function stop() {", "   cleanup();", "+  flush();", "   done();", " }");
const reviewedApp = diff(...appHeaders("1111111..2222222")) + startHunk + stopHunk;

const newFile = diff(
  "diff --git a/src/new.ts b/src/new.ts",
  "new file mode 100644",
  "index 0000000..5555555",
  "--- /dev/null",
  "+++ b/src/new.ts",
  "@@ -0,0 +1,2 @@",
  "+export const x = 1;",
  "+export const y = 2;",
);

const deletedFile = diff(
  "diff --git a/src/old.ts b/src/old.ts",
  "deleted file mode 100644",
  "index 6666666..0000000",
  "--- a/src/old.ts",
  "+++ /dev/null",
  "@@ -1,2 +0,0 @@",
  "-export const gone = 1;",
  "-export const also = 2;",
);

const renamed = (index: string, at: string) =>
  diff(
    "diff --git a/src/name.ts b/src/rename.ts",
    "similarity index 90%",
    "rename from src/name.ts",
    "rename to src/rename.ts",
    `index ${index} 100644`,
    "--- a/src/name.ts",
    "+++ b/src/rename.ts",
    at,
    " export function f() {",
    "-  return 1;",
    "+  return 2;",
    " }",
  );

const binary = (index: string) =>
  diff("diff --git a/img/logo.png b/img/logo.png", `index ${index} 100644`, "Binary files a/img/logo.png and b/img/logo.png differ");

test("identical inputs: every file is unchanged", () => {
  const patch = reviewedApp + newFile + renamed("7777777..8888888", "@@ -1,3 +1,3 @@") + binary("aaaaaaa..bbbbbbb");
  const files = interdiff(patch, patch);
  expect(files.map((f) => [f.file, f.status])).toEqual([
    ["src/app.ts", "unchanged"],
    ["src/new.ts", "unchanged"],
    ["src/name.ts", "unchanged"],
    ["img/logo.png", "unchanged"],
  ]);
  expect(files.every((f) => f.patch === "" && f.dropped === "" && !f.newLines.length)).toBe(true);
});

test("empty reviewed patch: every current file is added with all its changed lines", () => {
  const files = interdiff("", reviewedApp + newFile);
  expect(files.map((f) => f.status)).toEqual(["added", "added"]);
  expect(files[0]).toMatchObject({ newLines: [12, 13, 42], newDeletions: [12], patch: reviewedApp, dropped: "" });
  expect(files[1].newLines).toEqual([1, 2]);
});

test("a rebase (new @@ numbers, index SHAs, context, no-newline marker) is unchanged", () => {
  const rebased =
    diff(...appHeaders("3333333..4444444")) +
    diff(
      "@@ -14,5 +14,6 @@ export function start(opts) {",
      "   const a = opts.a;",
      "   const b = 2;",
      "-  run(a);",
      "+  run(a, b);",
      '+  log("started");',
      "   return a;",
      " }",
    ) +
    diff("@@ -52,3 +53,4 @@ function stop() {", "   cleanup(true);", "+  flush();", "   done();", " }", "\\ No newline at end of file");
  expect(interdiff(reviewedApp, rebased)).toEqual([
    { file: "src/app.ts", status: "unchanged", newLines: [], newDeletions: [], patch: "", dropped: "" },
  ]);
});

test("a fix-up adding one line inside a reviewed hunk reports only that hunk and line", () => {
  const fixedStart = diff(
    "@@ -10,5 +10,7 @@ export function start() {",
    "   const a = 1;",
    "   const b = 2;",
    "-  run(a);",
    "+  run(a, b);",
    "+  validate(b);",
    '+  log("started");',
    "   return a;",
    " }",
  );
  const current = diff(...appHeaders("1111111..9999999")) + fixedStart + stopHunk.replace("+41,4", "+42,4");
  const [f] = interdiff(reviewedApp, current);
  expect(f.status).toBe("changed");
  expect(f.newLines).toEqual([13]);
  expect(f.newDeletions).toEqual([]);
  expect(f.patch).toBe(diff(...appHeaders("1111111..9999999")) + fixedStart);
  expect(f.dropped).toBe(diff(...appHeaders("1111111..2222222")) + startHunk);
  // The patch is a real single-file diff.
  expect(splitPatchByFile(f.patch).map((p) => p.path)).toEqual(["src/app.ts"]);
  expect(diffPositions(f.patch).get("src/app.ts")!.right.get(13)).toBe("  validate(b);");
});

test("a new deletion is reported by its LEFT line number", () => {
  const current =
    diff(...appHeaders("1111111..2222222")) +
    startHunk +
    diff("@@ -40,4 +41,4 @@ function stop() {", "   cleanup();", "-  reset();", "+  flush();", "   done();", " }");
  const [f] = interdiff(reviewedApp, current);
  expect(f).toMatchObject({ status: "changed", newLines: [], newDeletions: [41] });
});

test("a reverted hunk is changed with only a dropped part", () => {
  const current = diff(...appHeaders("1111111..2222222")) + startHunk;
  const [f] = interdiff(reviewedApp, current);
  expect(f).toMatchObject({ status: "changed", newLines: [], newDeletions: [], patch: "" });
  expect(f.dropped).toBe(diff(...appHeaders("1111111..2222222")) + stopHunk);
});

test("each reviewed hunk matches at most one current hunk", () => {
  const twice = diff(...appHeaders("1111111..2222222")) + stopHunk + stopHunk.replace("-40,3 +41,4", "-80,3 +82,4");
  const [f] = interdiff(diff(...appHeaders("1111111..2222222")) + stopHunk, twice);
  expect(f).toMatchObject({ status: "changed", newLines: [83], dropped: "" });
});

test("a new file is added; a file gone from the PR is removed with its whole reviewed diff", () => {
  const files = interdiff(reviewedApp + deletedFile, reviewedApp + newFile);
  expect(files.map((f) => [f.file, f.status])).toEqual([
    ["src/app.ts", "unchanged"],
    ["src/new.ts", "added"],
    ["src/old.ts", "removed"],
  ]);
  expect(files[1]).toMatchObject({ newLines: [1, 2], patch: newFile });
  expect(files[2]).toMatchObject({ newLines: [], newDeletions: [], patch: "", dropped: deletedFile });
});

test("a deleted file still deleted after a rebase is unchanged", () => {
  const rebased = deletedFile.replace("6666666", "abcdef0");
  expect(interdiff(deletedFile, rebased)[0].status).toBe("unchanged");
});

test("a rename is matched by its old path across a rebase, and changes when its edit does", () => {
  const reviewed = renamed("7777777..8888888", "@@ -1,3 +1,3 @@");
  expect(interdiff(reviewed, renamed("1234567..8888888", "@@ -3,3 +3,3 @@"))[0]).toMatchObject({ file: "src/name.ts", status: "unchanged" });
  const edited = interdiff(reviewed, renamed("7777777..8888888", "@@ -1,3 +1,3 @@").replace("return 2", "return 3"))[0];
  expect(edited).toMatchObject({ file: "src/name.ts", status: "changed", newLines: [2] });
  expect(edited.patch).toContain("rename to src/rename.ts");
});

test("a binary file: rebased (same new blob) is unchanged; replaced (new blob) is changed", () => {
  const reviewed = binary("aaaaaaa..bbbbbbb");
  expect(interdiff(reviewed, binary("ccccccc..bbbbbbb"))[0].status).toBe("unchanged");
  const replaced = binary("aaaaaaa..ddddddd");
  expect(interdiff(reviewed, replaced)[0]).toEqual({
    file: "img/logo.png",
    status: "changed",
    newLines: [],
    newDeletions: [],
    patch: replaced,
    dropped: "",
  });
});

test("huge files fall back to multiset matching and still find the new line", () => {
  const body = (n: number, extra?: string) =>
    Array.from({ length: n }, (_, i) => `+line ${i}`).concat(extra ? [extra] : []).join("\n");
  const file = (lines: string, count: number) =>
    diff("diff --git a/big.txt b/big.txt", "--- a/big.txt", "+++ b/big.txt", `@@ -0,0 +1,${count} @@`) + lines + "\n";
  // Reversed order defeats prefix/suffix trimming, so the n*m guard kicks in.
  const reviewed = file(body(2500).split("\n").reverse().join("\n"), 2500);
  const current = file(body(2500, "+brand new"), 2501);
  expect(interdiff(reviewed, current)[0].newLines).toEqual([2501]);
});

test("describeInterdiff: summary, changed hunks, and what's gone", () => {
  const current = diff(...appHeaders("1111111..2222222")) + startHunk + newFile;
  const text = describeInterdiff(interdiff(reviewedApp + deletedFile, current));
  expect(text.split("\n")[0]).toBe("Since your review: 1 changed, 1 added, 1 removed, 0 unchanged files.");
  expect(text).toContain("=== src/app.ts (changed) ===");
  expect(text).toContain("Gone since your review:\n" + diff(...appHeaders("1111111..2222222")).trimEnd());
  expect(text).toContain("+  flush();");
  expect(text).toContain("=== src/new.ts (added) ===\n\n" + newFile.trimEnd());
  expect(text).toContain("=== src/old.ts (removed) ===");
});

test("describeInterdiff: one file only", () => {
  const files = interdiff(reviewedApp, reviewedApp + newFile);
  const text = describeInterdiff(files, { file: "src/new.ts" });
  expect(text).toContain("=== src/new.ts (added) ===");
  expect(text).not.toContain("src/app.ts");
  expect(describeInterdiff(files, { file: "src/app.ts" })).toBe("No changes to src/app.ts since your review.");
});

test("describeInterdiff: no changes", () => {
  expect(describeInterdiff(interdiff(reviewedApp, reviewedApp))).toBe("No changes since your review.");
  expect(describeInterdiff([])).toBe("No changes since your review.");
});

test("describeInterdiff: truncates with a note on asking for one file", () => {
  const text = describeInterdiff(interdiff("", reviewedApp + newFile), { maxChars: 200 });
  const [kept, note] = text.split("\n\n[Truncated");
  expect(kept.length).toBeLessThanOrEqual(200);
  expect(note).toContain("Ask for one file");
});
