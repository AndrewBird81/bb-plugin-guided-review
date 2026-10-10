// @vitest-environment jsdom
import { afterEach, expect, test, vi } from "vitest";
import { cleanup, fireEvent, waitFor, within } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { defaultPreferences } from "../src/preferences";
import type { Turn } from "../lib/turn";
afterEach(cleanup);

const DAY = 86_400_000;
const now = Date.now();
const turn = (group: Turn["group"], reason: Turn["reason"], label: string, extra: Partial<Turn> = {}): Turn =>
  ({ group, reason, label, action: "Open review", signal: null, at: null, notify: false, blocking: false, updated: false, eventAt: null, failed: false, ...extra });

async function list(reviews: any[], overrides: Record<string, (input: any) => unknown> = {}) {
  const app = await loadPluginApp(() => import("../app"));
  const slot = renderSlot(app.navPanels[0]!, { subPath: "" }, { rpc: {
    setReviewPresence: () => ({ ok: true }),
    getGhAccounts: () => ({ active: "me", accounts: [] }),
    listReviews: () => ({ reviews }),
    ...overrides,
  } });
  const tabs = () => within(slot.getByRole("group", { name: "Filter reviews" }));
  const tab = async (name: RegExp) => { await slot.findByRole("group", { name: "Filter reviews" }); fireEvent.click(tabs().getByRole("button", { name })); };
  const titles = () => slot.getAllByText(/^Change \w+$/).map((title) => title.textContent);
  const calls = (method: string) => slot.inspection.rpcCalls.filter((call) => call.method === method).map((call) => call.input);
  return { slot, tabs, tab, titles, calls };
}

test("tabs group reviews by the server's turn, or a computed one, and count each", async () => {
  const { slot, tabs, tab, titles } = await list([
    { targetKey: "a", title: "Change A", status: "ready", turn: turn("needs", "question", "Question for you") },
    { targetKey: "b", title: "Change B", status: "ready", turn: turn("waiting", "waiting", "Changes requested") },
    { targetKey: "c", title: "Change C", status: "ready", submittedVerdict: "REQUEST_CHANGES", submittedAt: now - DAY },
    { targetKey: "d", title: "Change D", status: "ready", turn: turn("reviewed", "approved", "Approved") },
    { targetKey: "e", title: "Change E", status: "ready", turn: turn("archive", "merged", "Merged") },
    { targetKey: "f", title: "Change F", status: "tracked", signals: { requestPending: true, requestedVia: "user" } },
  ]);
  await slot.findByText("Change A");
  const count = (name: RegExp) => tabs().getByRole("button", { name }).textContent?.match(/\d+$/)?.[0];
  expect([count(/^Needs review/), count(/^Waiting on author/), count(/^Reviewed/), count(/^Archive/)]).toEqual(["2", "2", "1", "1"]);
  expect(titles().sort()).toEqual(["Change A", "Change F"]);
  expect(slot.getByText("Review requested")).toBeTruthy();
  await tab(/^Waiting on author/);
  await slot.findByText("Change C");
  expect(titles().sort()).toEqual(["Change B", "Change C"]);
  await tab(/^Reviewed/);
  await slot.findByText("Change D");
  await tab(/^Archive/);
  await slot.findByText("Change E");
  slot.lifecycle.unmount();
});

test("Needs review puts blocking reviews first, then the longest waiting, with team requests last under their own heading", async () => {
  const { slot, titles } = await list([
    { targetKey: "a", title: "Change Recent", status: "ready", turn: turn("needs", "requested", "Review requested", { at: now - DAY }) },
    { targetKey: "b", title: "Change Team", status: "ready", turn: turn("needs", "team-requested", "Team review requested", { at: now - 9 * DAY }) },
    { targetKey: "c", title: "Change Old", status: "ready", turn: turn("needs", "re-requested", "Re-requested", { at: now - 5 * DAY }) },
    { targetKey: "d", title: "Change Blocking", status: "ready", turn: turn("needs", "question", "Question for you", { at: now - 60_000, blocking: true }) },
    { targetKey: "e", title: "Change Unstamped", status: "ready", createdAt: now - 3 * DAY, turn: turn("needs", "new", "Ready") },
  ]);
  await slot.findByText("Change Recent");
  expect(titles()).toEqual(["Change Blocking", "Change Old", "Change Unstamped", "Change Recent", "Change Team"]);
  const heading = slot.getByRole("heading", { name: "Team requests" });
  expect(heading.compareDocumentPosition(slot.getByText("Change Team")) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(heading.compareDocumentPosition(slot.getByText("Change Recent")) & Node.DOCUMENT_POSITION_PRECEDING).toBeTruthy();
  slot.lifecycle.unmount();
});

test("Waiting on author lists the most recent activity first, and has its own empty state", async () => {
  const { slot, tab, titles } = await list([
    { targetKey: "a", title: "Change Quiet", status: "ready", turn: turn("waiting", "waiting", "Changes requested", { at: now - 5 * DAY }) },
    { targetKey: "b", title: "Change Pushed", status: "ready", signals: { headSeenAt: now - DAY }, turn: turn("waiting", "waiting", "Changes requested", { at: now - 6 * DAY }) },
    { targetKey: "c", title: "Change Snoozed", status: "ready", turn: turn("waiting", "snoozed", "Not yet", { at: now - 2 * DAY }) },
  ]);
  await tab(/^Waiting on author/);
  await slot.findByText("Change Quiet");
  expect(titles()).toEqual(["Change Pushed", "Change Snoozed", "Change Quiet"]);
  expect(slot.queryByRole("heading", { name: "Team requests" })).toBeNull();
  slot.lifecycle.unmount();

  const empty = await list([]);
  await empty.tab(/^Waiting on author/);
  await empty.slot.findByText("Nothing waiting on authors");
  expect(empty.slot.getByText(/until the author re-requests your review, answers your feedback, or asks you something/)).toBeTruthy();
  empty.slot.lifecycle.unmount();
});

test("a row says why it's your turn, how the feedback stands, new commits, CI, and how long it's waited", async () => {
  const { slot } = await list([
    { targetKey: "a", title: "Change A", status: "ready", signals: { requestedBy: "alice", commitsSince: 3, ci: "fail" }, progress: { done: 2, total: 5, source: "assistant" },
      turn: turn("needs", "re-requested", "Re-requested", { at: now - 2 * DAY, blocking: true }) },
    { targetKey: "b", title: "Change B", status: "ready", signals: { commitsSince: 1, ci: "pass" }, progress: { done: 1, total: 4, source: "threads" },
      turn: turn("needs", "question", "Generating", { at: now - 3 * 3_600_000 }) },
  ]);
  await slot.findByText("Change A");
  for (const text of ["Re-requested by @alice", "2/5 addressed", "+3 commits", "Checks failing", "your turn · 2d", "Blocks merge"]) expect(slot.getByText(text)).toBeTruthy();
  // The badge already says "Re-requested"; the second row's badge shows generation, so its why stays.
  for (const text of ["Question for you", "1/4 handled", "+1 commit", "Checks passing", "your turn · 3h"]) expect(slot.getByText(text)).toBeTruthy();
  expect(slot.getAllByText("Blocks merge")).toHaveLength(1);
  slot.lifecycle.unmount();
});

test("a review you gave can wait with Not yet, come back to Needs review, and a tracked review can start its guide", async () => {
  const reviews = [
    { targetKey: "given", title: "Change Given", status: "ready", submittedVerdict: "REQUEST_CHANGES", submittedAt: now - DAY, turn: turn("needs", "question", "Question for you") },
    { targetKey: "fresh", title: "Change Fresh", status: "ready", turn: turn("needs", "requested", "Review requested") },
    { targetKey: "tracked", title: "Change Tracked", status: "tracked", turn: turn("needs", "requested", "Review requested") },
    { targetKey: "snoozed", title: "Change Snoozed", status: "ready", signals: { lastReviewAt: 1 }, turn: turn("waiting", "snoozed", "Not yet") },
  ];
  const { slot, tab, calls } = await list(reviews, {
    snoozeReview: () => ({ ok: true }),
    startTrackedReview: () => ({ ok: true }),
  });
  const menu = async (title: string) => {
    const row = (await slot.findByText(title)).closest(".group\\/row") as HTMLElement;
    fireEvent.click(within(row).getByRole("button", { name: "Review actions" }));
  };
  await menu("Change Given");
  expect(slot.getByText("Hides it until the author re-requests, answers, or asks you")).toBeTruthy();
  expect(slot.queryByRole("button", { name: "Start review" })).toBeNull();
  fireEvent.click(slot.getByRole("button", { name: "Not yet" }));
  await waitFor(() => expect(calls("snoozeReview")).toEqual([{ targetKey: "given", snoozed: true }]));
  // onChanged relists.
  await waitFor(() => expect(calls("listReviews").length).toBeGreaterThan(1));

  await menu("Change Fresh");
  expect(slot.queryByRole("button", { name: "Not yet" })).toBeNull();
  fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });

  await menu("Change Tracked");
  fireEvent.click(await slot.findByRole("button", { name: "Start review" }));
  await waitFor(() => expect(calls("startTrackedReview")).toEqual([{ targetKey: "tracked" }]));

  await tab(/^Waiting on author/);
  await menu("Change Snoozed");
  expect(slot.queryByRole("button", { name: "Not yet" })).toBeNull();
  fireEvent.click(slot.getByRole("button", { name: "Back to Needs review" }));
  await waitFor(() => expect(calls("snoozeReview")).toEqual([{ targetKey: "given", snoozed: true }, { targetKey: "snoozed", snoozed: false }]));
  slot.lifecycle.unmount();
});

test("status badges take their tone from why it's your turn", async () => {
  await loadPluginApp(() => import("../app"));
  const { statusLook } = await import("./ReviewStatus");
  const look = (t: Turn, extra = {}) => { const { tone, icon } = statusLook({ targetKey: "k", turn: t, ...extra }); return [tone, icon]; };
  expect(look(turn("needs", "re-requested", "Re-requested"))).toEqual(["primary", "Repeat"]);
  expect(look(turn("needs", "team-requested", "Team review requested"))).toEqual(["neutral", undefined]);
  expect(look(turn("needs", "question", "Question for you"))).toEqual(["warning", "MessageQuestion"]);
  expect(look(turn("needs", "handled", "Feedback handled"))).toEqual(["success", "CircleCheck"]);
  expect(look(turn("needs", "looks-ready", "Looks ready"))).toEqual(["agent", "Sparkles"]);
  expect(look(turn("waiting", "waiting", "Changes requested"))).toEqual(["warning", "FileDiff"]);
  expect(look(turn("waiting", "waiting", "Commented"))).toEqual(["neutral", "MessageSquare"]);
  expect(look(turn("waiting", "snoozed", "Not yet"))).toEqual(["neutral", "Clock"]);
  expect(look(turn("reviewed", "approved", "Approved · updated"))).toEqual(["success", "Check"]);
  expect(look(turn("needs", "new", "Tracked"))).toEqual(["primary", undefined]);
  expect(look(turn("needs", "question", "Generating"))).toEqual(["warning", "Loading"]);
  // A failed guide keeps the reason underneath; the badge shows the failure.
  expect(look(turn("needs", "re-requested", "Failed", { failed: true }))).toEqual(["danger", "AlertTriangle"]);
});

test("whose-turn settings save into preferences, with one repository pattern per line", async () => {
  await loadPluginApp(() => import("../app"));
  const { ReviewSettings } = await import("./ReviewSettings");
  let record = { preferences: { ...defaultPreferences }, revision: 0 };
  const save = vi.fn(async (input: any) => record = { ...input, revision: input.revision + 1 });
  const slot = renderSlot({ component: ReviewSettings }, {}, { rpc: { setReviewPresence: () => ({ ok: true }), getPreferences: () => record, savePreferences: save } });
  const replies = await slot.findByRole("group", { name: "When the author replies" });
  expect(within(replies).getByRole("button", { name: "Questions for you" }).getAttribute("aria-pressed")).toBe("true");
  fireEvent.click(within(replies).getByRole("button", { name: "Any reply" }));
  fireEvent.click(within(slot.getByRole("group", { name: "After the author pushes" })).getByRole("button", { name: /bring it back when everything/ }));
  // Team requests are opt-in, and only while tracking is on.
  const teams = slot.getByRole("checkbox", { name: /Include team requests/ }) as HTMLInputElement;
  expect(teams.checked).toBe(false);
  fireEvent.click(teams);
  fireEvent.click(slot.getByRole("checkbox", { name: /Track reviews from GitHub/ }));
  expect(teams.disabled).toBe(true);
  const repos = slot.getByRole("textbox", { name: "Start guides automatically" }) as HTMLTextAreaElement;
  fireEvent.change(repos, { target: { value: "  Acme/App \n\n acme/*\n" } });
  // The typed text, blank lines included, stays while editing.
  expect(repos.value).toBe("  Acme/App \n\n acme/*\n");
  const prompt = slot.getByRole("textbox", { name: "Re-review check" }) as HTMLTextAreaElement;
  expect(prompt.value).toBe(defaultPreferences.verificationPrompt);
  fireEvent.change(prompt, { target: { value: "" } });
  fireEvent.click(slot.getByRole("button", { name: "Save settings" }));
  await slot.findByText("Settings saved");
  expect(save.mock.calls[0][0].preferences).toMatchObject({ wakeOnReplies: "any", pushChecks: "ready", trackGithubReviews: false, trackTeamRequests: true, autoStartRepos: ["acme/app", "acme/*"], verificationPrompt: "" });
  expect(repos.value).toBe("  Acme/App \n\n acme/*\n");

  // Restore defaults clears the patterns.
  fireEvent.click(slot.getByRole("button", { name: "Restore defaults" }));
  await waitFor(() => expect(repos.value).toBe(""));
  fireEvent.click(slot.getByRole("button", { name: "Discard edits" }));
  await waitFor(() => expect(repos.value).toBe("acme/app\nacme/*"));
  slot.lifecycle.unmount();
});
