import { test, expect } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import plugin from "../server";
import { createStore } from "./store";
import { withReviewAgentTurn } from "./agent-coordination";

async function setup() {
  const { bb, harness } = createFakePluginHost({ pluginId: "guided-review", sdk: { threads: { stop: async () => ({}), delete: async () => ({ ok: true }) } } });
  await plugin(bb);
  const store = createStore(bb);
  for (const key of ["pr-1", "pr-2"]) {
    store.saveReview({ targetKey: key, kind: "pr", number: 1, repo: "acme/web", status: "ready", createdAt: 1 });
    store.appendAgentMessage(key, "user", "question");
    store.setAgentThread(key, `worker-${key}`);
  }
  return { bb, harness, store };
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
  expect(store.getAgentThread("pr-2")).toBe("worker-pr-2");
  expect(await bb.storage.kv.list("needs-you:")).toEqual(["needs-you:clock:pr-2"]);
  expect(harness.inspection.sdk.callsTo("threads.stop")).toEqual([[{ threadId: "worker-pr-1" }]]);
  expect(harness.inspection.sdk.callsTo("threads.delete")).toEqual([[{ threadId: "worker-pr-1", childThreadsConfirmed: false }]]);
  expect(harness.inspection.realtimeSignals.map((s) => s.channel)).toEqual(expect.arrayContaining(["reviews", "review:pr-1"]));

  // Repeating the delete (another window, double click) is harmless.
  expect(await harness.behavior.callRpc("deleteReview", { targetKey: "pr-1" })).toEqual({ ok: true });
  expect(harness.inspection.sdk.callsTo("threads.delete")).toHaveLength(1);
});

test("a missing worker thread doesn't block deleting the review", async () => {
  const { harness, store } = await setup();
  harness.inspection.sdk.stub("threads.delete", async () => { throw new Error("HTTP 404: Thread not found"); });
  expect(await harness.behavior.callRpc("deleteReview", { targetKey: "pr-1" })).toEqual({ ok: true });
  expect(store.getReview("pr-1")).toBeNull();
  expect(harness.inspection.logEntries.filter((entry) => entry.level === "warn")).toEqual([]);
});

test("a review can't be deleted while its guide is generating or an answer is in progress", async () => {
  const { bb, harness, store } = await setup();
  store.beginGeneration("pr-1");
  expect(await harness.behavior.callRpc("deleteReview", { targetKey: "pr-1" })).toMatchObject({ ok: false, error: expect.stringContaining("generating") });
  expect(store.getReview("pr-1")).not.toBeNull();

  let finish!: () => void;
  const turn = withReviewAgentTurn(bb, "pr-2", () => new Promise<void>((resolve) => { finish = resolve; }));
  expect(await harness.behavior.callRpc("deleteReview", { targetKey: "pr-2" })).toMatchObject({ ok: false, error: expect.stringContaining("assistant") });
  expect(store.getReview("pr-2")).not.toBeNull();
  finish();
  await turn;
  expect(await harness.behavior.callRpc("deleteReview", { targetKey: "pr-2" })).toEqual({ ok: true });
  expect(harness.inspection.sdk.callsTo("threads.delete")).toEqual([[{ threadId: "worker-pr-2", childThreadsConfirmed: false }]]);
});
