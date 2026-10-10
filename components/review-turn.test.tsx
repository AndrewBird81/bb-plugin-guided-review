// @vitest-environment jsdom
import { afterEach, expect, test, vi } from "vitest";
import { cleanup, fireEvent, waitFor, within } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { defaultPreferences } from "../src/preferences";
import { patchReviewState } from "../lib/panel-state";
import type { FeedbackView } from "../lib/feedback";

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));
// Render the diff's annotations (where the comment box opens), not @pierre/diffs' internals.
vi.mock("@pierre/diffs/react", () => ({
  FileDiff: ({ lineAnnotations, renderAnnotation }: any) => (
    <div data-testid="filediff">{lineAnnotations?.map((annotation: any, index: number) => <div key={index}>{renderAnnotation?.(annotation)}</div>)}</div>
  ),
}));

afterEach(() => { cleanup(); localStorage.clear(); sessionStorage.clear(); vi.clearAllMocks(); });

const DAY = 86_400_000;
const now = Date.now();
const patch = "diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1,2 @@\n-old\n+new\n+more\n";
const guide = {
  title: "Guide", intent: "Parses rows.", unplacedFiles: [],
  sections: [{ id: "c1", title: "Parsing", overview: "", diffs: [{ file: "src/a.ts" }] }],
};
const turn = (over: Record<string, unknown>) => ({ group: "needs", reason: "re-requested", label: "Re-requested", action: "Review changes", signal: null, at: now, notify: true, blocking: false, updated: true, ...over });
const feedback: FeedbackView = {
  baseline: { sha: "old", at: now - 3 * DAY, verdict: "REQUEST_CHANGES" }, head: "new", fetchedAt: now,
  run: { headSha: "new", summary: "", suggestedVerdict: "APPROVE", suggestedBody: "Looks good now.", assessedAt: now, current: true },
  items: [{
    id: "T1", kind: "thread", title: "Handle the empty list", replyDraft: null, assessment: null,
    thread: { id: "T1", commentId: 1, reviewId: "R1", path: "src/a.ts", line: 2, originalLine: 2, startLine: null, side: "RIGHT", subjectType: "LINE", body: "Handle the empty list.", createdAt: now - 3 * DAY, isResolved: false, resolvedBy: null, isOutdated: false, replies: [], status: "open", replyAt: null, url: null },
  }],
};

async function renderWorkspace(review: Record<string, unknown>, rpc: Record<string, unknown> = {}, bundleGuide: unknown = guide) {
  const app = await loadPluginApp(() => import("../app"));
  const handlers = {
    setReviewPresence: () => ({ ok: true }),
    getReviewBundle: vi.fn(() => ({ review: { targetKey: "pr-42", kind: "pr", status: "ready", createdAt: 1, title: "Parse rows", headSha: "new", ...review }, guide: bundleGuide, patch, revision: "r1" })),
    getChecks: () => ({ bucket: "none", checks: [] }),
    getPreferences: () => ({ preferences: defaultPreferences, revision: 0 }),
    getFileViews: () => ({ views: [] }),
    checkRepoAccess: () => ({ accessible: true, repo: "acme/web", account: "me" }),
    checkForUpdates: () => ({ hasNewCommits: false }),
    getDraft: vi.fn(() => ({ draft: { targetKey: "pr-42", verdict: "COMMENT", body: "", comments: [] } })),
    getReviewerNotes: () => ({ body: "", revision: 0 }),
    getConversation: () => ({ threadId: null, legacy: [], defaults: null }),
    getSinceReview: () => ({ baseline: null, files: [] }),
    getFeedback: vi.fn(() => ({ feedback })),
    markSeen: vi.fn(() => ({ ok: true })),
    snoozeReview: vi.fn(() => ({ ok: true })),
    startTrackedReview: vi.fn(() => ({ ok: true })),
    useSuggestedVerdict: vi.fn(() => ({ ok: true })),
    ...rpc,
  };
  const slot = renderSlot(app.navPanels[0]!, { subPath: "pr-42" }, { rpc: handlers as any });
  return { slot, rpc: handlers };
}

const viewButton = (slot: Awaited<ReturnType<typeof renderWorkspace>>["slot"], name: string) => slot.getByRole("button", { name, pressed: undefined }) as HTMLButtonElement;

test("opening a re-requested review marks it seen and starts on Feedback", async () => {
  const { slot, rpc } = await renderWorkspace({ submittedVerdict: "REQUEST_CHANGES", turn: turn({}) });
  await slot.findByText("Your feedback");
  expect(rpc.markSeen).toHaveBeenCalledTimes(1);
  expect(rpc.markSeen).toHaveBeenCalledWith({ targetKey: "pr-42" });
  expect(viewButton(slot, "Feedback").getAttribute("aria-pressed")).toBe("true");
  slot.lifecycle.unmount();
});

test("a view the reviewer chose wins over the turn", async () => {
  patchReviewState("pr-42", { view: "diff" });
  const { slot } = await renderWorkspace({ submittedVerdict: "REQUEST_CHANGES", turn: turn({}) });
  await slot.findByRole("heading", { name: "Parse rows" });
  expect(viewButton(slot, "Diff").getAttribute("aria-pressed")).toBe("true");
  expect(slot.queryByText("Your feedback")).toBeNull();
  slot.lifecycle.unmount();
});

test("a local review has no Feedback view", async () => {
  const { slot } = await renderWorkspace({ kind: "ref", gitRef: "main...x" });
  await slot.findByRole("heading", { name: "Parse rows" });
  expect(slot.queryByRole("button", { name: "Feedback" })).toBeNull();
  expect(viewButton(slot, "Diff").getAttribute("aria-pressed")).toBe("true");
  slot.lifecycle.unmount();
});

test("Follow up opens the comment box at the thread's line in the diff", async () => {
  const { slot } = await renderWorkspace({ submittedVerdict: "REQUEST_CHANGES", turn: turn({}) });
  const card = await slot.findByRole("article", { name: "Handle the empty list" });
  await slot.findByRole("region", { name: "Submitted review" });
  fireEvent.click(within(card).getByRole("button", { name: "Follow up" }));
  await waitFor(() => expect(viewButton(slot, "Diff").getAttribute("aria-pressed")).toBe("true"));
  const box = await within(slot.getByTestId("filediff")).findByRole("textbox", { name: "Draft comment" });
  expect(box.closest("[data-draft-at]")?.getAttribute("data-draft-at")).toContain("src/a.ts");
  slot.lifecycle.unmount();
});

test("Use as draft opens the draft with the assistant's verdict and summary", async () => {
  let draft = { targetKey: "pr-42", verdict: "COMMENT", body: "", comments: [] };
  const { slot, rpc } = await renderWorkspace({ submittedVerdict: "REQUEST_CHANGES", turn: turn({}) }, {
    getDraft: vi.fn(() => ({ draft })),
    useSuggestedVerdict: vi.fn(() => { draft = { ...draft, verdict: "APPROVE", body: "Looks good now." }; return { ok: true }; }),
  });
  await slot.findByRole("region", { name: "Submitted review" });
  fireEvent.click(await slot.findByRole("button", { name: "Use as draft" }));
  await waitFor(() => expect(rpc.useSuggestedVerdict).toHaveBeenCalledWith({ targetKey: "pr-42", mode: "suggested", revision: "r1" }));
  await waitFor(() => expect((slot.getByRole("textbox", { name: "Review summary" }) as HTMLTextAreaElement).value).toBe("Looks good now."));
  const verdicts = within(slot.getByRole("group", { name: "Review verdict" }));
  expect(verdicts.getByRole("button", { name: "Approve" }).getAttribute("aria-pressed")).toBe("true");
  slot.lifecycle.unmount();
});

test("the header shows your review rounds, progress, Blocks merge, and Not yet", async () => {
  const { slot, rpc } = await renderWorkspace({
    submittedVerdict: "REQUEST_CHANGES",
    turn: turn({ blocking: true }),
    progress: { done: 2, total: 5, source: "assistant" },
    signals: { lastReviewSha: "old", rounds: [
      { state: "CHANGES_REQUESTED", at: now - 3 * DAY, sha: "a" },
      { state: "COMMENTED", at: now - DAY, sha: "b" },
    ] },
  });
  const rounds = await slot.findByRole("list", { name: "Your reviews" });
  expect(rounds.textContent).toBe("Changes requested 3d ago→Commented 1d ago");
  expect(slot.getByText("Blocks merge")).toBeTruthy();
  fireEvent.click(slot.getByRole("button", { name: "Not yet" }));
  await waitFor(() => expect(rpc.snoozeReview).toHaveBeenCalledWith({ targetKey: "pr-42", snoozed: true }));
  // The progress pill opens Feedback.
  patchReviewState("pr-42", {});
  fireEvent.click(viewButton(slot, "Diff"));
  fireEvent.click(slot.getByText("2/5 addressed"));
  expect(viewButton(slot, "Feedback").getAttribute("aria-pressed")).toBe("true");
  slot.lifecycle.unmount();
});

test("a snoozed review offers Back to Needs review, and an unreviewed one no Not yet", async () => {
  const snoozed = await renderWorkspace({ submittedVerdict: "REQUEST_CHANGES", turn: turn({ group: "waiting", reason: "snoozed", label: "Not yet" }) });
  fireEvent.click(await snoozed.slot.findByRole("button", { name: "Back to Needs review" }));
  await waitFor(() => expect(snoozed.rpc.snoozeReview).toHaveBeenCalledWith({ targetKey: "pr-42", snoozed: false }));
  snoozed.slot.lifecycle.unmount();

  const fresh = await renderWorkspace({ turn: turn({ reason: "requested", label: "Review requested" }) });
  await fresh.slot.findByRole("heading", { name: "Parse rows" });
  expect(fresh.slot.queryByRole("button", { name: "Not yet" })).toBeNull();
  fresh.slot.lifecycle.unmount();
});

test("a tracked review offers Start review instead of the guide", async () => {
  const { slot, rpc } = await renderWorkspace({
    status: "tracked", repo: "acme/web", number: 42, author: "octo", url: "https://github.com/acme/web/pull/42",
    turn: turn({ reason: "requested", label: "Review requested" }), signals: { requestedBy: "alice" },
  }, {}, null);
  await slot.findByRole("heading", { name: "Parse rows" });
  expect(slot.getByText("Review requested")).toBeTruthy();
  expect(slot.getByText("Requested by @alice")).toBeTruthy();
  expect(slot.getByRole("link", { name: "Open on GitHub" }).getAttribute("href")).toBe("https://github.com/acme/web/pull/42");
  fireEvent.click(slot.getByRole("button", { name: "Start review" }));
  await waitFor(() => expect(rpc.startTrackedReview).toHaveBeenCalledWith({ targetKey: "pr-42" }));
  slot.lifecycle.unmount();
});

test("a tracked review that can't start says why", async () => {
  const { toast } = await import("sonner");
  const { slot } = await renderWorkspace({ status: "tracked", turn: turn({ reason: "new", label: "Tracked" }) }, {
    startTrackedReview: () => ({ ok: false, error: "No coding agent is set up." }),
  }, null);
  fireEvent.click(await slot.findByRole("button", { name: "Start review" }));
  await waitFor(() => expect(toast.error).toHaveBeenCalledWith("No coding agent is set up."));
  slot.lifecycle.unmount();
});
