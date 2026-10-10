// @vitest-environment jsdom
// FeedbackPanel binds to the plugin runtime when its module loads: install it, then import.
import { test, expect, vi, afterEach } from "vitest";
import { cleanup, fireEvent, within } from "@testing-library/react";
import { installTestPluginRuntime, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import type { FeedbackItem, FeedbackView } from "../lib/feedback";

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));
installTestPluginRuntime();
const { toast } = await import("sonner");
const { FeedbackPanel, feedbackRank } = await import("./FeedbackPanel");

afterEach(() => { cleanup(); vi.clearAllMocks(); });

const now = Date.now();
const HOUR = 3_600_000;

function thread(id: string, over: Partial<NonNullable<FeedbackItem["thread"]>> = {}): NonNullable<FeedbackItem["thread"]> {
  return {
    id, commentId: 1, reviewId: "R1", path: "src/a.ts", line: 12, originalLine: 10, startLine: null, side: "RIGHT", subjectType: "LINE",
    body: `Comment ${id}`, createdAt: now - 72 * HOUR, isResolved: false, resolvedBy: null, isOutdated: false, replies: [],
    status: "open", replyAt: null, url: null, ...over,
  };
}
function item(id: string, title: string, { thread: threadOver, ...over }: Partial<Omit<FeedbackItem, "thread">> & { thread?: Partial<NonNullable<FeedbackItem["thread"]>> } = {}): FeedbackItem {
  return { id, kind: "thread", title, thread: thread(id, threadOver), assessment: null, replyDraft: null, ...over };
}
const assessed = (verdict: NonNullable<FeedbackItem["assessment"]>["verdict"], evidence: string) => ({ id: "x", verdict, evidence, assessedAt: now - 2 * HOUR });
const reply = (author: string, body: string, minutesAgo: number) => ({ author, bot: false, mine: false, body, createdAt: now - minutesAgo * 60_000 });

const checkedView: FeedbackView = {
  baseline: { sha: "base000", at: now - 72 * HOUR, verdict: "REQUEST_CHANGES" },
  head: "abcdef1234",
  fetchedAt: now,
  run: { headSha: "abcdef1234", summary: "Mostly there.", suggestedVerdict: "REQUEST_CHANGES", suggestedBody: "Two asks remain.", assessedAt: now - 2 * HOUR, current: false },
  items: [
    item("A", "Rename the helper", { thread: { status: "resolved", isResolved: true }, assessment: assessed("addressed", "Renamed to `parseRows`.") }),
    item("B", "Handle the empty list", {
      thread: { isOutdated: true, replies: [reply("octo", "First reply", 90), reply("octo", "Second reply", 60), reply("octo", "Third reply", 30)] },
      assessment: assessed("not_addressed", "The empty case still throws."),
      replyDraft: { body: "Still missing the empty case?", author: "agent", updatedAt: now },
    }),
    item("C", "Use the cache", { thread: { status: "question", path: "src/b.ts", line: 4, side: "LEFT" }, assessment: assessed("disputed", "The author says the cache is stale.") }),
    { id: "summary:1", kind: "summary", title: "Add tests for the parser", thread: null, assessment: assessed("partial", "One test added; the error path has none."), replyDraft: null },
  ],
};

function render(feedback: FeedbackView, rpc: Record<string, unknown> = {}, props: Record<string, unknown> = {}) {
  const handlers = {
    getFeedback: vi.fn(() => ({ feedback })),
    refreshFeedback: vi.fn(() => ({ feedback })),
    checkFeedback: vi.fn(() => ({ ok: true })),
    resolveThread: vi.fn(() => ({ ok: true })),
    unresolveThread: vi.fn(() => ({ ok: true })),
    replyToFeedback: vi.fn(() => ({ ok: true })),
    saveReplyDraft: vi.fn(() => ({ ok: true })),
    discardReplyDraft: vi.fn(() => ({ ok: true })),
    useSuggestedVerdict: vi.fn(() => ({ ok: true })),
    getDraft: vi.fn(() => ({ draft: { verdict: "COMMENT", body: "", comments: [] } })),
    ...rpc,
  };
  const callbacks = { onShowLocation: vi.fn(), onFollowUp: vi.fn(), onDraftUpdated: vi.fn() };
  const slot = renderSlot({ component: FeedbackPanel }, { targetKey: "pr-1", revision: "r1", review: null, ...callbacks, ...props }, { rpc: handlers as any });
  return { slot, rpc: handlers, ...callbacks };
}

test("an assessed review: tally, check age, items needing a look first, and both chips per item", async () => {
  const { slot } = render(checkedView);
  await slot.findByText("Your feedback");
  expect(slot.getByText("1 of 4 addressed")).toBeTruthy();
  expect(slot.getByText(/Checked 2h ago/).textContent).toContain("abcdef1");
  expect(slot.getByText("older commit")).toBeTruthy();
  expect(slot.getAllByRole("article").map((card) => card.getAttribute("aria-label"))).toEqual(["Use the cache", "Handle the empty list", "Add tests for the parser", "Rename the helper"]);

  const b = within(slot.getByRole("article", { name: "Handle the empty list" }));
  expect(b.getByText("Not addressed")).toBeTruthy();
  expect(b.getByText("Open")).toBeTruthy();
  expect(b.getByText("Code changed")).toBeTruthy();
  expect(b.getByText("The empty case still throws.")).toBeTruthy();
  const c = within(slot.getByRole("article", { name: "Use the cache" }));
  expect(c.getByText("Author disagrees")).toBeTruthy();
  expect(c.getByText("Question for you")).toBeTruthy();
  const a = within(slot.getByRole("article", { name: "Rename the helper" }));
  expect(a.getByText("Addressed")).toBeTruthy();
  expect(a.getByText("Resolved")).toBeTruthy();
  const s = within(slot.getByRole("article", { name: "Add tests for the parser" }));
  expect(s.getByText("Partial")).toBeTruthy();
  expect(s.getByText("One test added; the error path has none.")).toBeTruthy();
});

test("shows the latest two replies, and the rest on request", async () => {
  const { slot } = render(checkedView);
  const b = within(await slot.findByRole("article", { name: "Handle the empty list" }));
  expect(b.queryByText("First reply")).toBeNull();
  expect(b.getByText("Second reply")).toBeTruthy();
  expect(b.getByText("Third reply")).toBeTruthy();
  fireEvent.click(b.getByRole("button", { name: "Show 1 earlier reply" }));
  expect(b.getByText("First reply")).toBeTruthy();
});

test("Resolve, Unresolve, location, and Follow up act on the right thread", async () => {
  const { slot, rpc, onShowLocation, onFollowUp } = render(checkedView);
  const b = within(await slot.findByRole("article", { name: "Handle the empty list" }));
  fireEvent.click(b.getByRole("button", { name: "Resolve" }));
  await vi.waitFor(() => expect(rpc.resolveThread).toHaveBeenCalledWith({ targetKey: "pr-1", threadId: "B" }));
  await vi.waitFor(() => expect(rpc.refreshFeedback).toHaveBeenCalledWith({ targetKey: "pr-1" }));

  fireEvent.click(within(slot.getByRole("article", { name: "Rename the helper" })).getByRole("button", { name: "Unresolve" }));
  await vi.waitFor(() => expect(rpc.unresolveThread).toHaveBeenCalledWith({ targetKey: "pr-1", threadId: "A" }));

  fireEvent.click(b.getByRole("button", { name: "Show src/a.ts:12 in the diff" }));
  expect(onShowLocation).toHaveBeenCalledWith("src/a.ts", 12, "RIGHT", null);
  const c = within(slot.getByRole("article", { name: "Use the cache" }));
  fireEvent.click(c.getByRole("button", { name: "Follow up" }));
  expect(onFollowUp).toHaveBeenCalledWith("src/b.ts", 4, "LEFT", null);
});

test("a reply drafted by the assistant can be edited, saved, sent, or discarded", async () => {
  const { slot, rpc } = render(checkedView);
  const b = within(await slot.findByRole("article", { name: "Handle the empty list" }));
  const box = b.getByRole("textbox", { name: "Reply to Handle the empty list" }) as HTMLTextAreaElement;
  expect(box.value).toBe("Still missing the empty case?");
  expect(b.getByText("Drafted by assistant")).toBeTruthy();

  fireEvent.change(box, { target: { value: "The empty list still throws." } });
  expect(b.queryByText("Drafted by assistant")).toBeNull();
  fireEvent.blur(box);
  await vi.waitFor(() => expect(rpc.saveReplyDraft).toHaveBeenCalledWith({ targetKey: "pr-1", threadId: "B", body: "The empty list still throws." }));

  fireEvent.click(b.getByRole("button", { name: "Send" }));
  await vi.waitFor(() => expect(rpc.replyToFeedback).toHaveBeenCalledWith({ targetKey: "pr-1", threadId: "B", body: "The empty list still throws." }));
  await vi.waitFor(() => expect(b.queryByRole("textbox")).toBeNull());

  const c = within(slot.getByRole("article", { name: "Use the cache" }));
  fireEvent.click(c.getByRole("button", { name: "Reply" }));
  fireEvent.change(c.getByRole("textbox"), { target: { value: "Why stale?" } });
  fireEvent.blur(c.getByRole("textbox"));
  fireEvent.click(c.getByRole("button", { name: "Discard" }));
  await vi.waitFor(() => expect(rpc.discardReplyDraft).toHaveBeenCalledWith({ targetKey: "pr-1", threadId: "C" }));
  expect(rpc.replyToFeedback).toHaveBeenCalledTimes(1);
});

test("a failed reply keeps its text", async () => {
  const { slot } = render(checkedView, { replyToFeedback: () => ({ ok: false, error: "GitHub said no" }) });
  const b = within(await slot.findByRole("article", { name: "Handle the empty list" }));
  fireEvent.click(b.getByRole("button", { name: "Send" }));
  await vi.waitFor(() => expect(toast.error).toHaveBeenCalledWith("GitHub said no"));
  expect((b.getByRole("textbox") as HTMLTextAreaElement).value).toBe("Still missing the empty case?");
});

test("the suggested verdict goes into the draft, as suggested or as what's left", async () => {
  const { slot, rpc, onDraftUpdated } = render(checkedView);
  await slot.findByText("Assistant suggests: Request changes");
  expect(slot.getByText("Two asks remain.")).toBeTruthy();
  fireEvent.click(slot.getByRole("button", { name: "Use as draft" }));
  await vi.waitFor(() => expect(rpc.useSuggestedVerdict).toHaveBeenCalledWith({ targetKey: "pr-1", mode: "suggested", revision: "r1" }));
  await vi.waitFor(() => expect(onDraftUpdated).toHaveBeenCalledTimes(1));
  expect(toast.success).toHaveBeenCalledWith("Draft updated — review it before submitting.");
  fireEvent.click(slot.getByRole("button", { name: "Request what’s left" }));
  await vi.waitFor(() => expect(rpc.useSuggestedVerdict).toHaveBeenCalledWith({ targetKey: "pr-1", mode: "remaining", revision: "r1" }));
  await vi.waitFor(() => expect(onDraftUpdated).toHaveBeenCalledTimes(2));
});

test("Check again asks the assistant; Refresh re-reads GitHub; realtime reloads", async () => {
  const { slot, rpc } = render(checkedView);
  await slot.findByText("Your feedback");
  fireEvent.click(slot.getByRole("button", { name: "Check again" }));
  await vi.waitFor(() => expect(rpc.checkFeedback).toHaveBeenCalledWith({ targetKey: "pr-1" }));
  await vi.waitFor(() => expect(toast.success).toHaveBeenCalled());
  fireEvent.click(slot.getByRole("button", { name: "Refresh" }));
  await vi.waitFor(() => expect(rpc.refreshFeedback).toHaveBeenCalledWith({ targetKey: "pr-1" }));
  await slot.emitRealtime("feedback:pr-1", {});
  await vi.waitFor(() => expect(rpc.getFeedback).toHaveBeenCalledTimes(2));
  await slot.emitRealtime("review:pr-1", {});
  await vi.waitFor(() => expect(rpc.getFeedback).toHaveBeenCalledTimes(3));
});

test("without the assistant's check: thread tally, questions then open first, no suggestion", async () => {
  const { slot } = render({
    ...checkedView,
    run: null,
    items: [
      item("R", "Resolved one", { thread: { status: "resolved", isResolved: true } }),
      item("O", "Open one"),
      item("N", "Answered one", { thread: { status: "answered" } }),
      item("Q", "Question one", { thread: { status: "question" } }),
    ],
  });
  expect((await slot.findByText("2 of 4 handled")).getAttribute("title")).toBe("Resolved or answered");
  expect(slot.getAllByRole("article").map((card) => card.getAttribute("aria-label"))).toEqual(["Question one", "Open one", "Resolved one", "Answered one"]);
  expect(within(slot.getByRole("article", { name: "Answered one" })).getByText("Author replied")).toBeTruthy();
  expect(slot.queryByText(/Assistant suggests/)).toBeNull();
  expect(slot.queryByText(/Checked/)).toBeNull();
});

test("empty states: never reviewed, and reviewed without line comments", async () => {
  const never = render({ baseline: { sha: null, at: null, verdict: null }, head: "h", items: [], run: null, fetchedAt: null });
  await never.slot.findByText("Your feedback appears here after you submit a review.");
  cleanup();
  const { slot, rpc } = render({ baseline: { sha: "base", at: now, verdict: "COMMENT" }, head: "h", items: [], run: null, fetchedAt: now });
  await slot.findByText("Your last review had no line comments.");
  fireEvent.click(slot.getByRole("button", { name: "Check again" }));
  await vi.waitFor(() => expect(rpc.checkFeedback).toHaveBeenCalledWith({ targetKey: "pr-1" }));
});

test("a load failure offers Try again", async () => {
  const { slot } = render(checkedView, { getFeedback: () => { throw new Error("boom"); } });
  await slot.findByText("Couldn't load your feedback.");
  expect(slot.getByRole("button", { name: "Try again" })).toBeTruthy();
});

test("a feedback reload while a reply is being typed keeps the text, and the cards keep their places", async () => {
  let view = checkedView;
  const { slot, rpc } = render(checkedView, { getFeedback: vi.fn(() => ({ feedback: view })), refreshFeedback: vi.fn(() => ({ feedback: view })) });
  const c = within(await slot.findByRole("article", { name: "Use the cache" }));
  fireEvent.click(c.getByRole("button", { name: "Reply" }));
  fireEvent.change(c.getByRole("textbox"), { target: { value: "Why is it stale?" } });
  // The author resolves the question elsewhere, which would rank the card last.
  view = { ...checkedView, items: checkedView.items.map((entry) => entry.id === "C" ? { ...entry, thread: { ...entry.thread!, status: "resolved", isResolved: true } } : entry) };
  await slot.emitRealtime("feedback:pr-1", {});
  await vi.waitFor(() => expect(c.getByText("Resolved")).toBeTruthy());
  expect((c.getByRole("textbox") as HTMLTextAreaElement).value).toBe("Why is it stale?");
  expect(slot.getAllByRole("article").map((card) => card.getAttribute("aria-label"))).toEqual(["Use the cache", "Handle the empty list", "Add tests for the parser", "Rename the helper"]);
  expect(rpc.saveReplyDraft).not.toHaveBeenCalled();
  // Refresh ranks again.
  fireEvent.click(slot.getByRole("button", { name: "Refresh" }));
  await vi.waitFor(() => expect(slot.getAllByRole("article").map((card) => card.getAttribute("aria-label"))).toEqual(["Handle the empty list", "Use the cache", "Add tests for the parser", "Rename the helper"]));
});

test("a question for you ranks first even when the assistant calls it addressed", () => {
  const question = item("Q", "Q", { thread: { status: "question" }, assessment: assessed("addressed", "Done.") });
  const missing = item("M", "M", { assessment: assessed("not_addressed", "Missing.") });
  expect([missing, question].sort((a, b) => feedbackRank(a) - feedbackRank(b)).map((entry) => entry.id)).toEqual(["Q", "M"]);
});

test("reply text survives a failed Send and leaving the view", async () => {
  const { slot, rpc } = render(checkedView, { replyToFeedback: vi.fn(() => ({ ok: false, error: "GitHub said no" })) });
  const b = within(await slot.findByRole("article", { name: "Handle the empty list" }));
  fireEvent.change(b.getByRole("textbox"), { target: { value: "Edited, then sent." } });
  // Clicking Send blurs the box toward this card's Send, which skips the blur save.
  fireEvent.blur(b.getByRole("textbox"), { relatedTarget: b.getByRole("button", { name: "Send" }) });
  expect(rpc.saveReplyDraft).not.toHaveBeenCalled();
  fireEvent.click(b.getByRole("button", { name: "Send" }));
  await vi.waitFor(() => expect(rpc.saveReplyDraft).toHaveBeenCalledWith({ targetKey: "pr-1", threadId: "B", body: "Edited, then sent." }));

  // Text typed and never blurred is saved when the view goes away.
  const c = within(slot.getByRole("article", { name: "Use the cache" }));
  fireEvent.click(c.getByRole("button", { name: "Reply" }));
  fireEvent.change(c.getByRole("textbox"), { target: { value: "Still typing" } });
  slot.lifecycle.unmount();
  expect(rpc.saveReplyDraft).toHaveBeenCalledWith({ targetKey: "pr-1", threadId: "C", body: "Still typing" });
  expect(rpc.saveReplyDraft).toHaveBeenCalledTimes(2);
});

test("clicking another card's Send still saves this card's reply", async () => {
  const { slot, rpc } = render(checkedView);
  const b = within(await slot.findByRole("article", { name: "Handle the empty list" }));
  const c = within(slot.getByRole("article", { name: "Use the cache" }));
  fireEvent.click(c.getByRole("button", { name: "Reply" }));
  fireEvent.change(c.getByRole("textbox"), { target: { value: "Why stale?" } });
  fireEvent.blur(c.getByRole("textbox"), { relatedTarget: b.getByRole("button", { name: "Send" }) });
  expect(rpc.saveReplyDraft).toHaveBeenCalledWith({ targetKey: "pr-1", threadId: "C", body: "Why stale?" });
});

test("Reply focuses its box; Send and Discard hand focus back to Reply", async () => {
  const { slot } = render(checkedView);
  const c = within(await slot.findByRole("article", { name: "Use the cache" }));
  fireEvent.click(c.getByRole("button", { name: "Reply" }));
  await vi.waitFor(() => expect(document.activeElement).toBe(c.getByRole("textbox")));
  fireEvent.change(c.getByRole("textbox"), { target: { value: "Why stale?" } });
  fireEvent.click(c.getByRole("button", { name: "Send" }));
  await vi.waitFor(() => expect(document.activeElement).toBe(c.getByRole("button", { name: "Reply" })));

  const b = within(slot.getByRole("article", { name: "Handle the empty list" }));
  fireEvent.click(b.getByRole("button", { name: "Discard" }));
  await vi.waitFor(() => expect(document.activeElement).toBe(b.getByRole("button", { name: "Reply" })));
});

test("a thread on the whole PR names it as text, not a disabled button", async () => {
  const { slot } = render({ ...checkedView, items: [item("W", "Whole thing", { thread: { path: null as any, line: null, originalLine: null } })] });
  const card = within(await slot.findByRole("article", { name: "Whole thing" }));
  expect(card.getByText("Whole PR").closest("button")).toBeNull();
  expect(card.queryByRole("button", { name: "No file" })).toBeNull();
});

test("Use as draft asks before replacing a summary you wrote, saved or unsaved", async () => {
  const { slot, rpc, onDraftUpdated } = render(checkedView, { getDraft: vi.fn(() => ({ draft: { verdict: "COMMENT", body: "My summary.", comments: [] } })) });
  fireEvent.click(await slot.findByRole("button", { name: "Use as draft" }));
  const dialog = await slot.findByRole("dialog", { name: "Replace your summary?" });
  fireEvent.click(within(dialog).getByRole("button", { name: "Keep mine" }));
  await vi.waitFor(() => expect(slot.queryByRole("dialog")).toBeNull());
  expect(rpc.useSuggestedVerdict).not.toHaveBeenCalled();

  fireEvent.click(slot.getByRole("button", { name: "Request what’s left" }));
  fireEvent.click(within(await slot.findByRole("dialog", { name: "Replace your summary?" })).getByRole("button", { name: "Replace summary" }));
  await vi.waitFor(() => expect(rpc.useSuggestedVerdict).toHaveBeenCalledWith({ targetKey: "pr-1", mode: "remaining", revision: "r1" }));
  await vi.waitFor(() => expect(onDraftUpdated).toHaveBeenCalledTimes(1));
  cleanup();

  // Unsaved in this tab counts, even when the saved summary is empty.
  sessionStorage.setItem("guided-review:draft-recovery:pr-1", JSON.stringify({ summary: { verdict: "COMMENT", body: "Not saved yet" } }));
  const unsaved = render(checkedView);
  fireEvent.click(await unsaved.slot.findByRole("button", { name: "Use as draft" }));
  await unsaved.slot.findByRole("dialog", { name: "Replace your summary?" });
  expect(unsaved.rpc.useSuggestedVerdict).not.toHaveBeenCalled();
  sessionStorage.clear();
});
