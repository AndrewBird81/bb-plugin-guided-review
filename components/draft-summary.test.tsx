// @vitest-environment jsdom
import { useState } from "react";
import { afterEach, expect, test, vi } from "vitest";
import { cleanup, fireEvent, waitFor, within } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";

afterEach(() => { cleanup(); sessionStorage.clear(); localStorage.clear(); });

async function renderTray(targetKey: string, rpc: Record<string, unknown>, props: Record<string, unknown> = {}) {
  await loadPluginApp(() => import("../app"));
  const { DraftTray } = await import("./DraftTray");
  // "Show draft" stands in for the Feedback view's Use as draft.
  const component = () => {
    const [showDraft, setShowDraft] = useState<number>();
    return <><button onClick={() => setShowDraft(Date.now())}>Show draft</button><DraftTray targetKey={targetKey} activeChapterId="c1" activeFiles={["src/a.ts"]} reviewRevision="r1" showDraft={showDraft} {...props} /></>;
  };
  const slot = renderSlot({ component }, {}, { rpc: { setReviewPresence: () => ({ ok: true }), getReviewerNotes: () => ({ body: "", revision: 0 }), ...rpc } as any });
  return slot;
}
const pressed = (slot: Awaited<ReturnType<typeof renderTray>>, name: string) =>
  within(slot.getByRole("group", { name: "Review verdict" })).getByRole("button", { name }).getAttribute("aria-pressed");

test("the draft's verdict and summary reload when they change elsewhere", async () => {
  let draft = { targetKey: "sum", verdict: "COMMENT", body: "", comments: [] as any[] };
  const slot = await renderTray("sum", { getDraft: () => ({ draft }) });
  await slot.findByText("Draft saved");
  draft = { ...draft, verdict: "REQUEST_CHANGES", body: "Two asks remain." };
  await slot.emitRealtime("draft-summary:sum", {});
  await slot.findByText("Two asks remain.");
  expect(pressed(slot, "Request changes")).toBe("true");
  slot.lifecycle.unmount();
});

test("a suggestion over unsaved summary edits sets them aside to restore, and doesn't save over it", async () => {
  let draft = { targetKey: "keep", verdict: "COMMENT", body: "", comments: [] as any[] };
  const setVerdict = vi.fn(() => ({ draft }));
  const slot = await renderTray("keep", { getDraft: () => ({ draft }), setVerdict });
  await slot.findByText("Draft saved");
  fireEvent.click(slot.getByRole("button", { name: "Review summary" }));
  const summary = slot.getByRole("textbox", { name: "Review summary" }) as HTMLTextAreaElement;
  fireEvent.change(summary, { target: { value: "My own words." } });
  draft = { ...draft, verdict: "APPROVE", body: "Looks good now." };
  await slot.emitRealtime("draft-summary:keep", {});
  await waitFor(() => expect(summary.value).toBe("Looks good now."));
  expect(pressed(slot, "Approve")).toBe("true");
  expect(slot.getByText("The assistant’s suggestion replaced your unsaved summary.")).toBeTruthy();
  // The pending save of the reviewer's text doesn't overwrite the suggestion.
  await new Promise((resolve) => setTimeout(resolve, 500));
  expect(setVerdict).not.toHaveBeenCalled();
  expect(sessionStorage.getItem("guided-review:draft-recovery:keep")).toBeNull();

  fireEvent.click(slot.getByRole("button", { name: "Restore yours" }));
  expect(summary.value).toBe("My own words.");
  expect(pressed(slot, "Comment")).toBe("true");
  expect(slot.queryByText("The assistant’s suggestion replaced your unsaved summary.")).toBeNull();
  await waitFor(() => expect(setVerdict).toHaveBeenCalledWith({ targetKey: "keep", verdict: "COMMENT", body: "My own words.", revision: "r1" }));
  slot.lifecycle.unmount();
});

test("showDraft opens Draft comments with the summary", async () => {
  const draft = { targetKey: "show", verdict: "APPROVE", body: "Looks good now.", comments: [] as any[] };
  localStorage.setItem("gr:panelstate", JSON.stringify({ perReview: { show: { activeTool: "notes", toolsOpen: false } } }));
  const slot = await renderTray("show", { getDraft: () => ({ draft }) });
  const draftTool = slot.getByRole("button", { name: "Draft comments" });
  expect(draftTool.getAttribute("aria-pressed")).toBe("false");
  fireEvent.click(slot.getByRole("button", { name: "Show draft" }));
  await waitFor(() => expect(draftTool.getAttribute("aria-pressed")).toBe("true"));
  expect((await slot.findByRole("textbox", { name: "Review summary" }) as HTMLTextAreaElement).value).toBe("Looks good now.");
  slot.lifecycle.unmount();
});

test("a submitted review's receipt names its verdict", async () => {
  const draft = { targetKey: "done", verdict: "COMMENT", body: "", comments: [] as any[] };
  const slot = await renderTray("done", { getDraft: () => ({ draft }) }, { review: { targetKey: "done", submittedVerdict: "REQUEST_CHANGES", submittedHeadSha: "a", headSha: "b" } });
  const receipt = await slot.findByRole("region", { name: "Submitted review" });
  expect(within(receipt).getByText("Changes requested")).toBeTruthy();
  slot.lifecycle.unmount();
});
