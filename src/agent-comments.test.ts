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
  const add = (input: Record<string, unknown>, threadId = "assistant") => harness.behavior.callAgentTool("add_draft_comment", input, { threadId });
  const error = (result: any) => (result.isError ? result.content[0].text : null) as string | null;
  return { harness, store, add, error };
}

test("the assistant adds comments to its own review's local draft, and nothing reaches GitHub", async () => {
  const { harness, store, add, error } = await host();
  expect(await add({ file: "a.ts", line: 3, code: "  const c = b * 2; ", body: " Can this overflow? " })).toContain("Added to the reviewer's draft");
  expect(error(await add({ file: "a.ts", line: 2, side: "LEFT", code: "const b = 2;", body: "Why change b?" }))).toBeNull();
  expect(store.getDraft("pr-1").comments).toEqual([
    { file: "a.ts", line: 3, side: "RIGHT", body: "Can this overflow?" },
    { file: "a.ts", line: 2, side: "LEFT", body: "Why change b?" },
  ]);
  // Bound to the current diff, so submission accepts them.
  expect(store.staleDraftComments("pr-1")).toEqual([]);
  expect(harness.inspection.realtimeSignals.filter((signal) => signal.channel === "draft:pr-1")).toHaveLength(2);
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

test("a comment already on that line is never replaced", async () => {
  const { store, add, error } = await host();
  store.upsertDraftComment("pr-1", { file: "a.ts", line: 3, side: "RIGHT", chapterId: "c1", body: "Mine" });
  expect(error(await add({ file: "a.ts", line: 3, code: "const c = b * 2;", body: "Theirs" }))).toContain('already has a draft comment: "Mine"');
  expect(store.getDraft("pr-1").comments).toEqual([{ file: "a.ts", line: 3, side: "RIGHT", chapterId: "c1", body: "Mine" }]);
});

test("only a review's current assistant adds comments, and only while its draft can be submitted", async () => {
  const { store, add, error } = await host();
  const comment = { file: "a.ts", line: 3, code: "const c = b * 2;", body: "x" };
  expect(error(await add(comment, "another-thread"))).toContain("no longer a review's assistant");
  store.setStatus("pr-1", "generating");
  expect(error(await add(comment))).toContain("being regenerated");
  store.setStatus("pr-1", "ready");
  store.setLifecycle("pr-1", { prState: "MERGED", archivedAt: 1 });
  expect(error(await add(comment))).toContain("merged");
  expect(store.getDraft("pr-1").comments).toEqual([]);
});
