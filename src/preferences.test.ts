import { expect, test } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import plugin from "../server";
import { createStore } from "./store";
import { defaultPreferences } from "./preferences";
import { buildGenerationPrompt } from "./generate";
import { generateGuide } from "./generate";
import { startConversation } from "./agent";

test("settings persist across stores, reject stale edits, and validate input", async () => {
  const { bb, harness } = createFakePluginHost({ pluginId: "guided-review" });
  await plugin(bb);
  const initial = await harness.behavior.callRpc("getPreferences", null) as any;
  expect(initial.preferences).toEqual(defaultPreferences);
  const preferences = { ...initial.preferences, guideDetail: "detailed", guideInstructions: "Explain migration risks", assistantInstructions: "Focus on security" };
  const saved = await harness.behavior.callRpc("savePreferences", { preferences, revision: initial.revision }) as any;
  expect(saved.revision).toBe(1);
  expect(createStore(bb).getPreferences().preferences).toEqual(preferences);
  await expect(harness.behavior.callRpc("savePreferences", { preferences, revision: 0 })).rejects.toThrow(/changed/);
  await expect(harness.behavior.callRpc("savePreferences", { preferences: { ...preferences, guideDetail: "invalid" }, revision: 1 })).rejects.toThrow();
  expect(buildGenerationPrompt("pr-1", "run-1", preferences)).toContain("Explain migration risks");
  expect(buildGenerationPrompt("pr-1", "run-1", preferences)).toContain("Detailed");
  expect(buildGenerationPrompt("pr-1", "run-1", preferences)).not.toContain("Focus on security");
});

test("private notes persist independently of drafts, with conflict protection", async () => {
  const { bb, harness } = createFakePluginHost({ pluginId: "guided-review" });
  await plugin(bb);
  const store = createStore(bb);
  store.saveReview({ targetKey: "pr-1", kind: "pr", status: "ready", createdAt: 1 });
  store.setVerdict("pr-1", "COMMENT", "Existing public summary");
  expect(await harness.behavior.callRpc("getReviewerNotes", { targetKey: "pr-1" })).toEqual({ body: "", revision: 0 });
  await harness.behavior.callRpc("saveReviewerNotes", { targetKey: "pr-1", body: "Private thought", revision: 0 });
  await expect(harness.behavior.callRpc("saveReviewerNotes", { targetKey: "pr-1", body: "Stale edit", revision: 0 })).rejects.toThrow(/changed/);
  store.clearSubmittedDraft(store.getDraft("pr-1"));
  store.setLifecycle("pr-1", { prState: "MERGED", archivedAt: Date.now() });
  expect(createStore(bb).getReviewerNotes("pr-1")).toEqual({ body: "Private thought", revision: 1 });
  expect(store.getDraft("pr-1").body).toBe("");
});

test("workers receive current customization without private notes", async () => {
  const { bb, harness } = createFakePluginHost({ pluginId: "guided-review", sdk: { threads: {
    spawn: async () => ({ id: "worker" }), wait: async () => {}, stop: async () => {}, archive: async () => {},
  } } });
  const store = createStore(bb);
  store.saveReview({ targetKey: "target", kind: "ref", status: "ready", createdAt: 1, projectId: "project" });
  store.saveReviewerNotes("target", "PRIVATE-SCRATCHPAD", 0);
  store.savePreferences({ ...defaultPreferences, guideInstructions: "Explain public contracts", assistantInstructions: "Focus on security" }, 0);
  await generateGuide(bb, store, "target", "project");
  expect(harness.inspection.sdk.callsTo("threads.spawn")[0][0]).toMatchObject({ prompt: expect.stringContaining("Explain public contracts") });
  await startConversation(bb, store, { targetKey: "target", text: "Explain this", agent: { providerId: "codex", model: "gpt-6", reasoningLevel: "low" } });
  // Assistant preferences reach the conversation as instructions, not in its messages.
  expect(JSON.stringify(harness.inspection.sdk.callsTo("threads.spawn"))).not.toMatch(/PRIVATE-SCRATCHPAD|Focus on security/);
});

const codex = { providerId: "codex", model: "gpt-6-astra", reasoningLevel: "low", permissionMode: "auto", serviceTier: "ultrafast" } as const;
const claude = { providerId: "claude-code", model: "opus", reasoningLevel: "max", permissionMode: "full" } as const;
const explicit = { providerId: "explicit", model: "explicit", reasoningLevel: "explicit", permissionMode: "explicit" };

test("agent selections default to project defaults, persist, and validate", async () => {
  const { bb, harness } = createFakePluginHost({ pluginId: "guided-review" });
  await plugin(bb);
  // Settings saved before agent selections existed load as project defaults.
  bb.storage.database().prepare(`INSERT INTO review_preferences (id,value,revision) VALUES (1,?,1)`)
    .run(JSON.stringify({ guideDetail: "detailed", guideInstructions: "", assistantInstructions: "", diffLayout: "split" }));
  const initial = await harness.behavior.callRpc("getPreferences", null) as any;
  expect(initial.preferences).toMatchObject({ guideDetail: "detailed", guideAgent: null, assistantAgent: null });
  const preferences = { ...initial.preferences, guideAgent: codex, assistantAgent: claude };
  await harness.behavior.callRpc("savePreferences", { preferences, revision: 1 });
  expect(createStore(bb).getPreferences().preferences).toEqual(preferences);
  for (const assistantAgent of [{ ...claude, permissionMode: "ask" }, { ...claude, model: "" }, { ...claude, reasoningLevel: "extreme" }, { ...claude, extra: true }]) {
    await expect(harness.behavior.callRpc("savePreferences", { preferences: { ...preferences, assistantAgent }, revision: 2 })).rejects.toThrow();
  }
  expect(createStore(bb).getPreferences()).toEqual({ preferences, revision: 2 });
});

test("each agent starts with its own selection, sourced as the user's choice", async () => {
  const { bb, harness } = createFakePluginHost({ pluginId: "guided-review", sdk: { threads: {
    spawn: async () => ({ id: "worker" }), wait: async () => {}, output: async () => "Answer", stop: async () => {}, archive: async () => {},
  } } });
  const store = createStore(bb);
  store.saveReview({ targetKey: "target", kind: "ref", status: "ready", createdAt: 1, projectId: "project" });
  await generateGuide(bb, store, "target", "project");
  const execution = ["providerId", "model", "reasoningLevel", "permissionMode", "serviceTier", "executionInputSources"];
  for (const key of execution) expect(harness.inspection.sdk.callsTo("threads.spawn")[0][0]).not.toHaveProperty(key);

  store.savePreferences({ ...defaultPreferences, guideAgent: codex, assistantAgent: claude }, 0);
  await generateGuide(bb, store, "target", "project");
  await startConversation(bb, store, { targetKey: "target", text: "Explain this", agent: { providerId: claude.providerId, model: claude.model, reasoningLevel: claude.reasoningLevel } });
  const [, guide, assistant] = harness.inspection.sdk.callsTo("threads.spawn").map(([args]) => args as any);
  expect(guide).toMatchObject({ title: "Generate guide: target", ...codex, executionInputSources: { ...explicit, serviceTier: "explicit" } });
  expect(assistant).toMatchObject({ title: "Review agent: target", ...claude, executionInputSources: explicit });
  expect(assistant).not.toHaveProperty("serviceTier");
  expect(assistant.executionInputSources).not.toHaveProperty("serviceTier");
});

test("custom selections start from the personal project's remembered defaults", async () => {
  const defaults = { providerId: "codex", model: "gpt-6-astra", reasoningLevel: "low", permissionMode: "auto", serviceTier: "default" };
  const { bb, harness } = createFakePluginHost({ pluginId: "guided-review", sdk: { projects: {
    list: async () => [{ id: "proj_work", kind: "standard" }, { id: "proj_personal", kind: "personal" }],
    defaultExecutionOptions: async ({ projectId }: { projectId: string }) => projectId === "proj_personal" ? defaults : null,
  } } });
  await plugin(bb);
  expect(await harness.behavior.callRpc("getAgentDefaults", null)).toEqual({ defaults });
  harness.inspection.sdk.stub("projects.defaultExecutionOptions", async () => { throw new Error("Connection unavailable"); });
  expect(await harness.behavior.callRpc("getAgentDefaults", null)).toEqual({ defaults: null });
});
