import { test, expect, vi } from "vitest";

vi.mock("./gh", async (orig) => {
  const real = await orig<any>();
  return {
    ...real,
    runGh: vi.fn(async (args: string[]) => {
      if (args[0] === "repo") return { stdout: JSON.stringify({ nameWithOwner: "acme/web" }), stderr: "", code: 0 };
      if (args[1] === "view") return { stdout: JSON.stringify({ number: 7, headRefOid: "abc123", title: "Fix", body: "b", author: { login: "a" }, baseRefName: "main", headRefName: "f", url: "u" }), stderr: "", code: 0 };
      if (args[1] === "diff") return { stdout: "--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-o\n+n\n", stderr: "", code: 0 };
      return { stdout: "", stderr: "", code: 0 };
    }),
    runGit: vi.fn(async () => ({ stdout: "", stderr: "", code: 0 })),
  };
});

import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { createStore } from "./store";
import { runReviewCommand } from "./review-command";
import { defaultPreferences } from "./preferences";
import * as gh from "./gh";
import { targetKey } from "./targets";
const key = targetKey({ kind: "pr", number: 7, repo: "acme/web" });

test("bb review <number> fetches, stores patch+meta, and kicks generation", async () => {
  const { bb, harness } = createFakePluginHost({
    pluginId: "guided-review",
    sdk: { threads: { spawn: async () => ({ id: "th_1" }), wait: async () => {}, archive: async () => {}, stop: async () => {} } },
  });
  const store = createStore(bb);
  const res = await runReviewCommand({ bb, store, gh }, ["7"], { projectId: "p1", cwd: "/repo" });
  expect(res.exitCode).toBe(0);
  const meta = store.getReview(key);
  expect(meta?.repo).toBe("acme/web");
  expect(store.readPatch(key).text).toContain("diff --git a/a.ts");
});

test("bb review reports an offline guide writer machine without starting a review", async () => {
  const { bb } = createFakePluginHost({ pluginId: "guided-review", sdk: { hosts: { get: async () => ({ id: "host_flomac", name: "FloMac", status: "disconnected", lifecycle: { phase: "active" } }) } } });
  const store = createStore(bb);
  store.savePreferences({ ...defaultPreferences, guideAgent: { hostId: "host_flomac", providerId: "codex", model: "gpt-6", reasoningLevel: "low", permissionMode: "auto" } }, 0);
  expect(await runReviewCommand({ bb, store, gh }, ["7"], { projectId: "p1", cwd: "/repo" }))
    .toEqual({ exitCode: 1, stderr: "FloMac is offline. Wake it, or choose another machine for the guide writer in Review settings." });
  expect(store.getReview(key)).toBeNull();
});

test("bb review --help names both forms without starting a review", async () => {
  const { bb } = createFakePluginHost({ pluginId: "guided-review" });
  const store = createStore(bb);
  for (const argv of [["--help"], ["-h"], ["main", "--help"]]) {
    expect(await runReviewCommand({ bb, store, gh }, argv, { projectId: "p1", cwd: "/repo" })).toMatchObject({ exitCode: 0, stdout: expect.stringContaining("bb review comment") });
  }
  expect(store.listReviews()).toEqual([]);
});
