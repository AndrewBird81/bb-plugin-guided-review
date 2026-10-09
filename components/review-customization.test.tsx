import { useState } from "react";
import { afterEach, expect, test, vi } from "vitest";
import { cleanup, fireEvent, waitFor, within } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { defaultPreferences } from "../src/preferences";

afterEach(cleanup);

test("settings have an installed slot, save explicitly, and restore defaults without silently saving", async () => {
  const app = await loadPluginApp(() => import("../app"));
  expect(app.settingsSections).toHaveLength(1);
  const { ReviewSettings } = await import("./ReviewSettings");
  let record = { preferences: { ...defaultPreferences }, revision: 0 };
  const save = vi.fn(async (input: any) => record = { ...input, revision: input.revision + 1 });
  const slot = renderSlot({ component: ReviewSettings }, {}, { rpc: { setReviewPresence: () => ({ ok: true }), getPreferences: () => record, savePreferences: save } });
  await slot.findByRole("textbox", { name: "Guide instructions" });
  fireEvent.change(slot.getByRole("textbox", { name: "Guide instructions" }), { target: { value: "Explain compatibility" } });
  fireEvent.click(slot.getByRole("button", { name: /^Detailed$/ }));
  expect(save).not.toHaveBeenCalled();
  fireEvent.click(slot.getByRole("button", { name: "Save settings" }));
  await slot.findByText("Settings saved");
  expect(record.preferences).toMatchObject({ guideInstructions: "Explain compatibility", guideDetail: "detailed" });
  fireEvent.click(slot.getByRole("button", { name: "Restore defaults" }));
  expect(save).toHaveBeenCalledTimes(1);
  fireEvent.click(slot.getByRole("button", { name: "Save settings" }));
  await waitFor(() => expect(record.preferences).toEqual(defaultPreferences));
  slot.lifecycle.unmount();
});

test("private notes survive leaving the editor and never use the public summary RPC", async () => {
  await loadPluginApp(() => import("../app"));
  const { ReviewerNotes } = await import("./ReviewerNotes");
  let stored = { body: "", revision: 0 };
  const save = vi.fn(async ({ body, revision }: any) => stored = { body, revision: revision + 1 });
  const setVerdict = vi.fn();
  const slot = renderSlot({ component: ReviewerNotes }, { targetKey: "private-notes" }, { rpc: { getReviewerNotes: () => stored, saveReviewerNotes: save, setVerdict } });
  await slot.findByText("Notes saved");
  fireEvent.change(slot.getByRole("textbox", { name: "Private reviewer notes" }), { target: { value: "Check rollout with my team" } });
  slot.lifecycle.unmount();
  await waitFor(() => expect(stored.body).toBe("Check rollout with my team"));
  expect(setVerdict).not.toHaveBeenCalled();
});

test("failed note writes preserve a recoverable copy after remount", async () => {
  await loadPluginApp(() => import("../app"));
  const { ReviewerNotes } = await import("./ReviewerNotes");
  const rpc = { getReviewerNotes: () => ({ body: "", revision: 0 }), saveReviewerNotes: vi.fn(async () => { throw new Error("Offline"); }) };
  let slot = renderSlot({ component: ReviewerNotes }, { targetKey: "recover-notes" }, { rpc });
  await slot.findByText("Notes saved");
  fireEvent.change(slot.getByRole("textbox", { name: "Private reviewer notes" }), { target: { value: "Do not lose this" } });
  fireEvent.blur(slot.getByRole("textbox", { name: "Private reviewer notes" }));
  await slot.findByRole("alert");
  slot.lifecycle.unmount();
  await waitFor(() => expect(rpc.saveReviewerNotes).toHaveBeenCalledTimes(2));
  slot = renderSlot({ component: ReviewerNotes }, { targetKey: "recover-notes" }, { rpc });
  await slot.findByText("Recovered unsaved notes. Save when ready.");
  expect((slot.getByRole("textbox", { name: "Private reviewer notes" }) as HTMLTextAreaElement).value).toBe("Do not lose this");
  slot.lifecycle.unmount();
});

test("editing a draft comment replaces it without changing its location", async () => {
  await loadPluginApp(() => import("../app"));
  const { DraftTray } = await import("./DraftTray");
  const comment = { file: "a.ts", line: 1, side: "RIGHT", body: "Old feedback", chapterId: "original" };
  const draft = { targetKey: "edit", verdict: "COMMENT", body: "", comments: [comment] };
  const save = vi.fn(async ({ comment }: any) => ({ draft: { ...draft, comments: [comment] } }));
  const slot = renderSlot({ component: (props: any) => <DraftTray {...props} /> }, { targetKey: "edit", activeChapterId: "other", activeFiles: ["b.ts"] }, { rpc: { getDraft: () => ({ draft }), getReviewerNotes: () => ({ body: "", revision: 0 }), saveDraftComment: save } });
  fireEvent.click(await slot.findByRole("button", { name: "Edit comment on a.ts:1" }));
  expect((slot.getByRole("textbox", { name: "Comment file" }) as HTMLInputElement).disabled).toBe(true);
  fireEvent.change(slot.getByRole("textbox", { name: "Draft comment" }), { target: { value: "Clearer feedback" } });
  fireEvent.click(slot.getByRole("button", { name: "Save comment" }));
  await slot.findByText("Clearer feedback");
  expect(save).toHaveBeenCalledWith({ targetKey: "edit", comment: { ...comment, body: "Clearer feedback" } });
  slot.lifecycle.unmount();
});

test("comparing conflicting notes preserves edits made while the saved version loads", async () => {
  await loadPluginApp(() => import("../app"));
  const { ReviewerNotes } = await import("./ReviewerNotes");
  let complete!: (notes: { body: string; revision: number }) => void;
  const get = vi.fn().mockResolvedValueOnce({ body: "Original", revision: 1 }).mockImplementation(() => new Promise((resolve) => { complete = resolve; }));
  const save = vi.fn().mockRejectedValueOnce(new Error("Notes changed in another window")).mockResolvedValue({ body: "My newer edits", revision: 3 });
  const slot = renderSlot({ component: ReviewerNotes }, { targetKey: "conflict-notes" }, { rpc: { getReviewerNotes: get, saveReviewerNotes: save } });
  await slot.findByText("Notes saved");
  const editor = slot.getByRole("textbox", { name: "Private reviewer notes" }) as HTMLTextAreaElement;
  fireEvent.change(editor, { target: { value: "My edits" } }); fireEvent.blur(editor);
  fireEvent.click(await slot.findByRole("button", { name: "Compare saved notes" }));
  await waitFor(() => expect(complete).toBeTypeOf("function"));
  fireEvent.change(editor, { target: { value: "My newer edits" } });
  complete({ body: "Other window", revision: 2 });
  await slot.findByRole("textbox", { name: "Saved reviewer notes" });
  expect(editor.value).toBe("My newer edits");
  fireEvent.click(slot.getByRole("button", { name: "Save my version" }));
  await waitFor(() => expect(save).toHaveBeenLastCalledWith({ targetKey: "conflict-notes", body: "My newer edits", revision: 2 }));
  slot.lifecycle.unmount();
});

test("the review activity rail collapses each tool without losing editor state", async () => {
  await loadPluginApp(() => import("../app"));
  const { DraftTray } = await import("./DraftTray");
  const slot = renderSlot({ component: (props: any) => <DraftTray {...props} /> }, { targetKey: "sidebar-editors", activeChapterId: "c1", activeFiles: ["a.ts"], agent: {} }, { rpc: {
    getDraft: () => ({ draft: { targetKey: "sidebar-editors", verdict: "COMMENT", body: "", comments: [] } }),
    getReviewerNotes: () => ({ body: "", revision: 0 }), saveReviewerNotes: ({ body }: any) => ({ body, revision: 1 }),
    getConversation: () => ({ threadId: null, legacy: [], defaults: null }),
  } });
  fireEvent.click(await slot.findByRole("button", { name: "Add comment" }));
  fireEvent.change(slot.getByRole("textbox", { name: "Draft comment" }), { target: { value: "Keep this unfinished comment" } });
  fireEvent.click(slot.getByRole("button", { name: "Draft comments" }));
  expect(slot.queryByRole("textbox", { name: "Draft comment" })).toBeNull();
  for (const name of ["Draft comments", "Reviewer notes", "Ask agent"]) {
    expect(slot.getByRole("button", { name }).querySelector("svg")).toBeTruthy();
  }
  fireEvent.click(slot.getByRole("button", { name: "Reviewer notes" }));
  fireEvent.change(await slot.findByRole("textbox", { name: "Private reviewer notes" }), { target: { value: "Keep my notes" } });
  fireEvent.click(within(slot.getByRole("group", { name: "Review tools" })).getByRole("button", { name: "Collapse review panel" }));
  expect(slot.queryByRole("textbox", { name: "Private reviewer notes" })).toBeNull();
  fireEvent.click(slot.getByRole("button", { name: "Ask agent" }));
  fireEvent.change(await slot.findByRole("textbox", { name: "Ask the agent" }), { target: { value: "Keep this question" } });
  fireEvent.click(slot.getByRole("button", { name: "Ask agent" }));
  expect(slot.queryByRole("textbox", { name: "Ask the agent" })).toBeNull();
  fireEvent.click(slot.getByRole("button", { name: "Ask agent" }));
  expect((slot.getByRole("textbox", { name: "Ask the agent" }) as HTMLTextAreaElement).value).toBe("Keep this question");
  fireEvent.click(slot.getByRole("button", { name: "Reviewer notes" }));
  expect((slot.getByRole("textbox", { name: "Private reviewer notes" }) as HTMLTextAreaElement).value).toBe("Keep my notes");
  fireEvent.click(slot.getByRole("button", { name: "Draft comments" }));
  expect((slot.getByRole("textbox", { name: "Draft comment" }) as HTMLTextAreaElement).value).toBe("Keep this unfinished comment");
  slot.lifecycle.unmount();
});

test("collapsed tool choice survives remount", async () => {
  await loadPluginApp(() => import("../app"));
  const { DraftTray } = await import("./DraftTray");
  const props = { targetKey: "sidebar-restore", activeChapterId: "c1", activeFiles: ["a.ts"] };
  const rpc = { getDraft: () => ({ draft: { targetKey: props.targetKey, verdict: "COMMENT", body: "", comments: [] } }), getReviewerNotes: () => ({ body: "", revision: 0 }) };
  let slot = renderSlot({ component: (props: any) => <DraftTray {...props} /> }, props, { rpc });
  fireEvent.click(await slot.findByRole("button", { name: "Reviewer notes" }));
  fireEvent.click(within(slot.getByRole("group", { name: "Review tools" })).getByRole("button", { name: "Collapse review panel" }));
  slot.lifecycle.unmount();
  slot = renderSlot({ component: (props: any) => <DraftTray {...props} /> }, props, { rpc });
  expect(slot.queryByRole("textbox", { name: "Private reviewer notes" })).toBeNull();
  expect(slot.getByRole("button", { name: "Reviewer notes" }).getAttribute("aria-expanded")).toBe("false");
  slot.lifecycle.unmount();
});

test("a new line-comment request reveals an unfinished comment without replacing it", async () => {
  await loadPluginApp(() => import("../app"));
  const { DraftTray } = await import("./DraftTray");
  function Workspace() {
    const [nonce, setNonce] = useState(0);
    return <><button onClick={() => setNonce((value) => value + 1)}>Comment on selected line</button><DraftTray targetKey="unfinished-comment" activeChapterId="c1" activeFiles={["a.ts"]} prefill={nonce ? { file: "b.ts", line: 7, side: "RIGHT", nonce } : undefined} /></>;
  }
  const slot = renderSlot({ component: Workspace }, {}, { rpc: {
    getDraft: () => ({ draft: { targetKey: "unfinished-comment", verdict: "COMMENT", body: "", comments: [] } }), getReviewerNotes: () => ({ body: "", revision: 0 }),
  } });
  fireEvent.click(await slot.findByRole("button", { name: "Add comment" }));
  fireEvent.change(slot.getByRole("textbox", { name: "Draft comment" }), { target: { value: "Keep this unfinished comment" } });
  fireEvent.click(slot.getByRole("button", { name: "Draft comments" }));
  fireEvent.click(slot.getByRole("button", { name: "Comment on selected line" }));
  const editor = await slot.findByRole("textbox", { name: "Draft comment" }) as HTMLTextAreaElement;
  expect(editor.value).toBe("Keep this unfinished comment");
  expect((slot.getByRole("textbox", { name: "Comment file" }) as HTMLInputElement).value).toBe("a.ts");
  await waitFor(() => expect(document.activeElement).toBe(editor));
  slot.lifecycle.unmount();
});

test("each agent uses project defaults until customized with bb's pickers", async () => {
  await loadPluginApp(() => import("../app"));
  const { ReviewSettings } = await import("./ReviewSettings");
  let record = { preferences: { ...defaultPreferences }, revision: 0 };
  const save = vi.fn(async (input: any) => record = { ...input, revision: input.revision + 1 });
  const defaults = { providerId: "codex", model: "gpt-6-astra", reasoningLevel: "low", permissionMode: "auto", serviceTier: "default" };
  const getAgentDefaults = vi.fn().mockResolvedValueOnce({ defaults }).mockRejectedValueOnce(new Error("Offline"));
  const slot = renderSlot({ component: ReviewSettings }, {}, { rpc: { setReviewPresence: () => ({ ok: true }), getPreferences: () => record, savePreferences: save, getAgentDefaults } });
  const guide = await slot.findByRole("group", { name: "Guide writer agent" });
  const assistant = slot.getByRole("group", { name: "Review assistant agent" });
  expect(within(guide).getByRole("button", { name: "Project defaults" }).getAttribute("aria-pressed")).toBe("true");
  expect(slot.queryByTestId("bb-provider-model-picker")).toBeNull();

  // Custom starts from the personal project's defaults.
  fireEvent.click(within(guide).getByRole("button", { name: "Custom" }));
  const picker = await slot.findByTestId("bb-provider-model-picker");
  expect((within(picker).getByRole("textbox", { name: "Model" }) as HTMLInputElement).value).toBe("gpt-6-astra");
  fireEvent.change(within(picker).getByRole("textbox", { name: "Model" }), { target: { value: "gpt-6" } });
  fireEvent.change(within(picker).getByRole("textbox", { name: "Reasoning level" }), { target: { value: "high" } });
  fireEvent.change(within(picker).getByRole("combobox", { name: "Service tier" }), { target: { value: "fast" } });
  fireEvent.click(within(picker).getByRole("button", { name: "Apply execution selection" }));
  fireEvent.change(slot.getByRole("combobox", { name: "Permission mode" }), { target: { value: "full" } });

  // Without defaults, saving waits until the pickers resolve a provider and model.
  fireEvent.click(within(assistant).getByRole("button", { name: "Custom" }));
  await waitFor(() => expect(slot.getAllByTestId("bb-provider-model-picker")).toHaveLength(2));
  expect((slot.getByRole("button", { name: "Save settings" }) as HTMLButtonElement).disabled).toBe(true);
  const second = slot.getAllByTestId("bb-provider-model-picker")[1];
  fireEvent.change(within(second).getByRole("textbox", { name: "Provider ID" }), { target: { value: "pi" } });
  fireEvent.change(within(second).getByRole("textbox", { name: "Model" }), { target: { value: "local" } });
  fireEvent.click(within(second).getByRole("button", { name: "Apply execution selection" }));
  fireEvent.click(slot.getByRole("button", { name: "Save settings" }));
  await slot.findByText("Settings saved");
  expect(record.preferences.guideAgent).toEqual({ providerId: "codex", model: "gpt-6", reasoningLevel: "high", permissionMode: "full", serviceTier: "fast" });
  expect(record.preferences.assistantAgent).toEqual({ providerId: "pi", model: "local", reasoningLevel: "medium", permissionMode: "auto" });

  fireEvent.click(within(guide).getByRole("button", { name: "Project defaults" }));
  expect(slot.getAllByTestId("bb-provider-model-picker")).toHaveLength(1);
  fireEvent.click(slot.getByRole("button", { name: "Save settings" }));
  await waitFor(() => expect(record.preferences.guideAgent).toBeNull());
  slot.lifecycle.unmount();
});

const listMachines = () => ({ machines: [
  { hostId: "host_server", name: "bb-server-0", connected: true, server: true },
  { hostId: "host_flomac", name: "FloMac", connected: true, server: false },
  { hostId: "host_old", name: "FloMac Original", connected: false, server: false },
] });

test("a custom agent can run on another machine, with bb's pickers listing that machine's choices", async () => {
  await loadPluginApp(() => import("../app"));
  const { ReviewSettings } = await import("./ReviewSettings");
  const codex = { providerId: "codex", model: "gpt-6-astra", reasoningLevel: "low", permissionMode: "auto" };
  let record: any = { preferences: { ...defaultPreferences, guideAgent: codex }, revision: 0 };
  const save = vi.fn(async (input: any) => record = { ...input, revision: input.revision + 1 });
  const slot = renderSlot({ component: ReviewSettings }, {}, { rpc: { setReviewPresence: () => ({ ok: true }), getPreferences: () => record, savePreferences: save, listMachines } });
  const machine = await slot.findByRole("combobox", { name: "Machine" }) as HTMLSelectElement;
  await waitFor(() => expect(Array.from(machine.options).map((option) => option.text)).toEqual(["bb-server-0 (server)", "FloMac", "FloMac Original (offline)"]));
  const picker = slot.getByTestId("bb-provider-model-picker");
  expect(picker.dataset.routingKind).toBe("primary");

  fireEvent.change(machine, { target: { value: "host_flomac" } });
  for (const routed of [picker, slot.getByTestId("bb-permission-mode-picker")]) expect(routed.dataset).toMatchObject({ routingKind: "host", routingId: "host_flomac" });
  fireEvent.change(within(picker).getByRole("textbox", { name: "Provider ID" }), { target: { value: "claude-code" } });
  fireEvent.change(within(picker).getByRole("textbox", { name: "Model" }), { target: { value: "claude-opus-5-5" } });
  fireEvent.click(within(picker).getByRole("button", { name: "Apply execution selection" }));
  fireEvent.click(slot.getByRole("button", { name: "Save settings" }));
  await slot.findByText("Settings saved");
  const onFloMac = { hostId: "host_flomac", providerId: "claude-code", model: "claude-opus-5-5", reasoningLevel: "low", permissionMode: "auto" };
  expect(record.preferences.guideAgent).toEqual(onFloMac);

  // The server is stored as no machine.
  fireEvent.change(slot.getByRole("combobox", { name: "Machine" }), { target: { value: "" } });
  expect(slot.getByTestId("bb-provider-model-picker").dataset.routingKind).toBe("primary");
  fireEvent.click(slot.getByRole("button", { name: "Save settings" }));
  await waitFor(() => expect(record.preferences.guideAgent).toEqual({ ...onFloMac, hostId: undefined }));
  expect(record.preferences.guideAgent).not.toHaveProperty("hostId");
  slot.lifecycle.unmount();
});

test("a saved machine that was removed, or a machine list that won't load, is labeled", async () => {
  await loadPluginApp(() => import("../app"));
  const { ReviewSettings } = await import("./ReviewSettings");
  const assistantAgent = { hostId: "host_gone", providerId: "codex", model: "gpt-6", reasoningLevel: "low", permissionMode: "auto" };
  let record = { preferences: { ...defaultPreferences, assistantAgent }, revision: 1 };
  const rpc = { setReviewPresence: () => ({ ok: true }), getPreferences: () => record, listMachines };
  let slot = renderSlot({ component: ReviewSettings }, {}, { rpc });
  let machine = await slot.findByRole("combobox", { name: "Machine" }) as HTMLSelectElement;
  await waitFor(() => expect(machine.selectedOptions[0].text).toBe("Removed machine"));
  slot.lifecycle.unmount();

  // A machine that became the server, such as after a server move, shows as the server.
  record = { preferences: { ...defaultPreferences, assistantAgent: { ...assistantAgent, hostId: "host_server" } }, revision: 1 };
  slot = renderSlot({ component: ReviewSettings }, {}, { rpc });
  machine = await slot.findByRole("combobox", { name: "Machine" }) as HTMLSelectElement;
  await waitFor(() => expect(machine.selectedOptions[0].text).toBe("bb-server-0 (server)"));
  slot.lifecycle.unmount();
  record = { preferences: { ...defaultPreferences, assistantAgent }, revision: 1 };

  slot = renderSlot({ component: ReviewSettings }, {}, { rpc: { ...rpc, listMachines: async () => { throw new Error("Offline"); } } });
  await slot.findByText("Couldn’t load your machines. Reload this page to choose another machine.");
  machine = slot.getByRole("combobox", { name: "Machine" }) as HTMLSelectElement;
  expect(machine.selectedOptions[0].text).toBe("host_gone");
  slot.lifecycle.unmount();
});

test("the automatic review prompt starts from the default and can be turned off", async () => {
  await loadPluginApp(() => import("../app"));
  const { ReviewSettings } = await import("./ReviewSettings");
  let record = { preferences: { ...defaultPreferences }, revision: 0 };
  const save = vi.fn(async (input: any) => record = { ...input, revision: input.revision + 1 });
  const slot = renderSlot({ component: ReviewSettings }, {}, { rpc: { setReviewPresence: () => ({ ok: true }), getPreferences: () => record, savePreferences: save } });
  const prompt = await slot.findByRole("textbox", { name: "Automatic review" }) as HTMLTextAreaElement;
  expect(prompt.value).toBe(defaultPreferences.automaticReview);
  expect(prompt.value).toContain("add_draft_comment");
  fireEvent.change(prompt, { target: { value: "" } });
  fireEvent.click(slot.getByRole("button", { name: "Save settings" }));
  await slot.findByText("Settings saved");
  expect(record.preferences.automaticReview).toBe("");
  slot.lifecycle.unmount();
});

test("an assistant's comment appears in an open draft, and Submit sends only the comments shown", async () => {
  await loadPluginApp(() => import("../app"));
  const { DraftTray } = await import("./DraftTray");
  const mine = { file: "a.ts", line: 1, side: "RIGHT", body: "My comment", chapterId: "c1" };
  const theirs = { file: "a.ts", line: 2, side: "RIGHT", body: "The assistant's comment" };
  const stored = { targetKey: "live", verdict: "COMMENT", body: "", comments: [mine] as any[] };
  const submitReview = vi.fn(() => ({ ok: false, error: "Not now" }));
  const slot = renderSlot({ component: (props: any) => <DraftTray {...props} /> }, { targetKey: "live", activeChapterId: "c1", activeFiles: ["a.ts"], reviewRevision: "r1", account: "reviewer" }, { rpc: {
    setReviewPresence: () => ({ ok: true }), getReviewerNotes: () => ({ body: "", revision: 0 }), getDraft: () => ({ draft: structuredClone(stored) }), submitReview,
  } });
  await slot.findByText("My comment");
  stored.comments.push(theirs);
  await slot.emitRealtime("draft:live", {});
  await slot.findByText("The assistant's comment");
  fireEvent.click(slot.getByRole("button", { name: "Submit to GitHub" }));
  await waitFor(() => expect(submitReview).toHaveBeenCalledWith({ targetKey: "live", revision: "r1", account: "reviewer", comments: [mine, theirs] }));
  slot.lifecycle.unmount();
});

test("a draft labels agents' comments, and Remove names the comment's location", async () => {
  await loadPluginApp(() => import("../app"));
  const { DraftTray } = await import("./DraftTray");
  const mine = { file: "a.ts", line: 1, side: "RIGHT", body: "My comment" };
  const theirs = { file: "a.ts", line: 2, side: "LEFT", author: "agent", body: "The agent's comment" };
  const draft = { targetKey: "labels", verdict: "COMMENT", body: "", comments: [mine, theirs] };
  const removeDraftComment = vi.fn(() => ({ draft: { ...draft, comments: [mine] } }));
  const slot = renderSlot({ component: (props: any) => <DraftTray {...props} /> }, { targetKey: "labels", activeChapterId: "c1", activeFiles: ["a.ts"] }, { rpc: {
    setReviewPresence: () => ({ ok: true }), getReviewerNotes: () => ({ body: "", revision: 0 }), getDraft: () => ({ draft }), removeDraftComment,
  } });
  await slot.findByText("a.ts:2 · Original · Added by agent");
  expect(slot.getByText("a.ts:1 · Changed")).toBeTruthy();
  fireEvent.click(slot.getByRole("button", { name: "Remove comment on a.ts:2" }));
  await waitFor(() => expect(removeDraftComment).toHaveBeenCalledWith({ targetKey: "labels", file: "a.ts", line: 2, side: "LEFT" }));
  await waitFor(() => expect(slot.queryByText("The agent's comment")).toBeNull());
  slot.lifecycle.unmount();
});
