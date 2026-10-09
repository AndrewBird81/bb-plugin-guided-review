// @vitest-environment jsdom
import { useState } from "react";
import { test, expect, vi, afterEach, beforeEach } from "vitest";
import { act, cleanup, screen, fireEvent, waitFor, within } from "@testing-library/react";
import { installTestPluginRuntime, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import type { DockInjection } from "./AgentDock";

installTestPluginRuntime();
afterEach(cleanup);
beforeEach(() => localStorage.clear());

const patch = ["diff --git a/x.ts b/x.ts", "--- a/x.ts", "+++ b/x.ts", "@@ -1,3 +1,4 @@", " a", "-b", "+b2", "+c", " d", ""].join("\n");
const codex = { providerId: "codex", model: "gpt-6-astra", reasoningLevel: "low", serviceTier: "default" };
const unstarted = () => ({ threadId: null, legacy: [], defaults: codex });

/** Renders the dock with a way to send it selections, as the review workspace does. */
async function renderDock(props: Record<string, unknown>, rpc: Record<string, any>, options: Record<string, unknown> = {}) {
  const { AgentDock } = await import("./AgentDock");
  let setInjection!: (injection: DockInjection) => void;
  function Workspace(props: any) {
    const [injection, set] = useState<DockInjection>();
    setInjection = set;
    return <AgentDock {...props} injection={injection} />;
  }
  const slot = renderSlot({ component: Workspace }, { targetKey: "pr-1", patch, ...props }, { rpc, ...options });
  let nonce = 0;
  return { slot, inject: (context: DockInjection["context"]) => act(() => setInjection({ context, nonce: ++nonce })) };
}

test("the assistant starts in the review panel, with an optional widget", async () => {
  await renderDock({}, { getConversation: unstarted });
  await screen.findByText("Ask about this change.");
  expect(screen.getByRole("region", { name: "Review assistant" })).toBeTruthy();
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(screen.getByRole("button", { name: "Open assistant as widget" })).toBeTruthy();
  expect(screen.queryByRole("button", { name: "New conversation" })).toBeNull();
});

test("the first message starts the conversation on the chosen agent, then bb's chat takes over", async () => {
  const startConversation = vi.fn(async () => ({ threadId: "th-1" }));
  await renderDock({}, { getConversation: unstarted, startConversation });
  const picker = await screen.findByTestId("bb-provider-model-picker");
  expect((within(picker).getByRole("textbox", { name: "Model" }) as HTMLInputElement).value).toBe("gpt-6-astra");
  fireEvent.change(within(picker).getByRole("textbox", { name: "Model" }), { target: { value: "gpt-6" } });
  fireEvent.click(within(picker).getByRole("button", { name: "Apply execution selection" }));
  fireEvent.change(screen.getByRole("textbox", { name: "Ask the agent" }), { target: { value: "Is this safe?" } });
  fireEvent.keyDown(screen.getByRole("textbox", { name: "Ask the agent" }), { key: "Enter" });
  fireEvent.keyDown(screen.getByRole("textbox", { name: "Ask the agent" }), { key: "Enter" });
  const chat = await screen.findByTestId("bb-thread-chat");
  expect(chat.dataset).toMatchObject({ threadId: "th-1", variant: "compact", permissionPolicy: "inherit" });
  expect(startConversation).toHaveBeenCalledExactlyOnceWith({ targetKey: "pr-1", text: "Is this safe?", agent: { ...codex, model: "gpt-6" } });
  expect(screen.queryByRole("textbox", { name: "Ask the agent" })).toBeNull();
  expect(screen.getByRole("button", { name: "New conversation" })).toBeTruthy();
});

test("a selection becomes the first message's quoted context", async () => {
  const startConversation = vi.fn(async () => ({ threadId: "th-1" }));
  const { inject } = await renderDock({}, { getConversation: unstarted, startConversation });
  await screen.findByText("Ask about this change.");
  inject({ file: "x.ts", startLine: 2, endLine: 3, side: "additions" });
  expect(screen.getByText("x.ts:2–3")).toBeTruthy();
  fireEvent.change(screen.getByRole("textbox", { name: "Ask the agent" }), { target: { value: "Why?" } });
  fireEvent.click(screen.getByRole("button", { name: "Send" }));
  await screen.findByTestId("bb-thread-chat");
  expect(startConversation).toHaveBeenCalledWith({ targetKey: "pr-1", text: "Why?\n\nIn `x.ts` lines 2-3:\n```diff\n+b2\n+c\n```", agent: codex });
});

test("during a conversation, a selection is quoted into bb's composer for the reviewer to finish", async () => {
  const { slot, inject } = await renderDock({}, { getConversation: () => ({ threadId: "th-1", legacy: [], defaults: null }) }, { composer: { scope: { kind: "thread", threadId: "th-1" } } });
  await screen.findByTestId("bb-thread-chat");
  inject({ file: "x.ts", code: "const x = 1" });
  expect(slot.inspection.composer.text).toContain("In `x.ts`:\n```\nconst x = 1\n```");
  await waitFor(() => expect(slot.inspection.composer.focusCount).toBe(1));
  expect(screen.queryByRole("textbox", { name: "Ask the agent" })).toBeNull();
});

test("a draft question and selection survive popping out and docking, including fullscreen", async () => {
  const container = document.createElement("div"); document.body.appendChild(container);
  const onDock = vi.fn();
  const { slot, inject } = await renderDock({ container, onDock }, { getConversation: unstarted });
  await screen.findByText("Ask about this change.");
  inject({ file: "src/a.ts", chapterId: "c1" });
  fireEvent.change(screen.getByRole("textbox", { name: "Ask the agent" }), { target: { value: "Is this safe?" } });
  fireEvent.click(screen.getByRole("button", { name: "Open assistant as widget" }));
  const widget = await screen.findByRole("dialog", { name: "Review agent" });
  expect(container.contains(widget)).toBe(true);
  expect((screen.getByRole("textbox", { name: "Ask the agent" }) as HTMLTextAreaElement).value).toBe("Is this safe?");
  fireEvent.click(widget.querySelector('[aria-label="Dock in review panel"]')!);
  expect(screen.queryByRole("dialog")).toBeNull();
  expect((screen.getByRole("textbox", { name: "Ask the agent" }) as HTMLTextAreaElement).value).toBe("Is this safe?");
  expect(screen.getByText("a.ts")).toBeTruthy();
  expect(onDock).toHaveBeenCalledOnce();
  slot.lifecycle.unmount(); container.remove();
});

test("an earlier conversation stays visible, and New conversation starts over after confirming", async () => {
  const earlier = { threadId: "th-1", legacy: [{ id: 1, role: "user", text: "Earlier question", context: null, createdAt: 1 }], defaults: null };
  const getConversation = vi.fn().mockResolvedValueOnce(earlier).mockResolvedValue(unstarted());
  const newConversation = vi.fn(async () => ({ ok: true }));
  await renderDock({}, { getConversation, newConversation });
  expect(within(await screen.findByTestId("bb-thread-chat-leading-content")).getByText("Earlier question")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "New conversation" }));
  fireEvent.click(within(screen.getByRole("alertdialog", { name: "Start a new conversation" })).getByRole("button", { name: "Cancel" }));
  expect(newConversation).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "New conversation" }));
  fireEvent.click(screen.getByRole("button", { name: "Start new" }));
  await screen.findByText("Ask about this change.");
  expect(newConversation).toHaveBeenCalledExactlyOnceWith({ targetKey: "pr-1" });
  expect(screen.queryByText("Earlier question")).toBeNull();
});

test("a failed start keeps the question to try again", async () => {
  const startConversation = vi.fn(async () => { throw new Error("Provider \"codex\" is disabled."); });
  await renderDock({}, { getConversation: unstarted, startConversation });
  fireEvent.change(await screen.findByRole("textbox", { name: "Ask the agent" }), { target: { value: "A question" } });
  fireEvent.click(screen.getByRole("button", { name: "Send" }));
  await waitFor(() => expect(startConversation).toHaveBeenCalledOnce());
  await waitFor(() => expect((screen.getByRole("button", { name: "Send" }) as HTMLButtonElement).disabled).toBe(false));
  expect((screen.getByRole("textbox", { name: "Ask the agent" }) as HTMLTextAreaElement).value).toBe("A question");
  expect(screen.queryByTestId("bb-thread-chat")).toBeNull();
});
