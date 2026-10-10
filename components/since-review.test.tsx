// @vitest-environment jsdom
import { test, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, within } from "@testing-library/react";
import { installTestPluginRuntime, loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { interdiff } from "../src/interdiff";
import { defaultPreferences } from "../src/preferences";

// Render each diff's new-side text and its extra styles, not @pierre/diffs' internals.
vi.mock("@pierre/diffs/react", () => ({
  FileDiff: ({ fileDiff, options }: any) => (
    <pre data-testid="filediff" data-css={options?.unsafeCSS ?? ""}>{[...fileDiff.deletionLines, ...fileDiff.additionLines].join("\n")}</pre>
  ),
}));

installTestPluginRuntime();
const { DiffViewer } = await import("./DiffViewer");

afterEach(() => { cleanup(); localStorage.clear(); });

const file = (path: string, hunks: string) => `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n${hunks}`;
const first = "@@ -1,3 +1,3 @@\n keep\n-old\n+new\n tail\n";
const reviewed = [
  file("src/a.ts", `${first}@@ -10,2 +10,3 @@\n a\n+b\n c\n`),
  file("src/b.ts", "@@ -1 +1 @@\n-x\n+y\n"),
  file("src/d.ts", "@@ -1 +1 @@\n-gone\n+going\n"),
].join("");
const current = [
  file("src/a.ts", `${first}@@ -10,2 +10,3 @@\n a\n+bb\n c\n`),
  file("src/b.ts", "@@ -1 +1 @@\n-x\n+y\n"),
  file("src/c.ts", "@@ -0,0 +1 @@\n+brand new\n"),
].join("");
const files = interdiff(reviewed, current);
const since = new Map(files.map((f) => [f.file, f]));
const chapter = ["src/a.ts", "src/b.ts", "src/c.ts"];

function diffOf(path: string) {
  const card = document.querySelector<HTMLElement>(`[data-file="${path}"]`);
  return card ? within(card) : null;
}

test("since your review: unchanged files hide, a changed file shows only its changed hunks, removed files get a card", () => {
  render(<DiffViewer patch={current} files={chapter} views={new Map()} onToggleViewed={() => {}} since={since} sinceOnly />);
  expect(diffOf("src/b.ts")).toBeNull();
  expect(screen.getByText("1 file unchanged since your review")).toBeTruthy();
  const a = diffOf("src/a.ts")!.getByTestId("filediff");
  expect(a.textContent).toContain("bb");
  expect(a.textContent).not.toContain("new");
  expect(a.dataset.css).toContain('[data-line-type="change-addition"]:is([data-line="11"],[data-column-number="11"])');
  expect(diffOf("src/c.ts")!.getByTestId("filediff").textContent).toContain("brand new");
  const removed = screen.getByRole("region", { name: "src/d.ts removed" });
  expect(within(removed).getByText("Removed from the PR since your review")).toBeTruthy();
  // jsdom doesn't open <details> on a click; open it as the browser would.
  const details = removed.querySelector("details")!;
  details.open = true;
  fireEvent(details, new Event("toggle"));
  expect(within(removed).getByTestId("filediff").textContent).toContain("gone");
});

test("with the filter off, every file shows in full and changed ones are badged", () => {
  render(<DiffViewer patch={current} files={chapter} views={new Map()} onToggleViewed={() => {}} since={since} />);
  expect(diffOf("src/a.ts")!.getByTestId("filediff").textContent).toContain("new");
  expect(diffOf("src/a.ts")!.getByText("Changed since your review")).toBeTruthy();
  expect(diffOf("src/c.ts")!.getByText("Changed since your review")).toBeTruthy();
  expect(diffOf("src/b.ts")!.queryByText("Changed since your review")).toBeNull();
  expect(screen.queryByText(/unchanged since your review/)).toBeNull();
  expect(screen.queryByRole("region", { name: "src/d.ts removed" })).toBeNull();
});

const guide = {
  title: "Guide", intent: "Parses rows.", unplacedFiles: [],
  sections: [
    { id: "c1", title: "Parsing", overview: "", diffs: [{ file: "src/a.ts" }, { file: "src/b.ts" }] },
    { id: "c2", title: "New file", overview: "", diffs: [{ file: "src/c.ts" }] },
  ],
};

async function renderWorkspace(review: Record<string, unknown>, getSinceReview = vi.fn(() => ({ baseline: { sha: "old", at: 1, verdict: "COMMENT" }, files }))) {
  const app = await loadPluginApp(() => import("../app"));
  const slot = renderSlot(app.navPanels[0]!, { subPath: "pr-42" }, { rpc: {
    setReviewPresence: () => ({ ok: true }),
    getReviewBundle: () => ({ review: { targetKey: "pr-42", kind: "pr", status: "ready", createdAt: 1, title: "Parse rows", ...review }, guide, patch: current, revision: "r1" }),
    getChecks: () => ({ bucket: "none", checks: [] }),
    getPreferences: () => ({ preferences: defaultPreferences, revision: 0 }),
    getFileViews: () => ({ views: [] }),
    checkRepoAccess: () => ({ accessible: true, repo: "acme/web", account: "me" }),
    checkForUpdates: () => ({ hasNewCommits: false }),
    getDraft: () => ({ draft: { targetKey: "pr-42", verdict: "COMMENT", body: "", comments: [] } }),
    getReviewerNotes: () => ({ body: "", revision: 0 }),
    getConversation: () => ({ threadId: null, legacy: [], defaults: null }),
    markSeen: () => ({ ok: true }),
    getSinceReview,
  } as any });
  await slot.findByRole("heading", { name: "Parse rows" });
  return { slot, getSinceReview };
}

test("the diff offers Since your review only when you reviewed another commit", async () => {
  const same = await renderWorkspace({ headSha: "old", signals: { lastReviewSha: "old" }, submittedVerdict: "COMMENT" });
  expect(same.slot.queryByRole("button", { name: "Since your review" })).toBeNull();
  expect(same.getSinceReview).not.toHaveBeenCalled();
  same.slot.lifecycle.unmount();

  const { slot, getSinceReview } = await renderWorkspace({ headSha: "new", signals: { lastReviewSha: "old" }, submittedVerdict: "COMMENT" });
  const toggle = await slot.findByRole("button", { name: "Since your review" });
  expect(getSinceReview).toHaveBeenCalledWith({ targetKey: "pr-42" });
  // Each chapter counts its files changed since your review.
  const chapters = within(slot.getByRole("navigation", { name: "Chapters" }));
  expect(chapters.getAllByText("1 changed")).toHaveLength(2);
  expect(slot.container.querySelector('[data-file="src/b.ts"]')).toBeTruthy();
  fireEvent.click(toggle);
  expect(toggle.getAttribute("aria-pressed")).toBe("true");
  expect(slot.container.querySelector('[data-file="src/b.ts"]')).toBeNull();
  expect(slot.getByText("1 file unchanged since your review")).toBeTruthy();
  slot.lifecycle.unmount();
});
