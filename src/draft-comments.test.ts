import { expect, test, vi } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import plugin from "../server";
import { createStore } from "./store";
import { runGh } from "./gh";

vi.mock("./gh", async (original) => ({ ...await original<typeof import("./gh")>(), runGh: vi.fn() }));

const patch = [
  "diff --git a/a.ts b/a.ts", "--- a/a.ts", "+++ b/a.ts", "@@ -1,3 +1,4 @@",
  " const a = 1;", "-const b = 2;", "+const b = 3;", "+const c = b * 2;", " export { a };", "",
].join("\n");

async function host() {
  const { bb, harness } = createFakePluginHost({ pluginId: "guided-review" });
  await plugin(bb);
  const store = createStore(bb);
  store.saveReview({ targetKey: "pr-1", kind: "pr", number: 1, repo: "acme/web", status: "ready", createdAt: 1, headSha: "sha1" });
  store.savePatch("pr-1", patch);
  store.setAssistantThread("pr-1", "assistant");
  const call = (tool: string, input: Record<string, unknown>, threadId = "assistant") => harness.behavior.callAgentTool(tool, input, { threadId });
  const add = (input: Record<string, unknown>, threadId?: string) => call("add_draft_comment", input, threadId);
  const error = (result: any) => (result.isError ? result.content[0].text : null) as string | null;
  const signals = () => harness.inspection.realtimeSignals.filter((signal) => signal.channel === "draft:pr-1").length;
  return { harness, store, call, add, error, signals };
}

test("the assistant adds comments to its own review's local draft, and nothing reaches GitHub", async () => {
  const { store, add, error, signals } = await host();
  expect(await add({ file: "a.ts", line: 3, code: "  const c = b * 2; ", body: " Can this overflow? " })).toBe("Added a draft comment on a.ts:3. It stays in bb until the reviewer submits the review.");
  expect(error(await add({ file: "a.ts", line: 2, side: "LEFT", code: "const b = 2;", body: "Why change b?" }))).toBeNull();
  expect(store.getDraft("pr-1").comments).toEqual([
    { file: "a.ts", line: 3, side: "RIGHT", author: "agent", body: "Can this overflow?" },
    { file: "a.ts", line: 2, side: "LEFT", author: "agent", body: "Why change b?" },
  ]);
  // Bound to the current diff, so submission accepts them.
  expect(store.staleDraftComments("pr-1")).toEqual([]);
  expect(signals()).toBe(2);
  expect(runGh).not.toHaveBeenCalled();
});

test("a miscounted or out-of-diff line is refused with where its code is", async () => {
  const { store, add, error } = await host();
  expect(error(await add({ file: "a.ts", line: 2, code: "const c = b * 2;", body: "x" })))
    .toBe("Line 2 on the RIGHT side of a.ts is `const b = 3;`. The code you sent is on line 3. Nothing was added.");
  expect(error(await add({ file: "a.ts", line: 40, code: "const c = b * 2;", body: "x" }))).toMatch(/^Line 40 isn't on the RIGHT side of a.ts in this diff. The code you sent is on line 3/);
  expect(error(await add({ file: "a.ts", line: 2, side: "LEFT", code: "const c = b * 2;", body: "x" }))).toContain("isn't on the LEFT side of a.ts");
  expect(error(await add({ file: "b.ts", line: 1, code: "x", body: "x" }))).toContain("b.ts isn't in this review's diff");
  await expect(add({ file: "a.ts", line: 3, code: "const c = b * 2;", body: "   " })).rejects.toThrow();
  expect(store.getDraft("pr-1").comments).toEqual([]);
});

test("adding never replaces a comment; editing and deleting change only the one at that location", async () => {
  const { store, call, add, error, signals } = await host();
  store.upsertDraftComment("pr-1", { file: "a.ts", line: 3, side: "RIGHT", chapterId: "c1", body: "Mine" });
  store.upsertDraftComment("pr-1", { file: "a.ts", line: 2, side: "LEFT", author: "agent", body: "Theirs" });
  expect(error(await add({ file: "a.ts", line: 3, code: "const c = b * 2;", body: "New" }))).toContain('already has a draft comment: "Mine"');
  expect(await call("list_draft_comments", {})).toBe([
    "2 draft comments:",
    "a.ts:3 RIGHT · added by the reviewer\n  Mine",
    "a.ts:2 LEFT · added by an agent\n  Theirs",
  ].join("\n"));

  // An edit keeps the location, who added it, and the diff it was drafted against.
  store.savePatch("pr-1", patch.replace("export { a };", "export { a, b };"));
  expect(await call("edit_draft_comment", { file: "a.ts", line: 3, body: "Mine, reworded" })).toBe("Updated the draft comment on a.ts:3.");
  expect(store.getDraft("pr-1").comments[0]).toEqual({ file: "a.ts", line: 3, side: "RIGHT", chapterId: "c1", body: "Mine, reworded" });
  expect(store.staleDraftComments("pr-1")).toHaveLength(2);
  expect(await call("list_draft_comments", {})).toContain("added by the reviewer · drafted against an older diff, so submitting refuses it\n  Mine, reworded");
  expect(error(await call("edit_draft_comment", { file: "a.ts", line: 2, body: "x" }))).toBe("There's no draft comment on a.ts:2.");

  expect(await call("delete_draft_comment", { file: "a.ts", line: 2, side: "LEFT" })).toBe("Deleted the draft comment on a.ts:2 (LEFT side).");
  expect(error(await call("delete_draft_comment", { file: "a.ts", line: 2, side: "LEFT" }))).toBe("There's no draft comment on a.ts:2 (LEFT side).");
  expect(store.getDraft("pr-1").comments.map((c) => c.body)).toEqual(["Mine, reworded"]);
  expect(signals()).toBe(2);
  expect(runGh).not.toHaveBeenCalled();
});

test("only a review's current assistant changes its draft, and only while the draft can be submitted", async () => {
  const { store, call, add, error } = await host();
  const comment = { file: "a.ts", line: 3, code: "const c = b * 2;", body: "x" };
  for (const [tool, input] of [["list_draft_comments", {}], ["add_draft_comment", comment], ["edit_draft_comment", { file: "a.ts", line: 3, body: "x" }], ["delete_draft_comment", { file: "a.ts", line: 3 }]] as const) {
    expect(error(await call(tool, input, "another-thread"))).toContain("no longer a review's assistant");
  }
  store.setStatus("pr-1", "generating");
  expect(error(await add(comment))).toContain("being regenerated");
  store.setStatus("pr-1", "ready");
  store.setLifecycle("pr-1", { prState: "MERGED", archivedAt: 1 });
  expect(error(await add(comment))).toContain("merged");
  expect(error(await call("delete_draft_comment", { file: "a.ts", line: 3 }))).toContain("merged");
  expect(store.getDraft("pr-1").comments).toEqual([]);
});

test("the panel removes a comment by its location, so an agent's delete can't shift it", async () => {
  const { harness, store } = await host();
  store.upsertDraftComment("pr-1", { file: "a.ts", line: 3, side: "RIGHT", body: "First" });
  store.upsertDraftComment("pr-1", { file: "a.ts", line: 2, side: "LEFT", body: "Second" });
  const remove = (line: number, side: string) => harness.behavior.callRpc("removeDraftComment", { targetKey: "pr-1", file: "a.ts", line, side }) as Promise<any>;
  expect((await remove(2, "LEFT")).draft.comments.map((c: any) => c.body)).toEqual(["First"]);
  expect((await remove(2, "LEFT")).draft.comments.map((c: any) => c.body)).toEqual(["First"]);
});
