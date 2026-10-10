import { test, expect, vi } from "vitest";

vi.mock("./gh", async (orig) => {
  const real = await orig<any>();
  return {
    ...real,
    runGh: vi.fn(async (args: string[]) => {
      if (args[0] === "pr" && args[1] === "checks") {
        return {
          stdout: JSON.stringify([
            { name: "lint", state: "SUCCESS", bucket: "pass", link: "https://x/1" },
          ]),
          stderr: "",
          code: 0,
        };
      }
      if (args[0] === "api" && args[1] === "graphql" && args[3].includes("resolveReviewThread")) {
        return { stdout: JSON.stringify({ data: { resolveReviewThread: { thread: { id: "PRRT_1", isResolved: true } } } }), stderr: "", code: 0 };
      }
      if (args[0] === "api" && args[1] === "graphql" && args[3].includes("unresolveReviewThread")) {
        return { stdout: JSON.stringify({ data: { unresolveReviewThread: { thread: { id: "PRRT_1", isResolved: false } } } }), stderr: "", code: 0 };
      }
      if (args[0] === "api" && args[1] === "graphql") {
        return {
          stdout: JSON.stringify({
            data: {
              repository: {
                pullRequest: {
                  reviewThreads: {
                    nodes: [
                      {
                        id: "PRRT_1",
                        isResolved: false,
                        isOutdated: false,
                        path: "src/foo.ts",
                        line: 42,
                        comments: { nodes: [{ id: "PRRC_1", databaseId: 111, author: { login: "alice" }, body: "please fix" }] },
                      },
                    ],
                  },
                },
              },
            },
          }),
          stderr: "",
          code: 0,
        };
      }
      if (args[0] === "api" && args[3]?.startsWith("repos/") && args[3]?.includes("/replies")) {
        return { stdout: "{}", stderr: "", code: 0 };
      }
      if (args[0] === "pr" && args[1] === "view") {
        return { stdout: JSON.stringify({ headRefOid: "newsha", reviewDecision: null }), stderr: "", code: 0 };
      }
      return { stdout: "", stderr: "", code: 0 };
    }),
    runGit: vi.fn(async () => ({ stdout: "", stderr: "", code: 0 })),
  };
});

import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import plugin from "../server";
import { createStore } from "./store";
import * as gh from "./gh";

function host() {
  return createFakePluginHost({ pluginId: "guided-review" });
}

async function seeded() {
  const { bb, harness } = host();
  await plugin(bb);
  const store = createStore(bb);
  store.saveReview({
    targetKey: "pr-1",
    kind: "pr",
    number: 1,
    repo: "acme/web",
    status: "ready",
    createdAt: 1,
    headSha: "oldsha",
  });
  store.savePatch("pr-1", "diff --git a/a.ts b/a.ts\n");
  return { bb, harness, store };
}

test("getChecks returns a structured bucket + checks", async () => {
  const { harness } = await seeded();
  const res: any = await harness.behavior.callRpc("getChecks", { targetKey: "pr-1" });
  expect(res.bucket).toBe("pass");
  expect(res.checks).toEqual([{ name: "lint", state: "SUCCESS", bucket: "pass", link: "https://x/1" }]);
});

test.each([1, 8])("getChecks keeps failed/pending checks returned with gh exit %s", async (code) => {
  const { harness } = await seeded();
  vi.mocked(gh.runGh).mockResolvedValueOnce({ code, stdout: JSON.stringify([{ name: "ci", bucket: code === 1 ? "fail" : "pending", state: code === 1 ? "FAILURE" : "PENDING", link: "https://example.invalid/check" }]), stderr: "" });
  const result: any = await harness.behavior.callRpc("getChecks", { targetKey: "pr-1" });
  expect(result.bucket).toBe(code === 1 ? "fail" : "pending");
  expect(result.checks).toHaveLength(1);
});

test("getReviewThreads returns parsed threads", async () => {
  const { harness } = await seeded();
  const res: any = await harness.behavior.callRpc("getReviewThreads", { targetKey: "pr-1" });
  expect(res.threads).toEqual([
    {
      id: "PRRT_1",
      isResolved: false,
      isOutdated: false,
      path: "src/foo.ts",
      line: 42,
      comments: [{ id: "PRRC_1", databaseId: 111, author: "alice", body: "please fix" }],
    },
  ]);
});

test("resolveThread returns ok:true and calls gh with the thread id", async () => {
  const { harness } = await seeded();
  const res: any = await harness.behavior.callRpc("resolveThread", { targetKey: "pr-1", threadId: "PRRT_1" });
  expect(res).toEqual({ ok: true });
  const calls = (gh.runGh as any).mock.calls.map((c: any[]) => c[0]);
  expect(
    calls.some(
      (args: string[]) => args.some((a) => a.includes("PRRT_1")) && args.some((a) => a.includes("resolveReviewThread")),
    ),
  ).toBe(true);
});

test("unresolveThread returns ok:true and calls gh with the thread id", async () => {
  const { harness } = await seeded();
  const res: any = await harness.behavior.callRpc("unresolveThread", { targetKey: "pr-1", threadId: "PRRT_1" });
  expect(res).toEqual({ ok: true });
  const calls = (gh.runGh as any).mock.calls.map((c: any[]) => c[0]);
  expect(
    calls.some(
      (args: string[]) => args.some((a) => a.includes("PRRT_1")) && args.some((a) => a.includes("unresolveReviewThread")),
    ),
  ).toBe(true);
});

test("replyToThread returns ok:true and calls gh with the reply endpoint + body", async () => {
  const { harness } = await seeded();
  const res: any = await harness.behavior.callRpc("replyToThread", { targetKey: "pr-1", inReplyTo: 111, body: "thanks" });
  expect(res).toEqual({ ok: true });
  const call = (gh.runGh as any).mock.calls.find((c: any[]) => c[0][3]?.includes("/comments/111/replies"));
  expect(call).toBeTruthy();
  expect(call[0]).toEqual(["api", "-X", "POST", "repos/acme/web/pulls/1/comments/111/replies", "--input", "-"]);
  // A write waits as long as it takes: a reply killed mid-flight could land twice on retry.
  expect(call[1]).toEqual({ stdin: JSON.stringify({ body: "thanks" }), timeoutMs: 0 });
});

test("checkForUpdates returns hasNewCommits:true when the mocked head differs from the stored headSha", async () => {
  const { harness } = await seeded();
  const res: any = await harness.behavior.callRpc("checkForUpdates", { targetKey: "pr-1" });
  expect(res).toEqual({ hasNewCommits: true, current: "newsha", stored: "oldsha" });
});

test("rereview delegates to rerunReview and returns its result", async () => {
  const { harness } = await seeded();
  const res: any = await harness.behavior.callRpc("rereview", { targetKey: "pr-1" });
  expect(res.ok).toBe(false); // no projectId seeded -> rerunReview's own guard fails
  expect(res.error).toMatch(/project/i);
});
