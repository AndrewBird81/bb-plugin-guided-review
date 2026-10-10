// @vitest-environment jsdom
// Checks sinceReviewCSS's selectors against what @pierre/diffs actually draws,
// using pierre's own server renderer (the same row markup as its shadow DOM).
import { test, expect } from "vitest";
import { preloadPatchDiff } from "@pierre/diffs/ssr";
import { installTestPluginRuntime } from "@get-bb/plugin-sdk/testing/app";

installTestPluginRuntime();
const { sinceReviewCSS } = await import("./DiffViewer");

const patch = [
  "diff --git a/src/a.ts b/src/a.ts",
  "--- a/src/a.ts",
  "+++ b/src/a.ts",
  "@@ -1,3 +1,3 @@",
  " keep",
  "-old",
  "+new",
  " tail",
  "@@ -10,2 +10,3 @@",
  " a",
  "+b",
  " c",
  "",
].join("\n");

for (const diffStyle of ["unified", "split"] as const) {
  test(`highlights exactly the code and gutter rows of new lines (${diffStyle})`, async () => {
    // Line 11 was added and old line 2 deleted since your review; new line 2 was already there.
    const css = sinceReviewCSS([11], [2]);
    const { prerenderedHTML } = await preloadPatchDiff({ patch, options: { diffStyle, disableFileHeader: true, unsafeCSS: css } });
    const root = document.createElement("div");
    root.innerHTML = prerenderedHTML;
    const selector = css.slice(0, css.indexOf("{"));
    const rows = Array.from(root.querySelectorAll<HTMLElement>(selector));
    // A code row and a gutter row for each of the two lines.
    expect(rows).toHaveLength(4);
    expect(rows.filter((row) => row.hasAttribute("data-column-number")).map((row) => row.textContent?.trim()).sort()).toEqual(["11", "2"]);
    expect(rows.filter((row) => row.hasAttribute("data-line")).map((row) => row.textContent?.trim()).sort()).toEqual(["b", "old"]);
    expect(prerenderedHTML).toContain('[data-line-type="change-addition"]:is([data-line="11"],[data-column-number="11"])');
  });
}

test("no new lines, no styles", () => {
  expect(sinceReviewCSS([], [])).toBe("");
});
