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
  const res = await runReviewCommand({ bb, store, gh }, ["7"], { projectId: "p1", cwd: process.cwd() });
  expect(res.exitCode).toBe(0);
  const meta = store.getReview(key);
  expect(meta?.repo).toBe("acme/web");
  expect(store.readPatch(key).text).toContain("diff --git a/a.ts");
});

test("bb review reports an offline guide writer machine without starting a review", async () => {
  const { bb } = createFakePluginHost({ pluginId: "guided-review", sdk: { hosts: { get: async () => ({ id: "host_flomac", name: "FloMac", status: "disconnected", lifecycle: { phase: "active" } }) } } });
  const store = createStore(bb);
  store.savePreferences({ ...defaultPreferences, guideAgent: { hostId: "host_flomac", providerId: "codex", model: "gpt-6", reasoningLevel: "low", permissionMode: "auto" } }, 0);
  expect(await runReviewCommand({ bb, store, gh }, ["7"], { projectId: "p1", cwd: process.cwd() }))
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

const url = "https://github.com/acme/web/pull/7";
const laptop = "/Users/someone/only-on-a-laptop";
function host() {
  const { bb } = createFakePluginHost({ pluginId: "guided-review", sdk: { threads: { spawn: async () => ({ id: "th_1" }), wait: async () => {}, archive: async () => {}, stop: async () => {} } } });
  return { bb, store: createStore(bb) };
}

test("a PR URL starts a review from a thread on any machine; gh never runs in the caller's directory", async () => {
  const { bb, store } = host();
  vi.mocked(gh.runGh).mockClear();
  expect(await runReviewCommand({ bb, store, gh }, [url], { projectId: "p1", cwd: laptop })).toMatchObject({ exitCode: 0 });
  expect(store.getReview(key)).toMatchObject({ repo: "acme/web", number: 7 });
  expect(vi.mocked(gh.runGh).mock.calls.length).toBeGreaterThan(0);
  expect(vi.mocked(gh.runGh).mock.calls.map(([, opts]) => opts?.cwd)).toEqual(vi.mocked(gh.runGh).mock.calls.map(() => undefined));
});

test("a PR number or local ref from a directory that isn't on the bb server says so and starts nothing", async () => {
  const { bb, store } = host();
  vi.mocked(gh.runGh).mockClear();
  vi.mocked(gh.runGit).mockClear();
  for (const input of ["7", "HEAD"]) {
    expect(await runReviewCommand({ bb, store, gh }, [input], { projectId: "p1", cwd: laptop }))
      .toEqual({ exitCode: 2, stderr: `A local ref or PR number needs a checkout on the bb server, and ${laptop} isn't on it. Pass the PR's URL instead, or run \`bb review\` in a checkout on the server.` });
  }
  expect(store.listReviews()).toEqual([]);
  expect(gh.runGh).not.toHaveBeenCalled();
  expect(gh.runGit).not.toHaveBeenCalled();
});

test("--context is kept with the review for the automatic review, until replaced or removed", async () => {
  const { bb, store } = host();
  const review = (...argv: string[]) => runReviewCommand({ bb, store, gh }, [url, ...argv], { projectId: "p1", cwd: laptop });
  const context = "- Implements LIN-42\n- Must not retry twice";
  expect((await review("--context", `  ${context}\n`)).stdout).toBe(`Guided Review started for ${key}. Open the Guided Review panel to watch it build and review.\nThe assistant's automatic review will include this context.`);
  expect(store.getReviewContext(key)).toBe(context);
  expect((await review()).stdout).not.toContain("context");
  expect(store.getReviewContext(key)).toBe(context);

  store.setAssistantThread(key, "assistant");
  expect((await review("--context", "Newer")).stdout).toContain("already has an assistant conversation, so the automatic review won't run and won't see this context.");
  expect(store.getReviewContext(key)).toBe("Newer");
  store.savePreferences({ ...defaultPreferences, automaticReview: " " }, 0);
  expect((await review("--context", "Newest")).stdout).toContain("Automatic review is off in Review settings");
  expect((await review("--context", "")).stdout).toContain("Removed the review's context.");
  expect(store.getReviewContext(key)).toBeNull();

  for (const argv of [["--context"], ["--context", "a", "--context", "b"], ["--context", "x".repeat(12_001)]]) {
    expect(await review(...argv)).toMatchObject({ exitCode: 2, stderr: expect.stringContaining("--context") });
  }
  expect(store.getReviewContext(key)).toBeNull();
});
