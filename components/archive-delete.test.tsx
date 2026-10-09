// @vitest-environment jsdom
import { afterEach, expect, test } from "vitest";
import { cleanup, fireEvent, waitFor, within } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { patchReviewState } from "../lib/panel-state";
import { readDraftRecovery, updateDraftRecovery } from "../lib/draft-recovery";
afterEach(() => { cleanup(); localStorage.clear(); sessionStorage.clear(); });

const guide = { title: "Guide", intent: "Intent", sections: [{ id: "core", title: "Core", overview: "Overview", diffs: [{ file: "a.ts", summary: "Adds a" }] }], unplacedFiles: [] };

/** The saved-review list over an in-memory list that archive/delete RPCs update. */
async function list(initial: any[], overrides: Record<string, (input: any) => unknown> = {}) {
  let reviews = initial;
  const app = await loadPluginApp(() => import("../app"));
  const slot = renderSlot(app.navPanels[0]!, { subPath: "" }, { rpc: {
    setReviewPresence: () => ({ ok: true }),
    getGhAccounts: () => ({ active: "me", accounts: [] }),
    listReviews: () => ({ reviews }),
    archiveReview: ({ targetKey, archived }: any) => { reviews = reviews.map((r) => r.targetKey === targetKey ? { ...r, userArchivedAt: archived ? 5 : null } : r); return { ok: true }; },
    deleteReview: ({ targetKey }: any) => { reviews = reviews.filter((r) => r.targetKey !== targetKey); return { ok: true }; },
    ...overrides,
  } });
  const tab = async (name: RegExp) => fireEvent.click(within(await slot.findByRole("group", { name: "Filter reviews" })).getByRole("button", { name }));
  const menu = () => fireEvent.click(slot.getByRole("button", { name: "Review actions" }));
  return { slot, tab, menu, calls: (method: string) => slot.inspection.rpcCalls.filter((call) => call.method === method).map((call) => call.input) };
}

test("archiving an unfinished review moves it to Archive until it is unarchived", async () => {
  const { slot, tab, menu, calls } = await list([{ targetKey: "a", title: "Abandoned change", status: "ready", prState: "OPEN" }]);
  await slot.findByText("Abandoned change");
  expect(slot.getByRole("button", { name: "Review actions" }).getAttribute("aria-describedby")).toBe(slot.getByText("Abandoned change").id);
  menu();
  fireEvent.click(await slot.findByRole("button", { name: "Archive" }));
  await slot.findByText("You’re all caught up");
  expect(calls("archiveReview")).toEqual([{ targetKey: "a", archived: true }]);

  await tab(/^Archive/);
  await slot.findByText("Abandoned change");
  expect(slot.getByText("Archived")).toBeTruthy();
  menu();
  fireEvent.click(await slot.findByRole("button", { name: "Unarchive" }));
  await slot.findByText("No archived reviews");
  expect(calls("archiveReview")).toEqual([{ targetKey: "a", archived: true }, { targetKey: "a", archived: false }]);
  await tab(/^Needs review/);
  await slot.findByText("Abandoned change");
  slot.lifecycle.unmount();
});

test("merged reviews can be deleted but not unarchived", async () => {
  const { slot, tab, menu } = await list([{ targetKey: "m", title: "Shipped change", status: "ready", prState: "MERGED", archivedAt: 1, userArchivedAt: 1 }]);
  await tab(/^Archive/);
  await slot.findByText("Shipped change");
  expect(slot.getByText("Merged")).toBeTruthy();
  menu();
  await slot.findByRole("button", { name: "Delete…" });
  expect(slot.queryByRole("button", { name: "Unarchive" })).toBeNull();
  expect(slot.queryByRole("button", { name: "Archive" })).toBeNull();
  slot.lifecycle.unmount();
});

test("deleting asks for confirmation first, then removes the review and its unsaved recovery text", async () => {
  updateDraftRecovery("d", { summary: { verdict: "COMMENT", body: "Unsaved thoughts" } });
  const { slot, menu, calls } = await list([{ targetKey: "d", title: "Unwanted change", status: "error" }]);
  await slot.findByText("Unwanted change");
  menu();
  fireEvent.click(await slot.findByRole("button", { name: "Delete…" }));
  const dialog = await slot.findByRole("dialog", { name: "Delete this review?" });
  expect(within(dialog).getByText(/“Unwanted change” will be permanently removed/)).toBeTruthy();
  fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
  await waitFor(() => expect(slot.queryByRole("dialog")).toBeNull());
  expect(calls("deleteReview")).toEqual([]);

  menu();
  fireEvent.click(await slot.findByRole("button", { name: "Delete…" }));
  fireEvent.click(within(await slot.findByRole("dialog")).getByRole("button", { name: "Delete review" }));
  await slot.findByText("No reviews yet");
  expect(calls("deleteReview")).toEqual([{ targetKey: "d" }]);
  expect(readDraftRecovery("d")).toEqual({});
  slot.lifecycle.unmount();
});

test("a refused delete keeps the review and the confirmation open", async () => {
  const { slot, menu } = await list([{ targetKey: "b", title: "Busy change", status: "ready" }], {
    deleteReview: () => ({ ok: false, error: "Wait for the assistant to finish answering, then delete the review." }),
  });
  await slot.findByText("Busy change");
  menu();
  fireEvent.click(await slot.findByRole("button", { name: "Delete…" }));
  fireEvent.click(within(await slot.findByRole("dialog")).getByRole("button", { name: "Delete review" }));
  await waitFor(() => expect(within(slot.getByRole("dialog")).getByRole("button", { name: "Delete review" }).hasAttribute("disabled")).toBe(false));
  expect(slot.getByText("Busy change")).toBeTruthy();
  slot.lifecycle.unmount();
});

test("a generating review can be archived but not deleted", async () => {
  const { slot, menu } = await list([{ targetKey: "g", title: "Fresh change", status: "generating" }]);
  await slot.findByText("Fresh change");
  menu();
  expect((await slot.findByRole("button", { name: "Delete…" })).hasAttribute("disabled")).toBe(true);
  expect(slot.getByText("You can delete this review once its guide finishes generating.")).toBeTruthy();
  expect(slot.getByRole("button", { name: "Archive" }).hasAttribute("disabled")).toBe(false);
  slot.lifecycle.unmount();
});

test("deleting from the open review returns to the list", async () => {
  const app = await loadPluginApp(() => import("../app"));
  patchReviewState("pr-7", { view: "threads" }); // jsdom can't render the diff web component
  const slot = renderSlot(app.navPanels[0]!, { subPath: "pr-7" }, { rpc: {
    setReviewPresence: () => ({ ok: true }),
    getReviewBundle: () => ({ review: { targetKey: "pr-7", kind: "pr", title: "Fix login", status: "ready" }, guide, patch: "", revision: "r1" }),
    getChecks: () => ({ bucket: "none", checks: [] }),
    deleteReview: () => ({ ok: true }),
  } });
  await slot.findByText("Fix login");
  fireEvent.click(slot.getByRole("button", { name: "Review actions" }));
  fireEvent.click(await slot.findByRole("button", { name: "Delete…" }));
  fireEvent.click(within(await slot.findByRole("dialog")).getByRole("button", { name: "Delete review" }));
  await waitFor(() => expect(slot.inspection.navigateCalls).toContainEqual({ method: "toPluginPanel", path: "review" }));
  slot.lifecycle.unmount();
});

test("an open review deleted elsewhere shows Review not found, not a regeneration", async () => {
  const app = await loadPluginApp(() => import("../app"));
  patchReviewState("pr-7", { view: "threads" });
  let deleted = false;
  const slot = renderSlot(app.navPanels[0]!, { subPath: "pr-7" }, { rpc: {
    setReviewPresence: () => ({ ok: true }),
    getReviewBundle: () => deleted ? { review: null, guide: null, patch: "", revision: "r0" } : { review: { targetKey: "pr-7", kind: "pr", title: "Fix login", status: "ready" }, guide, patch: "", revision: "r1" },
    getChecks: () => ({ bucket: "none", checks: [] }),
  } });
  await slot.findByText("Fix login");
  deleted = true;
  await slot.behavior.emitRealtime("review:pr-7", { ts: 1 });
  await slot.findByText("Review not found");
  slot.lifecycle.unmount();
});
