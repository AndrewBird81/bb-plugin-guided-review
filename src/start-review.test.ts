import { test, expect, vi } from "vitest";

vi.mock("./gh", async (orig) => {
  const real = await orig<any>();
  return {
    ...real,
    runGh: vi.fn(async (args: string[]) => {
      if (args[1] === "view") {
        return {
          stdout: JSON.stringify({
            number: 7,
            title: "Fix the thing",
            body: "b",
            author: { login: "a" },
            baseRefName: "main",
            headRefName: "f",
            url: "https://github.com/acme/web/pull/7",
            headRefOid: "abc123",
          }),
          stderr: "",
          code: 0,
        };
      }
      if (args[1] === "diff") {
        return { stdout: "--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-o\n+n\n", stderr: "", code: 0 };
      }
      return { stdout: "", stderr: "", code: 0 };
    }),
    runGit: vi.fn(async () => ({ stdout: "", stderr: "", code: 0 })),
  };
});

import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { createStore } from "./store";
import { createPrReview } from "./start-review";
import * as gh from "./gh";
import { targetKey } from "./targets";
const key = targetKey({ kind: "pr", number: 7, repo: "acme/web" });

test("createPrReview stores the review + patch and returns ok with a targetKey", async () => {
  const { bb } = createFakePluginHost({
    pluginId: "guided-review",
    sdk: { threads: { spawn: async () => ({ id: "th_1" }), wait: async () => {}, archive: async () => {}, stop: async () => {} } },
  });
  const store = createStore(bb);

  const res = await createPrReview(
    { bb, store, gh },
    { input: "https://github.com/acme/web/pull/7", projectId: "p1" },
  );

  expect(res.ok).toBe(true);
  expect(res.targetKey).toBe(key);

  const meta = store.getReview(key);
  expect(meta?.repo).toBe("acme/web");
  expect(meta?.title).toBe("Fix the thing");
  expect(meta?.headSha).toBe("abc123");
  expect(meta?.projectId).toBe("p1");
  expect(store.readPatch(key).text).toContain("diff --git a/a.ts");
});

test("starting an archived PR's review again returns it to the queue", async () => {
  const { bb } = createFakePluginHost({
    pluginId: "guided-review",
    sdk: { threads: { spawn: async () => ({ id: "th_1" }), wait: async () => {}, archive: async () => {}, stop: async () => {} } },
  });
  const store = createStore(bb);
  await createPrReview({ bb, store, gh }, { input: "https://github.com/acme/web/pull/7", projectId: "p1" });
  store.setLifecycle(key, { userArchivedAt: 1 });

  await createPrReview({ bb, store, gh }, { input: "https://github.com/acme/web/pull/7", projectId: "p1" });

  expect(store.getReview(key)?.userArchivedAt).toBeNull();
});

test("createPrReview rejects a non-PR-URL input", async () => {
  const { bb } = createFakePluginHost({ pluginId: "guided-review" });
  const store = createStore(bb);

  const res = await createPrReview({ bb, store, gh }, { input: "42", projectId: "p1" });

  expect(res.ok).toBe(false);
  expect(res.targetKey).toBeUndefined();
});
