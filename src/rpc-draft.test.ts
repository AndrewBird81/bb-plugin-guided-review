import { test, expect, vi } from "vitest";

// `submit` must exist before the `vi.mock` factory below runs (module
// evaluation for "../server" — and transitively "./gh" — happens before any
// of this file's own top-level statements). `vi.hoisted` guarantees that.
const { submit } = vi.hoisted(() => ({
  submit: vi.fn(async () => ({ stdout: "{}", stderr: "", code: 0 })),
}));

vi.mock("./gh", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./gh")>();
  return {
    ...actual,
    runGh: (args: string[]) =>
      // `ghSubmitReviewArgs` produces the path as a single element like
      // "repos/acme/web/pulls/1/reviews" — `args.includes("reviews")` (exact
      // element match) never matches that; check for a substring instead.
      args[0] === "auth" ? Promise.resolve({ stdout: "test-token", stderr: "", code: 0 }) : args[1] === "user" ? Promise.resolve({ stdout: "casey", stderr: "", code: 0 }) : args.some((a) => a.includes("reviews")) ? submit(args) : Promise.resolve({ stdout: JSON.stringify({ headRefOid: "sha123" }), stderr: "", code: 0 }),
  };
});

import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import plugin from "../server";
import { createStore } from "./store";

test("draft comment then submit builds a batched review", async () => {
  const { bb, harness } = createFakePluginHost({ pluginId: "guided-review" });
  await plugin(bb);
  const store = createStore(bb);
  store.saveReview({ targetKey: "pr-1", kind: "pr", number: 1, repo: "acme/web", headSha: "sha123", status: "ready", createdAt: 1 });
  store.savePatch("pr-1", "diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -0,0 +1,2 @@\n+one\n+two\n");
  const { revision } = await harness.behavior.callRpc("getReviewBundle", { targetKey: "pr-1" }) as any;
  await harness.behavior.callRpc("saveDraftComment", {
    revision,
    targetKey: "pr-1",
    comment: { file: "a.ts", line: 1, side: "RIGHT", body: "nit" },
  });
  await harness.behavior.callRpc("setVerdict", { targetKey: "pr-1", revision, verdict: "COMMENT", body: "ok" });
  const res = await harness.behavior.callRpc("submitReview", { targetKey: "pr-1", revision, account: "casey" });
  expect((res as any).ok).toBe(true);
  expect(submit).toHaveBeenCalled();
});

test("draft reads and writes report comments drafted against an older diff", async () => {
  const { bb, harness } = createFakePluginHost({ pluginId: "guided-review" });
  await plugin(bb);
  const store = createStore(bb);
  store.saveReview({ targetKey: "pr-2", kind: "pr", number: 2, repo: "acme/web", headSha: "sha123", status: "ready", createdAt: 1 });
  store.savePatch("pr-2", "diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -0,0 +1,2 @@\n+one\n+two\n");
  const revisionOf = async () => ((await harness.behavior.callRpc("getReviewBundle", { targetKey: "pr-2" })) as any).revision;
  const comment = { file: "a.ts", line: 1, side: "RIGHT", body: "nit" };
  const saved = await harness.behavior.callRpc("saveDraftComment", { targetKey: "pr-2", revision: await revisionOf(), comment }) as any;
  expect(saved.stale).toEqual([]);

  store.savePatch("pr-2", "diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -0,0 +1,3 @@\n+one\n+two\n+three\n");
  expect((await harness.behavior.callRpc("getDraft", { targetKey: "pr-2" }) as any).stale).toEqual([{ file: "a.ts", line: 1, side: "RIGHT" }]);

  // Saving it again binds it to the current diff.
  const resaved = await harness.behavior.callRpc("saveDraftComment", { targetKey: "pr-2", revision: await revisionOf(), comment: { ...comment, body: "Still a nit" } }) as any;
  expect(resaved.stale).toEqual([]);
  const removed = await harness.behavior.callRpc("removeDraftComment", { targetKey: "pr-2", file: "a.ts", line: 1, side: "RIGHT" }) as any;
  expect(removed).toMatchObject({ draft: { comments: [] }, stale: [] });
});
