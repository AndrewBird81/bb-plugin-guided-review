// @vitest-environment jsdom
import { test, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, within } from "@testing-library/react";

// Render only our chrome and annotations, not @pierre/diffs' internals. Like
// pierre, the gutter "+" reports a line selection right after its own click.
vi.mock("@pierre/diffs/react", () => ({
  FileDiff: ({ options, lineAnnotations, renderAnnotation }: any) => {
    const range = { start: 2, end: 2, side: "additions" };
    return (
      <div data-testid="filediff">
        {lineAnnotations?.map((annotation: any, index: number) => <div key={index}>{renderAnnotation?.(annotation)}</div>)}
        <button onClick={() => { options.onGutterUtilityClick(range); options.onLineSelected(range); }}>Gutter +</button>
        <button onClick={() => options.onLineSelected(range)}>Line number</button>
      </div>
    );
  },
}));

import { installTestPluginRuntime } from "@get-bb/plugin-sdk/testing/app";
import type { FileViewFlags } from "./DiffViewer";
import type { InlineComposer, InlineDraft } from "./InlineDraft";

// Comments render with bb's Markdown, which binds to the plugin runtime when its module loads.
installTestPluginRuntime();
const { DiffViewer } = await import("./DiffViewer");
const { InlineComposerContext, InlineDraftContext } = await import("./InlineDraft");

afterEach(cleanup);

const patch = "diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1,2 @@\n-old\n+new\n+more\n";

test("renders a file header with path, additions/deletions, and a Viewed checkbox", () => {
  render(
    <DiffViewer
      patch={patch}
      files={["src/a.ts"]}
      views={new Map<string, FileViewFlags>()}
      onToggleViewed={() => {}}
    />,
  );
  expect(screen.getByTitle("src/a.ts").textContent).toBe("src/a.ts");
  expect(screen.getByText("+2")).toBeTruthy();
  expect(screen.getByText("−1")).toBeTruthy();
  expect(screen.getByTestId("filediff")).toBeTruthy(); // expanded body present
});

test("checking Viewed reports up and collapses the diff body", () => {
  const onToggleViewed = vi.fn();
  render(
    <DiffViewer
      patch={patch}
      files={["src/a.ts"]}
      views={new Map<string, FileViewFlags>()}
      onToggleViewed={onToggleViewed}
    />,
  );
  fireEvent.click(screen.getByRole("checkbox"));
  expect(onToggleViewed).toHaveBeenCalledWith("src/a.ts", true);
  expect(screen.queryByTestId("filediff")).toBeNull(); // collapsed
});

test("a stale file shows a 'changed' pill", () => {
  render(
    <DiffViewer
      patch={patch}
      files={["src/a.ts"]}
      views={new Map<string, FileViewFlags>([["src/a.ts", { viewed: false, stale: true }]])}
      onToggleViewed={() => {}}
    />,
  );
  expect(screen.getByText("changed")).toBeTruthy();
});

const comment = { file: "src/a.ts", line: 2, side: "RIGHT" as const, author: "agent" as const, body: "Is the empty case tested?" };

function renderWithDraft(draft: Partial<InlineDraft>, props: Partial<Parameters<typeof DiffViewer>[0]> = {}, composer?: InlineComposer) {
  const value: InlineDraft = { comments: [], stale: [], discussions: [], editable: true, busy: false, writing: false, composer: null, open: vi.fn(), ask: vi.fn(), remove: vi.fn(), dismiss: vi.fn(), chat: null, ...draft };
  render(
    <InlineDraftContext.Provider value={value}>
      <InlineComposerContext.Provider value={composer ?? null}>
        <DiffViewer patch={patch} files={["src/a.ts"]} views={new Map()} onToggleViewed={() => {}} {...props} />
      </InlineComposerContext.Provider>
    </InlineDraftContext.Provider>,
  );
  return value;
}

test("draft comments show under their lines with who added them, and the file header counts them", () => {
  renderWithDraft({ comments: [comment], stale: [{ file: "src/a.ts", line: 2, side: "RIGHT" }] });
  const shown = screen.getByRole("article", { name: "Draft comment on src/a.ts:2" });
  expect(within(shown).getByText("Is the empty case tested?")).toBeTruthy();
  expect(within(shown).getByText("Added by agent")).toBeTruthy();
  expect(within(shown).getByText("Older diff")).toBeTruthy();
  expect(screen.getByText("1 draft comment")).toBeTruthy();
});

test("a comment's Edit and Remove act on it, and a collapsed file still counts it", () => {
  const draft = renderWithDraft({ comments: [comment] });
  const shown = screen.getByRole("article", { name: "Draft comment on src/a.ts:2" });
  fireEvent.click(within(shown).getByRole("button", { name: "Edit" }));
  expect(draft.open).toHaveBeenCalledWith(comment);
  fireEvent.click(within(shown).getByRole("button", { name: "Remove" }));
  expect(draft.remove).toHaveBeenCalledWith(comment);
  fireEvent.click(screen.getByRole("checkbox"));
  expect(screen.queryByRole("article")).toBeNull();
  expect(screen.getByText("1 draft comment")).toBeTruthy();
});

test("the gutter + opens a comment box at its line instead of offering the selection's actions", async () => {
  const onLineSelected = vi.fn();
  const draft = renderWithDraft({}, { onLineSelected });
  fireEvent.click(screen.getByRole("button", { name: "Gutter +" }));
  expect(draft.open).toHaveBeenCalledWith({ file: "src/a.ts", line: 2, side: "RIGHT" });
  expect(onLineSelected).not.toHaveBeenCalled();
  await Promise.resolve();
  fireEvent.click(screen.getByRole("button", { name: "Line number" }));
  expect(onLineSelected).toHaveBeenCalledWith("src/a.ts", { start: 2, end: 2, side: "additions" });
});

test("a draft that can't change shows its comments read-only, and the gutter + offers the selection's actions", () => {
  const onLineSelected = vi.fn();
  const draft = renderWithDraft({ comments: [comment], editable: false }, { onLineSelected });
  expect(within(screen.getByRole("article")).queryByRole("button")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Gutter +" }));
  expect(draft.open).not.toHaveBeenCalled();
  expect(onLineSelected).toHaveBeenCalledWith("src/a.ts", { start: 2, end: 2, side: "additions" });
});

test("the comment box takes the place of the comment it edits", () => {
  const composer: InlineComposer = { body: "Is the empty case tested?", change: vi.fn(), save: vi.fn(), askAgent: vi.fn(), cancel: vi.fn(), textareaRef: { current: null } };
  renderWithDraft({ comments: [comment], writing: true, composer: { file: "src/a.ts", line: 2, side: "RIGHT", editing: true, asking: false } }, {}, composer);
  expect(screen.queryByRole("article")).toBeNull();
  const box = screen.getByRole("textbox", { name: "Draft comment" }) as HTMLTextAreaElement;
  expect(box.value).toBe("Is the empty case tested?");
  fireEvent.change(box, { target: { value: "Please test the empty case." } });
  expect(composer.change).toHaveBeenCalledWith("Please test the empty case.");
  fireEvent.click(screen.getByRole("button", { name: "Save comment" }));
  expect(composer.save).toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(composer.cancel).toHaveBeenCalled();
});
