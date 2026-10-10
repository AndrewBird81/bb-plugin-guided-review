import { test, expect } from "vitest";
import { lineText, reanchor } from "./reanchor";

const diff = (...lines: string[]) => lines.join("\n") + "\n";
const headers = ["diff --git a/src/app.ts b/src/app.ts", "index 1111111..2222222 100644", "--- a/src/app.ts", "+++ b/src/app.ts"];

const previous = diff(
  ...headers,
  "@@ -10,5 +10,6 @@ export function start() {",
  "   const a = 1;", // new 10 / old 10
  "   const b = 2;", // new 11 / old 11
  "-  run(a);", // old 12
  "+  run(a, b);", // new 12
  '+  log("started");', // new 13
  "   return a;", // new 14 / old 13
  " }",
);

// A fix-up inserted two lines above, so everything after moved down by 2.
const shifted = diff(
  ...headers,
  "@@ -10,5 +10,8 @@ export function start() {",
  "   const a = 1;",
  "   const b = 2;",
  "+  check(a);",
  "+  check(b);",
  "-  run(a);", // old 12
  "+  run(a, b);", // new 14
  '+  log("started");', // new 15
  "   return a;",
  " }",
);

test("lineText reads RIGHT by new-file number and LEFT by old-file number", () => {
  expect(lineText(previous, "src/app.ts", 12, "RIGHT")).toBe("  run(a, b);");
  expect(lineText(previous, "src/app.ts", 12, "LEFT")).toBe("  run(a);");
  expect(lineText(previous, "src/app.ts", 14, "RIGHT")).toBe("  return a;");
  expect(lineText(previous, "src/app.ts", 99, "RIGHT")).toBeUndefined();
  expect(lineText(previous, "other.ts", 1, "RIGHT")).toBeUndefined();
});

test("a line still at its number (whitespace aside) is the same", () => {
  const reindented = previous.replace("+  run(a, b);", "+    run(a,  b);");
  expect(reanchor({ file: "src/app.ts", line: 12, side: "RIGHT" }, previous, reindented)).toEqual({ status: "same" });
  expect(reanchor({ file: "src/app.ts", line: 12, side: "LEFT" }, previous, shifted)).toEqual({ status: "same" });
});

test("a line that moved follows its code", () => {
  expect(reanchor({ file: "src/app.ts", line: 13, side: "RIGHT" }, previous, shifted)).toEqual({ status: "moved", line: 15 });
});

test("stored code wins over the previous diff", () => {
  const comment = { file: "src/app.ts", line: 12, side: "RIGHT" as const, code: '  log("started");' };
  expect(reanchor(comment, "", shifted)).toEqual({ status: "moved", line: 15 });
});

test("the nearest matching line wins; a tie is lost", () => {
  const twice = diff(...headers, "@@ -0,0 +1,5 @@", "+x();", "+a();", "+y();", "+a();", "+x();");
  expect(reanchor({ file: "src/app.ts", line: 3, side: "RIGHT", code: "x();" }, "", twice)).toEqual({ status: "lost" });
  expect(reanchor({ file: "src/app.ts", line: 4, side: "RIGHT", code: "x();" }, "", twice)).toEqual({ status: "moved", line: 5 });
});

test("lost when the code is gone, unknown, or the file left the diff", () => {
  const rewritten = previous.replace('+  log("started");', '+  log("ready");');
  expect(reanchor({ file: "src/app.ts", line: 13, side: "RIGHT" }, previous, rewritten)).toEqual({ status: "lost" });
  expect(reanchor({ file: "src/app.ts", line: 99, side: "RIGHT" }, previous, previous)).toEqual({ status: "lost" });
  expect(reanchor({ file: "src/app.ts", line: 12, side: "RIGHT" }, previous, "")).toEqual({ status: "lost" });
});
