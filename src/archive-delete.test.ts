import { test, expect } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import plugin from "../server";
import { createStore } from "./store";

async function setup() {
  const answering = new Set<string>();
  const { bb, harness } = createFakePluginHost({ pluginId: "guided-review", sdk: { threads: {
    stop: async () => ({}), delete: async () => ({ ok: true }),
    get: async ({ threadId }: { threadId: string }) => ({ archivedAt: null, deletedAt: null, status: answering.has(threadId) ? "active" : "idle" }),
  } } });
  await plugin(bb);
  const store = createStore(bb);
  for (const key of ["pr-1", "pr-2"]) {
    store.saveReview({ targetKey: key, kind: "pr", number: 1, repo: "acme/web", status: "ready", createdAt: 1 });
    store.setAssistantThread(key, `assistant-${key}`);
    // A legacy conversation, from before conversations moved into bb threads.
    bb.storage.database().prepare(`INSERT INTO agent_messages (target_key,role,text,context,created_at) VALUES (?,'user','question',NULL,1)`).run(key);
    bb.storage.database().prepare(`INSERT INTO agent_threads (target_key,thread_id,created_at) VALUES (?,?,1)`).run(key, `worker-${key}`);
  }
  return { bb, harness, store, answering };
}

test("archiving moves a review out of the queue until it is unarchived, keeping GitHub state", async () => {
  const { bb, harness, store } = await setup();
  store.setLifecycle("pr-1", { prState: "OPEN", archivedAt: null });
  expect(await harness.behavior.callRpc("archiveReview", { targetKey: "pr-1", archived: true })).toEqual({ ok: true });
  expect(store.getReview("pr-1")).toMatchObject({ userArchivedAt: expect.any(Number), archivedAt: null, prState: "OPEN" });
  expect(harness.inspection.realtimeSignals.map((s) => s.channel)).toEqual(expect.arrayContaining(["reviews", "review:pr-1"]));
  expect(await harness.behavior.callRpc("archiveReview", { targetKey: "pr-1", archived: false })).toEqual({ ok: true });
  expect(store.getReview("pr-1")?.userArchivedAt).toBeNull();

  expect(await harness.behavior.callRpc("archiveReview", { targetKey: "missing", archived: true })).toMatchObject({ ok: false });
  expect(bb.storage.database().prepare(`SELECT COUNT(*) AS n FROM review_lifecycle WHERE target_key='missing'`).get()).toEqual({ n: 0 });
});

test("deleting a review removes its data, queued notification, and hidden worker, and nothing else", async () => {
  const { bb, harness, store } = await setup();
  await bb.storage.kv.set("needs-you:pending:pr-1", { targetKey: "pr-1" });
  await bb.storage.kv.set("needs-you:clock:pr-1", 5);
  await bb.storage.kv.set("needs-you:clock:pr-2", 5);

  expect(await harness.behavior.callRpc("deleteReview", { targetKey: "pr-1" })).toEqual({ ok: true });
  expect(store.getReview("pr-1")).toBeNull();
  expect(store.listAgentMessages("pr-1")).toEqual([]);
  expect(store.getReview("pr-2")).not.toBeNull();
  expect(store.getAssistantThread("pr-2")).toBe("assistant-pr-2");
  expect(store.getAgentThread("pr-2")).toBe("worker-pr-2");
  expect(await bb.storage.kv.list("needs-you:")).toEqual(["needs-you:clock:pr-2"]);
  expect(harness.inspection.sdk.callsTo("threads.stop")).toEqual([[{ threadId: "assistant-pr-1" }], [{ threadId: "worker-pr-1" }]]);
  expect(harness.inspection.sdk.callsTo("threads.delete")).toEqual([[{ threadId: "assistant-pr-1", childThreadsConfirmed: false }], [{ threadId: "worker-pr-1", childThreadsConfirmed: false }]]);
  expect(harness.inspection.realtimeSignals.map((s) => s.channel)).toEqual(expect.arrayContaining(["reviews", "review:pr-1"]));

  // Repeating the delete (another window, double click) is harmless.
  expect(await harness.behavior.callRpc("deleteReview", { targetKey: "pr-1" })).toEqual({ ok: true });
  expect(harness.inspection.sdk.callsTo("threads.delete")).toHaveLength(2);
});

test("a missing worker thread doesn't block deleting the review", async () => {
  const { harness, store } = await setup();
  harness.inspection.sdk.stub("threads.delete", async () => { throw new Error("HTTP 404: Thread not found"); });
  expect(await harness.behavior.callRpc("deleteReview", { targetKey: "pr-1" })).toEqual({ ok: true });
  expect(store.getReview("pr-1")).toBeNull();
  expect(harness.inspection.logEntries.filter((entry) => entry.level === "warn")).toEqual([]);
});

test("a review can't be deleted while its guide is generating or an answer is in progress", async () => {
  const { harness, store, answering } = await setup();
  store.beginGeneration("pr-1");
  expect(await harness.behavior.callRpc("deleteReview", { targetKey: "pr-1" })).toMatchObject({ ok: false, error: expect.stringContaining("generating") });
  expect(store.getReview("pr-1")).not.toBeNull();

  answering.add("assistant-pr-2");
  expect(await harness.behavior.callRpc("deleteReview", { targetKey: "pr-2" })).toMatchObject({ ok: false, error: expect.stringContaining("assistant") });
  expect(store.getReview("pr-2")).not.toBeNull();
  answering.delete("assistant-pr-2");
  expect(await harness.behavior.callRpc("deleteReview", { targetKey: "pr-2" })).toEqual({ ok: true });
  expect(harness.inspection.sdk.callsTo("threads.delete").map(([args]) => (args as any).threadId)).toEqual(["assistant-pr-2", "worker-pr-2"]);
});
