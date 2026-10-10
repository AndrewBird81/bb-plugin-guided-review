import { expect, test, vi } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";

const runGh = vi.hoisted(() => vi.fn());
vi.mock("./gh", async (orig) => ({ ...(await orig<any>()), runGh, runGit: vi.fn(async () => ({ stdout: "", stderr: "", code: 0 })) }));

import plugin from "../server";
import { createStore } from "./store";
import { reviewRevision } from "./review-revision";
import type { FeedbackThread } from "./github/types";

const reviewed = "diff --git a/a.ts b/a.ts\nindex 1..2 100644\n--- a/a.ts\n+++ b/a.ts\n@@ -1,2 +1,2 @@\n keep\n-return cache.get(key);\n+return cache.get(key) ?? load(key);\n";
const now = "diff --git a/a.ts b/a.ts\nindex 1..3 100644\n--- a/a.ts\n+++ b/a.ts\n@@ -1,2 +1,3 @@\n keep\n-return cache.get(key);\n+invalidate(key);\n+return cache.get(key) ?? load(key);\n";
const thread = (id: string, status: FeedbackThread["status"]): FeedbackThread => ({
  id, commentId: 11, reviewId: null, path: "a.ts", line: 2, originalLine: 2, startLine: null, side: "RIGHT", subjectType: "LINE",
  body: "Can this return stale data after a write?", createdAt: 1, isResolved: status === "resolved", resolvedBy: null, isOutdated: true,
  replies: [{ author: "alice", bot: false, mine: false, body: "Invalidated on write now.", createdAt: 5 }], status, replyAt: 5,
});

async function setup() {
  runGh.mockReset();
  runGh.mockImplementation(async (args: string[]) => {
    if (args[0] === "api" && args[1] === "user") return { stdout: "me\n", stderr: "", code: 0 };
    if (args.includes("Accept: application/vnd.github.diff")) return { stdout: reviewed, stderr: "", code: 0 };
    if (args[0] === "api" && String(args[1]).includes("/commits")) return { stdout: "sha1\tAdd cache\nsha2\tInvalidate on write\n", stderr: "", code: 0 };
    if (args[0] === "api" && String(args.at(-1)).includes("/contents/")) return { stdout: "line one\nline two\n", stderr: "", code: 0 };
    if (args[0] === "api" && String(args[3]).includes("/replies")) return { stdout: "{}", stderr: "", code: 0 };
    // Threads read when the RPCs refresh them.
    if (args[0] === "api" && args[1] === "graphql") return { stdout: JSON.stringify({ data: { repository: { pullRequest: { reviewThreads: { pageInfo: { hasNextPage: false }, nodes: [{
      id: "t1", isResolved: false, isOutdated: true, path: "a.ts", line: 2, originalLine: 2, startLine: null, diffSide: "RIGHT", subjectType: "LINE", resolvedBy: null,
      first: { nodes: [{ id: "c1", databaseId: 11, author: { login: "me" }, body: "Can this return stale data after a write?", createdAt: "2026-10-01T00:00:00Z", pullRequestReview: { id: "r1" } }] },
      recent: { nodes: [{ id: "c2", author: { __typename: "User", login: "alice" }, body: "Invalidated on write now.", createdAt: "2026-10-02T00:00:00Z" }] },
    }] } } } } }), stderr: "", code: 0 };
    return { stdout: "", stderr: "", code: 0 };
  });
  const published: any[] = [];
  const { bb, harness } = createFakePluginHost({ pluginId: "guided-review", sdk: {
    threads: { get: async () => ({ archivedAt: null, deletedAt: null, status: "idle", title: "Review agent: pr-1" }), send: async () => ({}), stop: async () => ({}), update: async () => ({}), archive: async () => ({}) },
    plugins: { callRpc: async ({ method, input }: any) => (method === "activityCapabilities" ? { version: 1 } : (published.push({ method, input }), { accepted: true, id: "a", duplicate: false, ok: true })) },
  } as any });
  await plugin(bb);
  const store = createStore(bb);
  store.saveReview({ targetKey: "pr-1", kind: "pr", repo: "acme/web", number: 1, url: "https://github.com/acme/web/pull/1", base: "main", head: "cache", headSha: "sha2", createdAt: 1, status: "ready", projectId: "p1" });
  store.savePatch("pr-1", now);
  store.saveGuide("pr-1", { title: "T", intent: "I", sections: [{ id: "c", title: "Cache", overview: "o", diffs: [{ file: "a.ts", summary: "s" }] }], unplacedFiles: [] });
  store.setLifecycle("pr-1", {
    prState: "OPEN", latestHeadSha: "sha2", submittedVerdict: "REQUEST_CHANGES", submittedAt: 1000, submittedHeadSha: "sha1",
    signals: { lastReviewAt: 1000, lastReviewSha: "sha1", requestedAt: 2000, requestedBy: "alice", ci: "pass" },
    reviewBodies: [{ state: "CHANGES_REQUESTED", at: 1000, body: "Also document the TTL." }],
  });
  store.saveFeedbackThreads("pr-1", [thread("t1", "answered")], 1);
  store.setAssistantThread("pr-1", "assistant");
  const call = (method: string, input: unknown) => harness.behavior.callRpc(method, input) as Promise<any>;
  const tool = (name: string, input: unknown) => harness.behavior.callAgentTool(name, input, { threadId: "assistant" }) as Promise<any>;
  return { bb, harness, store, call, tool, published };
}

test("reviews leave the server with whose turn they are", async () => {
  const { call } = await setup();
  const { reviews } = await call("listReviews", null);
  expect(reviews[0].turn).toMatchObject({ group: "needs", reason: "re-requested", label: "Re-requested" });
  expect((await call("getReview", { targetKey: "pr-1" })).review.turn.group).toBe("needs");
});

test("Not yet moves a review to Waiting on author and clears its alert", async () => {
  const { call, published } = await setup();
  expect(await call("snoozeReview", { targetKey: "pr-1", snoozed: true })).toEqual({ ok: true });
  expect((await call("getReview", { targetKey: "pr-1" })).review.turn).toMatchObject({ group: "waiting", reason: "snoozed" });
  expect(published.some((p) => p.method === "dismissActivity" && p.input.id === "activity:guided-review:pr-1")).toBe(true);
  await call("snoozeReview", { targetKey: "pr-1", snoozed: false });
  expect((await call("getReview", { targetKey: "pr-1" })).review.turn.group).toBe("needs");
});

test("the assistant lists your feedback, reads what changed, and records its check", async () => {
  const { tool, call, store } = await setup();
  const listed = await tool("list_feedback", {});
  expect(listed).toContain("[t1] a.ts:2");
  expect(listed).toContain("Can this return stale data after a write?");
  expect(listed).toContain("@alice: Invalidated on write now.");
  expect(listed).toContain("Also document the TTL.");
  const changes = await tool("read_changes_since_review", {});
  expect(changes).toContain("Invalidate on write");
  expect(changes).toContain("+invalidate(key);");
  expect(await tool("read_file", { path: "a.ts" })).toContain("    1  line one");

  const bad = await tool("assess_feedback", { items: [{ id: "nope", verdict: "addressed", evidence: "x" }] });
  expect(bad.isError).toBe(true);
  const untitled = await tool("assess_feedback", { items: [{ id: "summary:1", verdict: "not_addressed", evidence: "No docs" }] });
  expect(untitled.isError).toBe(true);
  const ok = await tool("assess_feedback", {
    items: [{ id: "t1", verdict: "addressed", evidence: "invalidate(key) runs before the read" }, { id: "summary:1", title: "Document the TTL", verdict: "not_addressed", evidence: "README unchanged" }],
    summary: "One of two asks done.", suggestedVerdict: "REQUEST_CHANGES", suggestedBody: "Thanks! Still need the TTL docs.",
  });
  expect(ok).toContain("1 of 2 addressed");
  expect(store.getReview("pr-1")?.assessment).toMatchObject({ headSha: "sha2", total: 2, addressed: 1, notAddressed: 1 });
  expect(await tool("draft_thread_reply", { threadId: "t1", body: "Fixed in sha2, thanks." })).toContain("Drafted");

  const { feedback } = await call("getFeedback", { targetKey: "pr-1" });
  expect(feedback.items.map((i: any) => [i.id, i.kind, i.assessment?.verdict])).toEqual([["t1", "thread", "addressed"], ["summary:1", "summary", "not_addressed"]]);
  expect(feedback.items[0]).toMatchObject({ replyDraft: { body: "Fixed in sha2, thanks.", author: "agent" }, thread: { url: "https://github.com/acme/web/pull/1#discussion_r11" } });
  expect(feedback.run).toMatchObject({ current: true, suggestedVerdict: "REQUEST_CHANGES" });
  expect((await call("getReview", { targetKey: "pr-1" })).review.progress).toEqual({ done: 1, total: 2, source: "assistant" });
});

test("the suggested verdict and what's left fill the draft, bound to the displayed revision", async () => {
  const { tool, call, store } = await setup();
  await tool("assess_feedback", { items: [{ id: "t1", verdict: "partial", evidence: "Only the write path invalidates" }], suggestedVerdict: "REQUEST_CHANGES", suggestedBody: "Close! One path left." });
  expect((await call("useSuggestedVerdict", { targetKey: "pr-1", mode: "suggested" })).ok).toBe(false);
  const revision = reviewRevision(store, "pr-1");
  expect(await call("useSuggestedVerdict", { targetKey: "pr-1", revision, mode: "suggested" })).toMatchObject({ ok: true, draft: { verdict: "REQUEST_CHANGES", body: "Close! One path left." } });
  const remaining = await call("useSuggestedVerdict", { targetKey: "pr-1", revision, mode: "remaining" });
  expect(remaining.draft.body).toContain("Can this return stale data after a write? (`a.ts:2`) — Only the write path invalidates");
});

test("replying from the Feedback view posts to the thread and clears the drafted reply", async () => {
  const { call, store } = await setup();
  store.setReplyDraft("pr-1", "t1", "Thanks!", "agent");
  const result = await call("replyToFeedback", { targetKey: "pr-1", threadId: "t1", body: "Thanks, looks right." });
  expect(result.ok).toBe(true);
  const reply = runGh.mock.calls.find(([args]) => String(args[3]).includes("/comments/11/replies"));
  expect(reply?.[1]).toEqual({ stdin: JSON.stringify({ body: "Thanks, looks right." }) });
  expect(store.listReplyDrafts("pr-1").size).toBe(0);
});

test("since your review compares the displayed diff with the diff you reviewed", async () => {
  const { call } = await setup();
  const since = await call("getSinceReview", { targetKey: "pr-1" });
  expect(since.baseline).toMatchObject({ sha: "sha1", verdict: "REQUEST_CHANGES" });
  expect(since.files).toMatchObject([{ file: "a.ts", status: "changed", newLines: [2] }]);
});

test("deleting a PR keeps discovery from adding it back", async () => {
  const { call, store } = await setup();
  store.clearAssistantThread("pr-1");
  expect(await call("deleteReview", { targetKey: "pr-1" })).toEqual({ ok: true });
  expect(store.isDiscoveryIgnored("pr-1")).toBe(true);
});
