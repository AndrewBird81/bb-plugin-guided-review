import { expect, test, vi } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { createStore } from "./store";
import { createReviewSync } from "./review-lifecycle";

function setup(state = "OPEN", reviews: unknown[] = []) {
  const { bb, harness } = createFakePluginHost({ pluginId: "guided-review", sdk: { threads: { update: async () => ({}), stop: async () => ({}), archive: async () => ({}) } } });
  const store = createStore(bb);
  store.saveReview({ targetKey: "pr-1", kind: "pr", repo: "acme/web", number: 1, headSha: "sha1", createdAt: 1, status: "ready" });
  // A legacy review-agent worker, from before conversations moved into bb threads.
  bb.storage.database().prepare(`INSERT INTO agent_threads (target_key,thread_id,created_at) VALUES ('pr-1','agent-1',1)`).run();
  store.setAssistantThread("pr-1", "assistant-1");
  const run = vi.fn(async () => ({ code: 0, stderr: "", stdout: JSON.stringify({ data: { viewer: { login: "me" }, repository: { pullRequest: { state, headRefOid: "sha1", reviews: { nodes: reviews } } } } }) }));
  return { bb, harness, store, run, sync: createReviewSync(bb, store, run) };
}

test("sync archives merged reviews and their legacy worker, but keeps the assistant chat writable", async () => {
  const { sync, store, harness } = setup("MERGED");
  await sync.all();
  expect(store.getReview("pr-1")).toMatchObject({ prState: "MERGED", archivedAt: expect.any(Number) });
  expect(harness.inspection.sdk.callsTo("threads.update")[0][0]).toEqual({ threadId: "agent-1", visibility: "hidden" });
  expect(harness.inspection.sdk.callsTo("threads.archive")).toEqual([[{ threadId: "agent-1" }]]);
  expect(store.getAssistantThread("pr-1")).toBe("assistant-1");
});

test("sync restores the viewer's approval, ignoring someone else's later review", async () => {
  const { sync, store } = setup("OPEN", [
    { state: "APPROVED", submittedAt: "2026-09-08T10:00:00Z", author: { login: "me" }, commit: { oid: "sha1" } },
    { state: "CHANGES_REQUESTED", submittedAt: "2026-09-09T10:00:00Z", author: { login: "other" }, commit: { oid: "sha1" } },
  ]);
  await sync.all();
  expect(store.getReview("pr-1")).toMatchObject({ submittedVerdict: "APPROVE", reviewer: "me", submittedHeadSha: "sha1" });
});

test("sync keeps a reviewer's archive on an open PR", async () => {
  const { sync, store } = setup("OPEN");
  store.setLifecycle("pr-1", { userArchivedAt: 5 });
  await sync.all();
  expect(store.getReview("pr-1")).toMatchObject({ prState: "OPEN", archivedAt: null, userArchivedAt: 5 });
});

test("failed refresh preserves approval and does not archive a PR", async () => {
  const { sync, store, run } = setup();
  store.setLifecycle("pr-1", { submittedVerdict: "APPROVE", submittedAt: 1 });
  run.mockResolvedValue({ code: 1, stderr: "offline", stdout: "" });
  await sync.all();
  expect(store.getReview("pr-1")).toMatchObject({ submittedVerdict: "APPROVE" });
  expect(store.getReview("pr-1")?.archivedAt).toBeFalsy();
});

test("an in-flight poll cannot overwrite a newer local submission", async () => {
  const { sync, store, run } = setup();
  let finish!: (result: any) => void;
  run.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
  const pending = sync.one("pr-1");
  await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
  store.setLifecycle("pr-1", { submittedVerdict: "APPROVE", submittedAt: Date.now() + 1 });
  finish({ code: 0, stderr: "", stdout: JSON.stringify({ data: { viewer: { login: "me" }, repository: { pullRequest: { state: "OPEN", headRefOid: "sha1", reviews: { nodes: [] } } } } }) });
  await pending;
  expect(store.getReview("pr-1")?.submittedVerdict).toBe("APPROVE");
});

test("deleted workers are detached without losing the review conversation", async () => {
  const { bb, sync, store, harness } = setup();
  bb.storage.database().prepare(`INSERT INTO agent_messages (target_key,role,text,context,created_at) VALUES ('pr-1','assistant','Keep this answer',NULL,1)`).run();
  harness.inspection.sdk.stub("threads.update", async () => { throw new Error("HTTP 404: Thread not found"); });
  await sync.all();
  expect(store.getAgentThread("pr-1")).toBeNull();
  expect(store.listAgentMessages("pr-1")[0].text).toBe("Keep this answer");
});

test("a dismissed approval returns to the review queue", async () => {
  const { sync, store } = setup("OPEN", [{ state: "DISMISSED", submittedAt: "2026-09-08T10:00:00Z", author: { login: "me" }, commit: { oid: "sha1" } }]);
  store.setLifecycle("pr-1", { submittedVerdict: "APPROVE", submittedAt: 1 });
  await sync.all();
  expect(store.getReview("pr-1")?.submittedVerdict).toBeNull();
});

test("a reply to a thread keeps your changes-requested verdict", async () => {
  const { sync, store } = setup("OPEN", [
    { state: "CHANGES_REQUESTED", submittedAt: "2026-10-01T10:00:00Z", body: "Needs work", author: { login: "me" }, commit: { oid: "sha0" }, comments: { totalCount: 2, nodes: [{ replyTo: null }] } },
    // GitHub records a thread reply as a blank COMMENTED review of its own.
    { state: "COMMENTED", submittedAt: "2026-10-02T10:00:00Z", body: "", author: { login: "me" }, commit: { oid: "sha1" }, comments: { totalCount: 1, nodes: [{ replyTo: { id: "c1" } }] } },
  ]);
  await sync.all();
  expect(store.getReview("pr-1")).toMatchObject({ submittedVerdict: "REQUEST_CHANGES", submittedHeadSha: "sha0", submittedAt: Date.parse("2026-10-01T10:00:00Z") });
});
