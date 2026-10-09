import { createContext, memo, useContext, type RefObject } from "react";
import { sameLocation, type CommentLocation, type DraftComment } from "../src/draft";
import { cn } from "../lib/utils";
import { Button } from "./ui/button";
import { Icon } from "./ui/icon";
import { Textarea } from "./ui/textarea";

/** The draft as the diff shows it, under each comment's line. DraftTray owns the draft and provides this. */
export interface InlineDraft {
  comments: DraftComment[];
  /** Comments drafted against an older diff, which submitting refuses. */
  stale: CommentLocation[];
  /** The draft loaded and its PR is open, so its comments can change. */
  editable: boolean;
  busy: boolean;
  /** A comment is being written, so no other can be opened for editing. */
  writing: boolean;
  /** Where the diff shows the comment box, while it's open there. */
  composer: (CommentLocation & { editing: boolean }) | null;
  /** Open the comment box at a line, on the line's comment if it has one. */
  open(at: CommentLocation): void;
  remove(comment: DraftComment): void;
}

/** The comment box's text. Apart from InlineDraft so that typing re-renders only the box, not the diff. */
export interface InlineComposer {
  body: string;
  change(body: string): void;
  save(): void;
  cancel(): void;
  textareaRef: RefObject<HTMLTextAreaElement | null>;
}

export const InlineDraftContext = createContext<InlineDraft | null>(null);
export const InlineComposerContext = createContext<InlineComposer | null>(null);

/** Marks a comment's place in the diff, so the panel can scroll to it. */
export const locationKey = (at: CommentLocation) => `${at.file}:${at.line}:${at.side}`;

// The diff renders these inside its code view, so set the text style instead of inheriting the code's.
const card = "mx-2 my-1.5 rounded-md border border-border bg-background font-sans text-sm leading-normal whitespace-normal text-foreground shadow-sm";

export const InlineDraftComment = memo(function InlineDraftComment({ comment }: { comment: DraftComment }) {
  const draft = useContext(InlineDraftContext);
  if (!draft) return null;
  const stale = draft.stale.some((at) => sameLocation(at, comment));
  return (
    <article data-draft-at={locationKey(comment)} aria-label={`Draft comment on ${comment.file}:${comment.line}`} className={card}>
      <div className="flex min-h-8 flex-wrap items-center gap-x-2 border-b border-border px-3 py-0.5 text-xs text-muted-foreground">
        <Icon name="MessageSquare" className="size-3.5 shrink-0" aria-hidden />
        <span className="font-medium text-foreground">Draft</span>
        {comment.author === "agent" && <span>Added by agent</span>}
        {stale && (
          <span
            className="rounded-full border border-amber-500/40 px-1.5 text-[10px] leading-4 text-amber-600 dark:text-amber-400"
            title="Drafted against an older diff. Edit and save it, or remove it, before submitting."
          >
            Older diff
          </span>
        )}
        {draft.editable && (
          <span className="ml-auto flex">
            <Button variant="ghost" size="sm" className="h-7 px-2" disabled={draft.busy || draft.writing} onClick={() => draft.open(comment)}>Edit</Button>
            <Button variant="ghost" size="sm" className="h-7 px-2" disabled={draft.busy} onClick={() => draft.remove(comment)}>Remove</Button>
          </span>
        )}
      </div>
      <p className="whitespace-pre-wrap break-words px-3 py-2">{comment.body}</p>
    </article>
  );
});
InlineDraftComment.displayName = "InlineDraftComment";

export function InlineDraftComposer() {
  const draft = useContext(InlineDraftContext);
  const composer = useContext(InlineComposerContext);
  if (!draft?.composer || !composer) return null;
  return (
    <div data-draft-at={locationKey(draft.composer)} className={cn(card, "space-y-2 p-2")}>
      <Textarea
        ref={composer.textareaRef}
        aria-label="Draft comment"
        disabled={draft.busy}
        value={composer.body}
        onChange={(event) => composer.change(event.target.value)}
        placeholder="What should the author know?"
      />
      <div className="flex justify-end gap-2">
        <Button variant="ghost" size="sm" disabled={draft.busy} onClick={composer.cancel}>Cancel</Button>
        <Button size="sm" disabled={draft.busy || !composer.body.trim()} onClick={composer.save}>
          {draft.composer.editing ? "Save comment" : "Add to draft"}
        </Button>
      </div>
    </div>
  );
}
