import { expect, test, vi } from "vitest";
import { createFakePluginHost, makeQueueEntry, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import plugin from "../server";
import { createStore } from "./store";
import { runGh } from "./gh";

vi.mock("./gh", async (original) => ({ ...await original<typeof import("./gh")>(), runGh: vi.fn() }));

const patch = [
  "diff --git a/a.ts b/a.ts", "--- a/a.ts", "+++ b/a.ts", "@@ -1,3 +1,4 @@",
  " const a = 1;", "-const b = 2;", "+const b = 3;", "+const c = b * 2;", " export { a };", "",
].join("\n");
const at = { file: "a.ts", line: 3, side: "RIGHT" } as const;

async function host({ conversation = true } = {}) {
  const { bb, harness } = createFakePluginHost({ pluginId: "guided-review", sdk: {
    threads: {
      get: async () => ({ archivedAt: null, deletedAt: null, status: "idle" }),
      send: async () => ({ delivery: "sent" }),
      spawn: async () => ({ id: "assistant" }),
      archive: async () => ({}),
      queuedMessages: { list: async () => [] },
    },
    projects: { defaultExecutionOptions: async () => ({ providerId: "claude-code", model: "opus", reasoningLevel: "high" }) },
  } as any });
  await plugin(bb);
  const store = createStore(bb);
  store.saveReview({ targetKey: "pr-1", kind: "pr", number: 1, repo: "acme/web", status: "ready", createdAt: 1, headSha: "sha1", projectId: "p1" });
  store.savePatch("pr-1", patch);
  if (conversation) store.setAssistantThread("pr-1", "assistant");
  const ask = (input: Record<string, unknown>) => harness.behavior.callRpc("askAgent", { targetKey: "pr-1", ...at, ...input }) as Promise<any>;
  const tool = (name: string, input: Record<string, unknown>) => harness.behavior.callAgentTool(name, input, { threadId: "assistant" }) as Promise<any>;
  const sent = () => harness.inspection.sdk.callsTo("threads.send").map(([args]) => args as any);
  const signals = (channel: string) => harness.inspection.realtimeSignals.filter((signal) => signal.channel === channel).length;
  return { harness, store, ask, tool, sent, signals };
}

test("asking about a draft comment sends the reviewer's message to the assistant, with what only it needs, and waits for an answer", async () => {
  const { store, ask, tool, sent } = await host();
  await tool("add_draft_comment", { ...at, code: "const c = b * 2;", body: "Can this overflow?" });
  const result = await ask({ body: "It can't: b is 3." });
  expect(result.discussions).toEqual([{ ...at, waiting: true, entries: [{ author: "reviewer", kind: "message", body: "It can't: b is 3.", createdAt: expect.any(Number) }] }]);
  const [message] = sent();
  expect(message).toMatchObject({ threadId: "assistant", mode: "queue-if-active", input: [{ type: "text", text: "On `a.ts:3`: It can't: b is 3." }, { type: "text", visibility: "agent-only" }] });
  const context: string = message.input[1].text;
  for (const part of ["reviewer's discussion at a.ts:3 (RIGHT side)", 'reply_in_discussion on file "a.ts", line 3, side RIGHT', "edit_draft_comment or delete_draft_comment", "added by an agent:\nCan this overflow?", "+const c = b * 2;", "one short line"]) expect(context).toContain(part);
  // The draft itself doesn't change, and nothing reaches GitHub.
  expect(store.getDraft("pr-1").comments).toEqual([{ ...at, author: "agent", body: "Can this overflow?" }]);
  expect(runGh).not.toHaveBeenCalled();
});

test("the assistant answers in the discussion, and later messages carry the discussion so far", async () => {
  const { store, ask, tool, sent, signals } = await host();
  await ask({ body: "Why is b 3 now?" });
  expect(await tool("reply_in_discussion", { file: "a.ts", line: 3, body: " The PR description says the default changed. " })).toBe("Replied in the discussion on a.ts:3. The reviewer reads it there.");
  expect(signals("draft:pr-1")).toBe(1);
  const [discussion] = store.listDiscussions("pr-1");
  expect(discussion.waiting).toBe(false);
  expect(discussion.entries.map(({ author, body }) => [author, body])).toEqual([["reviewer", "Why is b 3 now?"], ["agent", "The PR description says the default changed."]]);
  await ask({ body: "Then comment on it." });
  expect(sent()[1].input[1].text).toContain("There is no draft comment there.");
  expect(sent()[1].input[1].text).toContain("Earlier in this discussion:\nReviewer: Why is b 3 now?\nYou: The PR description says the default changed.");
  // The reviewer starts discussions; elsewhere the assistant answers in the chat.
  const elsewhere = await tool("reply_in_discussion", { file: "a.ts", line: 2, side: "LEFT", body: "Hm" });
  expect(elsewhere.content[0].text).toBe("There's no discussion on a.ts:2 (LEFT side). The reviewer starts discussions; answer other messages in the chat.");
});

test("a question about selected lines quotes them, and the comment the assistant adds there joins the discussion", async () => {
  const { store, ask, tool, sent } = await host();
  await ask({ startLine: 2, body: "Is c needed?" });
  const [message] = sent();
  expect(message.input[0].text).toBe("On `a.ts:2–3`: Is c needed?");
  expect(message.input[1].text).toContain("+const b = 3;\n+const c = b * 2;");
  expect(message.input[1].text).toContain("If they ask for a draft comment there, add it with add_draft_comment.");
  await tool("add_draft_comment", { ...at, code: "const c = b * 2;", body: "c is unused." });
  expect(store.listDiscussions("pr-1")).toEqual([{ ...at, startLine: 2, waiting: false, entries: [
    expect.objectContaining({ author: "reviewer", kind: "message" }), expect.objectContaining({ author: "agent", kind: "added", body: "" }),
  ] }]);
  // A follow-up still quotes the lines first asked about.
  await ask({ body: "Thanks" });
  expect(sent()[1].input[0].text).toBe("On `a.ts:2–3`: Thanks");
});

test("a comment the assistant removes keeps its discussion until dismissed; the reviewer's Remove takes both", async () => {
  const { store, ask, tool, harness } = await host();
  await tool("add_draft_comment", { ...at, code: "const c = b * 2;", body: "Can this overflow?" });
  await ask({ body: "Shorter, please." });
  await tool("edit_draft_comment", { ...at, body: "Overflow?" });
  expect(store.listDiscussions("pr-1")[0]).toMatchObject({ waiting: false, entries: [{ kind: "message" }, { author: "agent", kind: "edited" }] });
  await tool("delete_draft_comment", at);
  expect(store.getDraft("pr-1").comments).toEqual([]);
  expect(store.listDiscussions("pr-1")[0].entries.map((entry) => entry.kind)).toEqual(["message", "edited", "removed"]);
  expect((await harness.behavior.callRpc("dismissDiscussion", { targetKey: "pr-1", ...at }) as any).discussions).toEqual([]);

  const mine = { file: "a.ts", line: 2, side: "LEFT" } as const;
  store.upsertDraftComment("pr-1", { ...mine, body: "Why change b?" });
  await ask({ ...mine, body: "Is this clear?" });
  const removed = await harness.behavior.callRpc("removeDraftComment", { targetKey: "pr-1", ...mine }) as any;
  expect(removed.discussions).toEqual([]);
});

test("once the assistant finishes without answering, the discussion stops waiting, unless a queued message is next", async () => {
  const { store, ask, harness, signals } = await host();
  await ask({ body: "Why?" });
  harness.inspection.sdk.stub("threads.queuedMessages.list", async () => [makeQueueEntry()]);
  await harness.behavior.emitThreadEvent("thread.idle", { thread: makeThreadResponse({ id: "assistant" }), lastAssistantText: "Earlier work" });
  expect(store.listDiscussions("pr-1")[0].waiting).toBe(true);
  harness.inspection.sdk.stub("threads.queuedMessages.list", async () => []);
  await harness.behavior.emitThreadEvent("thread.idle", { thread: makeThreadResponse({ id: "assistant" }), lastAssistantText: "Answered in the chat" });
  expect(store.listDiscussions("pr-1")[0].waiting).toBe(false);
  expect(signals("draft:pr-1")).toBe(1);
  // Another thread finishing changes nothing.
  await ask({ body: "Still there?" });
  await harness.behavior.emitThreadEvent("thread.failed", { thread: makeThreadResponse({ id: "someone-else" }), error: null });
  expect(store.listDiscussions("pr-1")[0].waiting).toBe(true);
  await harness.behavior.emitThreadEvent("thread.failed", { thread: makeThreadResponse({ id: "assistant" }), error: "Rate limited" });
  expect(store.listDiscussions("pr-1")[0].waiting).toBe(false);
});

test("without a conversation, asking starts one on the default agent; a new conversation stops waiting", async () => {
  const { store, ask, harness, signals } = await host({ conversation: false });
  await ask({ body: "What does this do?" });
  const [spawn] = harness.inspection.sdk.callsTo("threads.spawn")[0] as [any];
  expect(spawn).toMatchObject({ title: "Review agent: pr-1", model: "opus", input: [{ type: "text", text: "On `a.ts:3`: What does this do?" }, { type: "text", visibility: "agent-only" }] });
  expect(store.getAssistantThread("pr-1")).toBe("assistant");
  expect(signals("conversation:pr-1")).toBe(1);
  await harness.behavior.callRpc("newConversation", { targetKey: "pr-1" });
  expect(store.listDiscussions("pr-1")[0].waiting).toBe(false);
  expect(signals("draft:pr-1")).toBe(1);
});

test("a merged PR's discussions take no new messages", async () => {
  const { store, ask, sent } = await host();
  store.setLifecycle("pr-1", { prState: "MERGED" });
  await expect(ask({ body: "Why?" })).rejects.toThrow("This PR is merged, so its draft can't be submitted.");
  expect(sent()).toEqual([]);
  expect(store.listDiscussions("pr-1")).toEqual([]);
});
