import { test, expect } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import type { BbPluginApi, PluginAgentConfigurationContext } from "@get-bb/plugin-sdk";
import { createStore } from "./store";
import { assistantInstructions, getConversation, newConversation, refreshAssistants, startConversation } from "./agent";
import { defaultPreferences } from "./preferences";
import { generateGuide } from "./generate";
import plugin from "../server";

const opus = { providerId: "claude-code", model: "opus", reasoningLevel: "high" } as const;
const guide = (intent: string) => ({ title: "Change", intent, sections: [{ id: "s1", title: "Retry", overview: "Retries once.", diffs: [] }], unplacedFiles: [] });

function host(threads: Record<string, unknown> = {}, projects: Record<string, unknown> = {}) {
  const { bb, harness } = createFakePluginHost({ pluginId: "guided-review", sdk: { threads: {
    spawn: async () => ({ id: "worker" }), archive: async () => ({}), stop: async () => ({}),
    get: async () => ({ archivedAt: null, deletedAt: null, status: "idle" }), ...threads,
  }, projects } });
  const store = createStore(bb);
  store.saveReview({ targetKey: "pr-1", kind: "pr", status: "ready", createdAt: 1, projectId: "p1" });
  return { bb, harness, store };
}

/** Conversations stored by plugin versions before the chat moved into bb threads. */
function legacyConversation(bb: BbPluginApi, worker: string, messages: Array<[string, string]>) {
  const db = bb.storage.database();
  db.prepare(`INSERT INTO agent_threads (target_key,thread_id,created_at) VALUES ('pr-1',?,1)`).run(worker);
  for (const [role, text] of messages) db.prepare(`INSERT INTO agent_messages (target_key,role,text,context,created_at) VALUES ('pr-1',?,?,NULL,1)`).run(role, text);
}

test("the first message starts one hidden assistant thread on the chosen agent", async () => {
  const { bb, harness, store } = host();
  expect(await startConversation(bb, store, { targetKey: "pr-1", text: "Why retry?", agent: opus })).toEqual({ threadId: "worker" });
  const [spawn] = harness.inspection.sdk.callsTo("threads.spawn")[0] as [any];
  expect(spawn).toMatchObject({
    projectId: "p1", environment: { type: "project-default" }, title: "Review agent: pr-1", visibility: "hidden",
    pluginMetadata: { targetKey: "pr-1" }, input: [{ type: "text", text: "Why retry?", mentions: [] }],
    ...opus, executionInputSources: { providerId: "explicit", model: "explicit", reasoningLevel: "explicit" },
  });
  // Project defaults choose no permission mode, so bb resolves the provider's own.
  expect(spawn).not.toHaveProperty("permissionMode");
  expect(store.getAssistantThread("pr-1")).toBe("worker");
  await expect(startConversation(bb, store, { targetKey: "pr-1", text: "Again", agent: opus })).rejects.toThrow(/already has a conversation/);
  expect(harness.inspection.sdk.callsTo("threads.spawn")).toHaveLength(1);
});

test("the Settings default supplies its permission mode only for its own provider", async () => {
  const { bb, harness, store } = host();
  store.savePreferences({ ...defaultPreferences, assistantAgent: { ...opus, permissionMode: "full" } }, 0);
  store.saveReview({ targetKey: "pr-2", kind: "pr", status: "ready", createdAt: 1, projectId: "p1" });
  await startConversation(bb, store, { targetKey: "pr-1", text: "Why?", agent: { ...opus, model: "sonnet" } });
  await startConversation(bb, store, { targetKey: "pr-2", text: "Why?", agent: { providerId: "codex", model: "gpt-6", reasoningLevel: "low", serviceTier: "fast" } });
  const [same, other] = harness.inspection.sdk.callsTo("threads.spawn").map(([args]) => args as any);
  expect(same).toMatchObject({ providerId: "claude-code", model: "sonnet", permissionMode: "full", executionInputSources: { permissionMode: "explicit" } });
  expect(other).toMatchObject({ providerId: "codex", serviceTier: "fast", executionInputSources: { serviceTier: "explicit" } });
  expect(other).not.toHaveProperty("permissionMode");
});

test("a legacy conversation stays visible, reaches the agent as hidden history, and retires its worker", async () => {
  const { bb, harness, store } = host();
  legacyConversation(bb, "legacy-worker", [["user", "Earlier question"], ["assistant", "Earlier answer"]]);
  await startConversation(bb, store, { targetKey: "pr-1", text: "Go on", agent: opus });
  const [spawn] = harness.inspection.sdk.callsTo("threads.spawn")[0] as [any];
  expect(spawn.input[1]).toEqual({ type: "text", visibility: "agent-only", mentions: [], text: "Previous review conversation:\nuser: Earlier question\n\nassistant: Earlier answer" });
  expect(harness.inspection.sdk.callsTo("threads.archive")).toEqual([[{ threadId: "legacy-worker" }]]);
  expect(store.getAgentThread("pr-1")).toBeNull();
  expect((await getConversation(bb, store, "pr-1")).legacy.map((message) => message.text)).toEqual(["Earlier question", "Earlier answer"]);
});

test("a live thread continues; otherwise the conversation starts from the Settings or project default", async () => {
  const projectDefaults = { providerId: "codex", model: "gpt-6-astra", reasoningLevel: "low", permissionMode: "auto", serviceTier: "default" };
  const { bb, harness, store } = host({}, { defaultExecutionOptions: async ({ projectId }: { projectId: string }) => projectId === "p1" ? projectDefaults : null });
  store.setAssistantThread("pr-1", "worker");
  expect(await getConversation(bb, store, "pr-1")).toEqual({ threadId: "worker", legacy: [], defaults: null });

  harness.inspection.sdk.stub("threads.get", async () => ({ archivedAt: 123, deletedAt: null }));
  expect(await getConversation(bb, store, "pr-1")).toEqual({ threadId: null, legacy: [], defaults: { providerId: "codex", model: "gpt-6-astra", reasoningLevel: "low", serviceTier: "default" } });
  expect(store.getAssistantThread("pr-1")).toBeNull();

  store.savePreferences({ ...defaultPreferences, assistantAgent: { ...opus, permissionMode: "full" } }, 0);
  expect((await getConversation(bb, store, "pr-1")).defaults).toEqual(opus);

  store.setAssistantThread("pr-1", "deleted");
  harness.inspection.sdk.stub("threads.get", async () => { throw new Error("HTTP 404: Thread not found"); });
  expect((await getConversation(bb, store, "pr-1")).threadId).toBeNull();

  store.setAssistantThread("pr-1", "unreachable");
  harness.inspection.sdk.stub("threads.get", async () => { throw new Error("Connection unavailable"); });
  await expect(getConversation(bb, store, "pr-1")).rejects.toThrow("Connection unavailable");
  expect(store.getAssistantThread("pr-1")).toBe("unreachable");
});

test("New conversation archives the thread and clears the legacy transcript", async () => {
  const { bb, harness, store } = host({ archive: async ({ threadId }: { threadId: string }) => { if (threadId === "worker") throw new Error("Connection unavailable"); } });
  legacyConversation(bb, "legacy-worker", [["user", "Earlier question"]]);
  store.setAssistantThread("pr-1", "worker");
  await newConversation(bb, store, "pr-1");
  expect(harness.inspection.sdk.callsTo("threads.archive").map(([args]) => (args as any).threadId)).toEqual(["worker", "legacy-worker"]);
  expect([store.getAssistantThread("pr-1"), store.getAgentThread("pr-1"), store.listAgentMessages("pr-1")]).toEqual([null, null, []]);
});

test("instructions carry the review's current guide and preferences, trimmed to bb's limit", () => {
  const text = assistantInstructions("pr-1", guide("Retries failed refreshes") as any, { ...defaultPreferences, assistantInstructions: "Focus on security" });
  for (const part of ['"pr-1"', "read_review_patch", "untrusted", "Focus on security", "Retries failed refreshes", "- Retry: Retries once."]) expect(text).toContain(part);
  const long = assistantInstructions("pr-1", { ...guide("Big"), sections: Array.from({ length: 200 }, (_, i) => ({ id: `s${i}`, title: `Chapter ${i}`, overview: "x".repeat(100), diffs: [] })) } as any, defaultPreferences);
  expect(long.length).toBe(4000);
  expect(long.endsWith("…")).toBe(true);
  expect(long).toContain("Answer concisely");
});

function reviewAgentContext(pluginMetadata: Record<string, string>): PluginAgentConfigurationContext {
  return {
    pluginMetadata,
    thread: { id: "worker", title: "Review agent: pr-1", parentThreadId: null, sourceThreadId: null },
    project: { id: "p1", kind: "personal", name: "Personal", gitRemoteUrl: null },
    environment: { id: "env-1", name: null, path: null, workspaceProvisionType: "unmanaged", branchName: null },
    host: { id: "host-1", name: "test-host" },
    provider: { id: "claude-code", model: "opus", capabilities: { supportsNativeUserQuestion: false } },
    origin: { kind: null, pluginId: "guided-review" },
  } as PluginAgentConfigurationContext;
}

test("the assistant gets its review's current instructions, without private notes, and only the read tool", async () => {
  const { bb, harness, store } = host();
  await plugin(bb);
  store.saveReviewerNotes("pr-1", "PRIVATE-SCRATCHPAD", 0);
  store.savePreferences({ ...defaultPreferences, assistantInstructions: "Focus on security" }, 0);
  store.saveGuide("pr-1", guide("Old behavior") as any);
  store.saveGuide("pr-1", guide("New retry behavior") as any);
  const mine = await harness.behavior.resolveAgentConfiguration(reviewAgentContext({ targetKey: "pr-1" }));
  expect(mine.tools.map((tool) => tool.name)).toEqual(["read_review_patch"]);
  expect(mine.skills).toEqual([]);
  expect(mine.instructions).toContain("New retry behavior");
  expect(mine.instructions).toContain("Focus on security");
  expect(mine.instructions).not.toMatch(/Old behavior|PRIVATE-SCRATCHPAD/);
  expect((await harness.behavior.resolveAgentConfiguration(reviewAgentContext({ targetKey: "pr-unknown" }))).instructions).toBeNull();
});

test("idle assistants restart for new instructions after Re-review or a preferences change; busy ones finish", async () => {
  const { bb, harness, store } = host({ get: async ({ threadId }: { threadId: string }) => ({ archivedAt: null, deletedAt: null, status: threadId === "busy" ? "active" : "idle" }) });
  await plugin(bb);
  store.saveReview({ targetKey: "pr-2", kind: "pr", status: "ready", createdAt: 1, projectId: "p1" });
  store.setAssistantThread("pr-1", "idle");
  store.setAssistantThread("pr-2", "busy");
  await refreshAssistants(bb, store, ["pr-2"]);
  expect(harness.inspection.sdk.callsTo("threads.stop")).toEqual([]);
  await refreshAssistants(bb, store);
  expect(harness.inspection.sdk.callsTo("threads.stop")).toEqual([[{ threadId: "idle" }]]);

  const { revision } = store.getPreferences();
  await harness.behavior.callRpc("savePreferences", { preferences: { ...defaultPreferences, diffLayout: "unified" }, revision });
  expect(harness.inspection.sdk.callsTo("threads.stop")).toHaveLength(1);
  await harness.behavior.callRpc("savePreferences", { preferences: { ...defaultPreferences, diffLayout: "unified", assistantInstructions: "Be brief" }, revision: revision + 1 });
  await expect.poll(() => harness.inspection.sdk.callsTo("threads.stop")).toHaveLength(2);
});

test("a finished guide restarts the review's idle assistant so it reads the new guide", async () => {
  let finishGuide = () => {};
  const { bb, harness, store } = host({ wait: async () => finishGuide() });
  finishGuide = () => store.saveGuide("pr-1", guide("New retry behavior") as any);
  store.setAssistantThread("pr-1", "assistant");
  await generateGuide(bb, store, "pr-1", "p1");
  expect(store.getReview("pr-1")?.status).toBe("ready");
  await expect.poll(() => harness.inspection.sdk.callsTo("threads.stop").map(([args]) => (args as any).threadId)).toContain("assistant");
});
