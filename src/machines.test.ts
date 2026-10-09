import { expect, test } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import plugin from "../server";
import { createStore } from "./store";
import { defaultPreferences } from "./preferences";
import { generateGuide } from "./generate";
import { getConversation, startConversation } from "./agent";
import { machineUnavailable } from "./machines";

const machine = (id: string, name: string, status: "connected" | "disconnected", phase = "active") => ({ id, name, status, type: "persistent", lifecycle: { phase } });
const machines = [
  machine("host_maxbook", "MaxBook", "connected"), machine("host_server", "bb-server-0", "connected"), machine("host_flomac", "FloMac", "connected"),
  machine("host_old", "FloMac Original", "disconnected"), machine("host_gone", "Retired", "connected", "removing"),
];
const codex = { providerId: "codex", model: "gpt-6", reasoningLevel: "low" } as const;

function host() {
  const { bb, harness } = createFakePluginHost({ pluginId: "guided-review", sdk: {
    threads: { spawn: async () => ({ id: "worker" }), wait: async () => {}, archive: async () => {}, stop: async () => {}, get: async () => ({ archivedAt: null, deletedAt: null, status: "idle" }) },
    projects: { list: async () => [{ id: "proj_work", kind: "standard" }, { id: "proj_personal", kind: "personal" }] },
    hosts: {
      list: async () => machines,
      get: async ({ hostId }: { hostId: string }) => machines.find((m) => m.id === hostId) ?? Promise.reject(Object.assign(new Error("HTTP 404: Host not found"), { status: 404 })),
    },
    system: { config: async () => ({ primaryHostId: "host_server" }) },
  } });
  const store = createStore(bb);
  store.saveReview({ targetKey: "pr-1", kind: "pr", status: "ready", createdAt: 1, projectId: "proj_work" });
  return { bb, harness, store };
}

test("Review settings list persistent machines, the bb server first", async () => {
  const { bb, harness } = host();
  await plugin(bb);
  expect(await harness.behavior.callRpc("listMachines", null)).toEqual({ machines: [
    { hostId: "host_server", name: "bb-server-0", connected: true, server: true },
    { hostId: "host_flomac", name: "FloMac", connected: true, server: false },
    { hostId: "host_old", name: "FloMac Original", connected: false, server: false },
    { hostId: "host_maxbook", name: "MaxBook", connected: true, server: false },
  ] });
  expect(harness.inspection.sdk.callsTo("hosts.list")).toEqual([[{ type: "persistent" }]]);
  harness.inspection.sdk.stub("system.config", async () => { throw new Error("Connection unavailable"); });
  expect((await harness.behavior.callRpc("listMachines", null) as any).machines.some((m: any) => m.server)).toBe(false);
});

test("agents on a chosen machine run in its personal workspace", async () => {
  const { bb, harness, store } = host();
  store.savePreferences({ ...defaultPreferences, guideAgent: { hostId: "host_flomac", providerId: "claude-code", model: "claude-opus-5-5", reasoningLevel: "high", permissionMode: "auto" } }, 0);
  await generateGuide(bb, store, "pr-1", "proj_work");
  await startConversation(bb, store, { targetKey: "pr-1", text: "Why?", agent: { hostId: "host_maxbook", ...codex } });
  const [guide, assistant] = harness.inspection.sdk.callsTo("threads.spawn").map(([args]) => args as any);
  expect(guide).toMatchObject({ projectId: "proj_personal", environment: { type: "host", hostId: "host_flomac", workspace: { type: "personal" } }, providerId: "claude-code", title: "Generate guide: pr-1" });
  expect(assistant).toMatchObject({ projectId: "proj_personal", environment: { type: "host", hostId: "host_maxbook", workspace: { type: "personal" } }, providerId: "codex" });
  for (const spawn of [guide, assistant]) expect(spawn).not.toHaveProperty("hostId");
});

test("an agent whose machine is offline or removed fails at once with the reason", async () => {
  const { bb, harness, store } = host();
  expect(await machineUnavailable(bb, null, "guide writer")).toBeNull();
  expect(await machineUnavailable(bb, { hostId: "host_flomac" }, "guide writer")).toBeNull();
  expect(await machineUnavailable(bb, { hostId: "host_old" }, "guide writer")).toBe("FloMac Original is offline. Wake it, or choose another machine for the guide writer in Review settings.");
  for (const hostId of ["host_gone", "host_missing"]) {
    expect(await machineUnavailable(bb, { hostId }, "guide writer")).toBe("The machine chosen for the guide writer was removed. Choose another in Review settings.");
  }
  await expect(startConversation(bb, store, { targetKey: "pr-1", text: "Why?", agent: { hostId: "host_old", ...codex } }))
    .rejects.toThrow("FloMac Original is offline. Wake it, or choose another machine for the review assistant in Review settings.");
  expect(harness.inspection.sdk.callsTo("threads.spawn")).toEqual([]);
  expect(store.getAssistantThread("pr-1")).toBeNull();
  // Only a missing machine reads as removed.
  harness.inspection.sdk.stub("hosts.get", async () => { throw new Error("Connection unavailable"); });
  await expect(machineUnavailable(bb, { hostId: "host_flomac" }, "guide writer")).rejects.toThrow("Connection unavailable");
});

test("a new conversation names the assistant's chosen machine", async () => {
  const { bb, store } = host();
  store.savePreferences({ ...defaultPreferences, assistantAgent: { hostId: "host_old", ...codex, permissionMode: "auto" } }, 0);
  expect(await getConversation(bb, store, "pr-1")).toMatchObject({ defaults: { hostId: "host_old", ...codex }, machine: { name: "FloMac Original", connected: false } });
  store.savePreferences({ ...defaultPreferences, assistantAgent: { hostId: "host_missing", ...codex, permissionMode: "auto" } }, 1);
  expect((await getConversation(bb, store, "pr-1")).machine).toBeNull();
});
