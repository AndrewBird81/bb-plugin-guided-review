import { useState } from "react";
import { afterEach, expect, test, vi } from "vitest";
import { cleanup, fireEvent, waitFor, within } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";

// Render the diff's annotations, not @pierre/diffs' internals. Like pierre,
// the gutter "+" reports a line selection right after its own click.
vi.mock("@pierre/diffs/react", () => ({
  FileDiff: ({ options, lineAnnotations, renderAnnotation }: any) => {
    const range = { start: 2, end: 2, side: "additions" };
    return (
      <div data-testid="filediff">
        {lineAnnotations?.map((annotation: any, index: number) => <div key={index}>{renderAnnotation?.(annotation)}</div>)}
        <button onClick={() => { options.onGutterUtilityClick(range); options.onLineSelected(range); }}>Gutter +</button>
      </div>
    );
  },
}));

afterEach(() => { cleanup(); sessionStorage.clear(); });

const patch = "diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1,2 @@\n-old\n+new\n+more\n";
const empty = (targetKey: string) => ({ targetKey, verdict: "COMMENT", body: "", comments: [] as any[] });

async function renderReview(targetKey: string, rpc: Record<string, unknown>, onShowComment = vi.fn()) {
  await loadPluginApp(() => import("../app"));
  const { DraftTray } = await import("./DraftTray");
  const { DiffViewer } = await import("./DiffViewer");
  const component = () => (
    <DraftTray targetKey={targetKey} activeChapterId="c1" activeFiles={["src/a.ts"]} reviewRevision="r1" account="reviewer" onShowComment={onShowComment}>
      <DiffViewer patch={patch} files={["src/a.ts"]} views={new Map()} onToggleViewed={() => {}} />
    </DraftTray>
  );
  const slot = renderSlot({ component }, {}, { rpc: { setReviewPresence: () => ({ ok: true }), getReviewerNotes: () => ({ body: "", revision: 0 }), ...rpc } });
  await slot.findByText("Draft saved");
  return { slot, diff: () => within(slot.getByTestId("filediff")), panel: () => within(slot.getByRole("region", { name: "Review draft" })) };
}

test("a comment written at a line in the diff joins the draft, and shows there and in the panel", async () => {
  let stored = empty("write");
  const saveDraftComment = vi.fn(async ({ comment }: any) => { stored = { ...stored, comments: [comment] }; return { draft: stored, stale: [] }; });
  const { slot, diff, panel } = await renderReview("write", { getDraft: () => ({ draft: stored, stale: [] }), saveDraftComment });
  fireEvent.click(diff().getByRole("button", { name: "Gutter +" }));
  const box = diff().getByRole("textbox", { name: "Draft comment" });
  await waitFor(() => expect(document.activeElement).toBe(box));
  expect(panel().getByText("Writing a comment on src/a.ts:2 in the diff.")).toBeTruthy();
  fireEvent.change(box, { target: { value: "Cover the empty case." } });
  expect((slot.getByRole("button", { name: "Submit to GitHub" }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(diff().getByRole("button", { name: "Add to draft" }));
  await waitFor(() => expect(saveDraftComment).toHaveBeenCalledWith({ targetKey: "write", revision: "r1", comment: { file: "src/a.ts", line: 2, side: "RIGHT", chapterId: "c1", body: "Cover the empty case." } }));
  const shown = await diff().findByRole("article", { name: "Draft comment on src/a.ts:2" });
  expect(within(shown).getByText("Cover the empty case.")).toBeTruthy();
  expect(diff().queryByRole("textbox")).toBeNull();
  expect(panel().getByRole("button", { name: "src/a.ts:2 · Changed" })).toBeTruthy();
  expect(panel().queryByText(/in the diff\./)).toBeNull();
  slot.lifecycle.unmount();
});

test("editing an agent's comment in the diff saves it in place, while its new comments keep arriving", async () => {
  const agents = { file: "src/a.ts", line: 2, side: "RIGHT", author: "agent", body: "Is this tested?" };
  const later = { file: "src/a.ts", line: 1, side: "RIGHT", author: "agent", body: "Name this better?" };
  let stored = { ...empty("edit"), comments: [agents] as any[] };
  const saveDraftComment = vi.fn(async ({ comment }: any) => { stored = { ...stored, comments: stored.comments.map((c) => c.line === comment.line ? comment : c) }; return { draft: stored, stale: [] }; });
  const { slot, diff } = await renderReview("edit", { getDraft: () => ({ draft: structuredClone(stored), stale: [] }), saveDraftComment });
  const shown = await diff().findByRole("article", { name: "Draft comment on src/a.ts:2" });
  fireEvent.click(within(shown).getByRole("button", { name: "Edit" }));
  expect(diff().queryByRole("article", { name: "Draft comment on src/a.ts:2" })).toBeNull();
  const box = diff().getByRole("textbox", { name: "Draft comment" }) as HTMLTextAreaElement;
  expect(box.value).toBe("Is this tested?");
  fireEvent.change(box, { target: { value: "Please add a test for the empty case." } });
  stored = { ...stored, comments: [...stored.comments, later] };
  await slot.emitRealtime("draft:edit", {});
  await diff().findByRole("article", { name: "Draft comment on src/a.ts:1" });
  expect((diff().getByRole("textbox", { name: "Draft comment" }) as HTMLTextAreaElement).value).toBe("Please add a test for the empty case.");
  fireEvent.click(diff().getByRole("button", { name: "Save comment" }));
  await waitFor(() => expect(saveDraftComment).toHaveBeenCalledWith({ targetKey: "edit", revision: "r1", comment: { file: "src/a.ts", line: 2, side: "RIGHT", chapterId: "c1", body: "Please add a test for the empty case." } }));
  const saved = await diff().findByRole("article", { name: "Draft comment on src/a.ts:2" });
  expect(within(saved).getByText("Please add a test for the empty case.")).toBeTruthy();
  expect(within(saved).queryByText("Added by agent")).toBeNull();
  slot.lifecycle.unmount();
});

test("the gutter + on a line with a comment opens that comment, and Remove deletes it", async () => {
  const mine = { file: "src/a.ts", line: 2, side: "RIGHT", body: "My comment" };
  const removeDraftComment = vi.fn(() => ({ draft: empty("one-per-line"), stale: [] }));
  const { slot, diff } = await renderReview("one-per-line", { getDraft: () => ({ draft: { ...empty("one-per-line"), comments: [mine] }, stale: [] }), removeDraftComment });
  await diff().findByRole("article", { name: "Draft comment on src/a.ts:2" });
  fireEvent.click(diff().getByRole("button", { name: "Gutter +" }));
  expect((diff().getByRole("textbox", { name: "Draft comment" }) as HTMLTextAreaElement).value).toBe("My comment");
  fireEvent.click(diff().getByRole("button", { name: "Cancel" }));
  fireEvent.click(within(diff().getByRole("article")).getByRole("button", { name: "Remove" }));
  await waitFor(() => expect(removeDraftComment).toHaveBeenCalledWith({ targetKey: "one-per-line", file: "src/a.ts", line: 2, side: "RIGHT" }));
  await waitFor(() => expect(diff().queryByRole("article")).toBeNull());
  slot.lifecycle.unmount();
});

test("commenting on selected lines opens the box at the last line, leaving the panel as it was", async () => {
  await loadPluginApp(() => import("../app"));
  const { DraftTray } = await import("./DraftTray");
  const { DiffViewer } = await import("./DiffViewer");
  function Review() {
    const [nonce, setNonce] = useState(0);
    return <>
      <button onClick={() => setNonce((value) => value + 1)}>Comment on selected lines</button>
      <DraftTray targetKey="request" activeChapterId="c1" activeFiles={["src/a.ts"]} reviewRevision="r1" prefill={nonce ? { file: "src/a.ts", line: 1, side: "RIGHT", nonce } : undefined}>
        <DiffViewer patch={patch} files={["src/a.ts"]} views={new Map()} onToggleViewed={() => {}} />
      </DraftTray>
    </>;
  }
  const slot = renderSlot({ component: Review }, {}, { rpc: { setReviewPresence: () => ({ ok: true }), getReviewerNotes: () => ({ body: "", revision: 0 }), getDraft: () => ({ draft: empty("request"), stale: [] }) } });
  await slot.findByText("Draft saved");
  fireEvent.click(slot.getByRole("button", { name: "Reviewer notes" }));
  fireEvent.click(slot.getByRole("button", { name: "Comment on selected lines" }));
  const box = await within(slot.getByTestId("filediff")).findByRole("textbox", { name: "Draft comment" });
  expect(box.closest("[data-draft-at]")?.getAttribute("data-draft-at")).toBe("src/a.ts:1:RIGHT");
  await waitFor(() => expect(document.activeElement).toBe(box));
  expect(slot.getByRole("button", { name: "Reviewer notes" }).getAttribute("aria-expanded")).toBe("true");
  slot.lifecycle.unmount();
});

test("an unfinished comment in the diff is recovered there after the page reloads", async () => {
  const rpc = { getDraft: () => ({ draft: empty("recover"), stale: [] }) };
  let { slot, diff } = await renderReview("recover", rpc);
  fireEvent.click(diff().getByRole("button", { name: "Gutter +" }));
  fireEvent.change(diff().getByRole("textbox", { name: "Draft comment" }), { target: { value: "Don't lose this" } });
  slot.lifecycle.unmount();
  ({ slot, diff } = await renderReview("recover", rpc));
  expect((diff().getByRole("textbox", { name: "Draft comment" }) as HTMLTextAreaElement).value).toBe("Don't lose this");
  slot.lifecycle.unmount();
});

test("choosing a comment, or the comment being written, in the panel shows it in the diff", async () => {
  const mine = { file: "src/a.ts", line: 1, side: "RIGHT", body: "My comment" };
  const onShowComment = vi.fn();
  const { slot, diff, panel } = await renderReview("show", { getDraft: () => ({ draft: { ...empty("show"), comments: [mine] }, stale: [{ file: "src/a.ts", line: 1, side: "RIGHT" }] }) }, onShowComment);
  fireEvent.click(panel().getByRole("button", { name: "src/a.ts:1 · Changed · Older diff" }));
  expect(onShowComment).toHaveBeenLastCalledWith(mine);
  fireEvent.click(diff().getByRole("button", { name: "Gutter +" }));
  fireEvent.click(panel().getByRole("button", { name: "Show in diff" }));
  expect(onShowComment).toHaveBeenLastCalledWith({ file: "src/a.ts", line: 2, side: "RIGHT" });
  slot.lifecycle.unmount();
});
