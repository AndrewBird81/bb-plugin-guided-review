import { test, expect } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import type { PluginAgentConfigurationContext } from "@get-bb/plugin-sdk";
import { createStore } from "./store";
import plugin from "../server";

const patch = `diff --git a/a.ts b/a.ts
--- a/a.ts
+++ b/a.ts
@@ -1 +1 @@
-old
+new
`;

async function host() {
  const h = createFakePluginHost({ pluginId: "guided-review" });
  await plugin(h.bb);
  const store = createStore(h.bb); // same pluginId → same DB the factory's tools read
  store.saveReview({ targetKey: "pr-1", kind: "pr", number: 1, status: "generating", createdAt: 1 });
  store.savePatch("pr-1", patch);
  const generationId = store.beginGeneration("pr-1");
  return { ...h, store, generationId };
}

test("read_review_patch returns stored patch text", async () => {
  const { harness, generationId } = await host();
  const out = await harness.behavior.callAgentTool("read_review_patch", { targetKey: "pr-1" });
  expect(String(out.content?.[0]?.text ?? out)).toContain("diff --git a/a.ts");
});

test("read_review_patch reads one file's diff on request", async () => {
  const { harness, store } = await host();
  store.savePatch("pr-1", patch + patch.replaceAll("a.ts", "b.ts").replace("+new", "+other"));
  const text = (out: any) => String(out.content?.[0]?.text ?? out);
  const one = await harness.behavior.callAgentTool("read_review_patch", { targetKey: "pr-1", file: "b.ts" });
  expect(text(one)).toContain("+other");
  expect(text(one)).not.toContain("a.ts");
  const missing = await harness.behavior.callAgentTool("read_review_patch", { targetKey: "pr-1", file: "c.ts" });
  expect(missing.isError).toBe(true);
});

test("generate_review_guide rejects incomplete coverage then accepts a full guide", async () => {
  const { harness, generationId } = await host();
  const bad = await harness.behavior.callAgentTool("generate_review_guide", {
    targetKey: "pr-1",
    generationId,
    guide: { title: "T", intent: "I", sections: [], unplacedFiles: [], review: { gitRef: "x" } },
  });
  expect(bad.isError).toBe(true);
  const good = await harness.behavior.callAgentTool("generate_review_guide", {
    targetKey: "pr-1",
    generationId,
    guide: { title: "T", intent: "I", sections: [{ id: "s1", title: "S", overview: "o", diffs: [{ file: "a.ts", summary: "x" }] }], unplacedFiles: [], review: { gitRef: "x" } },
  });
  expect(good.isError).toBeFalsy();
});

test("generate_review_guide stamps the store's authoritative gitRef (and base) over whatever the guide submitted, and accepts a section risk", async () => {
  const { harness, store, generationId } = await host();
  store.saveReview({
    targetKey: "pr-1",
    kind: "pr",
    number: 1,
    status: "generating",
    createdAt: 1,
    gitRef: "main...feature-authoritative",
    base: "main",
  });

  const good = await harness.behavior.callAgentTool("generate_review_guide", {
    targetKey: "pr-1",
    generationId,
    guide: {
      title: "T",
      intent: "I",
      sections: [
        {
          id: "s1",
          title: "S",
          overview: "o",
          risk: "high",
          diffs: [{ file: "a.ts", summary: "x" }],
        },
      ],
      unplacedFiles: [],
      review: { gitRef: "wrong-or-stale-ref", base: "wrong-base" },
    },
  });
  expect(good.isError).toBeFalsy();

  const stored = store.getGuide("pr-1");
  expect(stored?.review).toEqual({ gitRef: "main...feature-authoritative", base: "main" });
  expect(stored?.sections[0].risk).toBe("high");
});

test("generate_review_guide stamps gitRef even when the submitted guide omitted review entirely", async () => {
  const { harness, store, generationId } = await host();
  store.saveReview({
    targetKey: "pr-1",
    kind: "pr",
    number: 1,
    status: "generating",
    createdAt: 1,
    gitRef: "main...feature-authoritative",
  });

  const good = await harness.behavior.callAgentTool("generate_review_guide", {
    targetKey: "pr-1",
    generationId,
    guide: {
      title: "T",
      intent: "I",
      sections: [{ id: "s1", title: "S", overview: "o", diffs: [{ file: "a.ts", summary: "x" }] }],
      unplacedFiles: [],
    },
  });
  expect(good.isError).toBeFalsy();

  const stored = store.getGuide("pr-1");
  expect(stored?.review).toEqual({ gitRef: "main...feature-authoritative" });
});

function baseConfigContext(pluginId: string | null, threadTitle: string | null = null): PluginAgentConfigurationContext {
  return {
    thread: { id: "thread-1", title: threadTitle, parentThreadId: null, sourceThreadId: null },
    project: { id: "project-1", kind: "standard", name: "test-project", gitRemoteUrl: null },
    environment: { id: "env-1", name: null, path: null, workspaceProvisionType: "unmanaged", branchName: null },
    host: { id: "host-1", name: "test-host" },
    provider: { id: "test-provider", model: "test-model", capabilities: { supportsNativeUserQuestion: false } },
    origin: { kind: null, pluginId },
  };
}

test("agents.configure exposes tools/skill only to this plugin's own generation thread", async () => {
  const h = createFakePluginHost({ pluginId: "guided-review", agentSkillIds: ["guided-review-generate"] });
  await plugin(h.bb);

  const mine = await h.harness.behavior.resolveAgentConfiguration(
    baseConfigContext("guided-review", "Generate guide: pr-1"),
  );
  expect(mine.tools.map((t) => t.name)).toEqual(["read_review_patch", "read_changes_since_review", "generate_review_guide"]);
  expect(mine.skills).toEqual(["guided-review-generate"]);

  const foreign = await h.harness.behavior.resolveAgentConfiguration(
    baseConfigContext("someone-else", "Generate guide: pr-1"),
  );
  expect(foreign.tools).toEqual([]);
  expect(foreign.skills).toEqual([]);

  const absent = await h.harness.behavior.resolveAgentConfiguration(
    baseConfigContext(null, "Generate guide: pr-1"),
  );
  expect(absent.tools).toEqual([]);
  expect(absent.skills).toEqual([]);

  // Same plugin origin: the floating review-agent thread gets the read tool so
  // its chat works across the review, and the draft-comment tools, but never the
  // guide-writing tool/skill. The guide writer never drafts comments.
  const agentThread = await h.harness.behavior.resolveAgentConfiguration(
    baseConfigContext("guided-review", "Review agent: pr-1"),
  );
  expect(agentThread.tools.map((t) => t.name)).toEqual(["read_review_patch", "list_draft_comments", "add_draft_comment", "edit_draft_comment", "delete_draft_comment", "reply_in_discussion",
    "list_feedback", "read_changes_since_review", "read_file", "assess_feedback", "draft_thread_reply"]);
  expect(agentThread.skills).toEqual([]);

  // An unrelated same-plugin thread still gets nothing.
  const other = await h.harness.behavior.resolveAgentConfiguration(
    baseConfigContext("guided-review", "Something else: pr-1"),
  );
  expect(other.tools).toEqual([]);
  expect(other.skills).toEqual([]);
});

test("a rebuilt guide for a PR you reviewed checks your feedback instead of reviewing from scratch", async () => {
  const { generateGuide, buildGenerationPrompt } = await import("./generate");
  const { defaultPreferences } = await import("./preferences");
  const { bb, harness } = createFakePluginHost({ pluginId: "guided-review", sdk: { threads: {
    spawn: async () => ({ id: "worker" }), archive: async () => {}, stop: async () => {},
    get: async () => ({ archivedAt: null, deletedAt: null, status: "idle" }), send: async () => ({}),
  } } as any });
  const store = createStore(bb);
  store.saveReview({ targetKey: "pr-1", kind: "pr", repo: "acme/web", number: 1, headSha: "sha2", status: "ready", createdAt: 1, projectId: "p1" });
  store.setLifecycle("pr-1", { submittedVerdict: "REQUEST_CHANGES", submittedAt: 1000, submittedHeadSha: "sha1", signals: { lastReviewAt: 1000, lastReviewSha: "sha1" } });
  store.saveGuide("pr-1", { title: "T", intent: "I", sections: [{ id: "cache", title: "Cache", overview: "o", diffs: [{ file: "a.ts", summary: "s" }] }], unplacedFiles: [] });
  store.setAssistantThread("pr-1", "assistant");
  harness.inspection.sdk.stub("threads.wait", async () => { store.saveGuide("pr-1", { title: "T", intent: "I", sections: [], unplacedFiles: [] }); return { matched: true }; });
  await generateGuide(bb, store, "pr-1", "p1", { notify: false });
  // The guide writer kept the earlier chapters in view and was asked for sinceReview.
  const prompt = harness.inspection.sdk.callsTo("threads.spawn")[0][0].prompt as string;
  expect(prompt).toContain("- cache: Cache (a.ts)");
  expect(prompt).toContain("sinceReview");
  // The review's conversation got the feedback check, with its context only the assistant sees.
  const sent = harness.inspection.sdk.callsTo("threads.send")[0][0] as any;
  expect(sent.input[0].text).toBe(defaultPreferences.verificationPrompt);
  expect(sent.input[1]).toMatchObject({ visibility: "agent-only", text: expect.stringContaining("REQUEST_CHANGES on commit sha1") });
  expect(store.getReview("pr-1")?.verifyingSince).toEqual(expect.any(Number));
  // A first review gets neither.
  expect(buildGenerationPrompt("pr-2", "g", defaultPreferences)).not.toContain("sinceReview");
});
