import { test, expect, vi } from "vitest";

vi.mock("./gh", async (orig) => {
  const real = await orig<any>();
  return {
    ...real,
    runGh: vi.fn(async (args: string[]) => {
      if (args[1] === "diff") return { stdout: "--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-o\n+n\n", stderr: "", code: 0 };
      if (args[1] === "view") return { stdout: JSON.stringify({ headRefOid: "newsha", title: "PR", baseRefName: "main", headRefName: "feature", url: "https://github.com/acme/web/pull/7" }), stderr: "", code: 0 };
      return { stdout: "", stderr: "", code: 0 };
    }),
    runGit: vi.fn(async () => ({ stdout: "--- a/b.ts\n+++ b/b.ts\n@@ -1 +1 @@\n-o\n+n\n", stderr: "", code: 0 })),
  };
});

import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { createStore } from "./store";
import { rerunReview } from "./rereview";
import { defaultPreferences } from "./preferences";
import * as gh from "./gh";

function host() {
  return createFakePluginHost({
    pluginId: "guided-review",
    sdk: { threads: { spawn: async () => ({ id: "th_1" }), wait: async () => {}, archive: async () => {}, stop: async () => {} } },
  });
}

test("rerunReview re-fetches a PR diff, re-saves patch, sets generating, and returns ok", async () => {
  const { bb } = host();
  const store = createStore(bb);
  store.saveReview({
    targetKey: "pr-7", kind: "pr", number: 7, repo: "acme/web", status: "ready", createdAt: 1,
    projectId: "p1", headSha: "oldsha", gitRef: "main...feature",
  });
  store.savePatch("pr-7", "stale patch");

  const res = await rerunReview({ bb, store, gh }, "pr-7");

  expect(res).toEqual({ ok: true });
  expect(store.readPatch("pr-7").text).toContain("diff --git a/a.ts");
  const meta = store.getReview("pr-7");
  expect(meta?.headSha).toBe("newsha");
});

test("rerunReview re-fetches a local-ref diff via git when cwd is present", async () => {
  const { bb } = host();
  const store = createStore(bb);
  store.saveReview({
    targetKey: "ref-abc", kind: "ref", status: "ready", createdAt: 1,
    projectId: "p1", gitRef: "main...feature", cwd: "/repo",
  });
  store.savePatch("ref-abc", "stale patch");

  const res = await rerunReview({ bb, store, gh }, "ref-abc");

  expect(res).toEqual({ ok: true });
  expect(store.readPatch("ref-abc").text).toContain("diff --git a/b.ts");
  expect(store.getReview("ref-abc")?.status).toBe("generating");
});

test("rerunReview fails a local-ref review with no stored cwd", async () => {
  const { bb } = host();
  const store = createStore(bb);
  store.saveReview({
    targetKey: "ref-abc", kind: "ref", status: "ready", createdAt: 1,
    projectId: "p1", gitRef: "main...feature",
  });

  const res = await rerunReview({ bb, store, gh }, "ref-abc");

  expect(res.ok).toBe(false);
  expect(res.error).toMatch(/working dir/i);
});

test("rerunReview fails for an unknown target", async () => {
  const { bb } = host();
  const store = createStore(bb);
  const res = await rerunReview({ bb, store, gh }, "missing");
  expect(res.ok).toBe(false);
});

test("rerunReview leaves the review as it was when the guide writer's machine is offline", async () => {
  const { bb } = createFakePluginHost({ pluginId: "guided-review", sdk: { hosts: { get: async () => ({ id: "host_flomac", name: "FloMac", status: "disconnected", lifecycle: { phase: "active" } }) } } });
  const store = createStore(bb);
  store.saveReview({ targetKey: "pr-7", kind: "pr", number: 7, repo: "acme/web", status: "ready", createdAt: 1, projectId: "p1", headSha: "oldsha", gitRef: "main...feature" });
  store.savePatch("pr-7", "stale patch");
  store.savePreferences({ ...defaultPreferences, guideAgent: { hostId: "host_flomac", providerId: "codex", model: "gpt-6", reasoningLevel: "low", permissionMode: "auto" } }, 0);
  expect(await rerunReview({ bb, store, gh }, "pr-7")).toEqual({ ok: false, error: "FloMac is offline. Wake it, or choose another machine for the guide writer in Review settings." });
  expect(store.getReview("pr-7")).toMatchObject({ status: "ready", headSha: "oldsha" });
  expect(store.readPatch("pr-7").text).toBe("stale patch");
});
