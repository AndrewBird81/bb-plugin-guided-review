import { createContext, memo, useContext, type RefObject } from "react";
import { sameLocation, type CommentLocation, type Discussion, type DiscussionEntry, type DraftComment } from "../src/draft";
import { cn } from "../lib/utils";
import { Button } from "./ui/button";
import { Icon } from "./ui/icon";
import { Textarea } from "./ui/textarea";

/** The draft as the diff shows it, under each comment's line. DraftTray owns the draft and provides this. */
export interface InlineDraft {
  comments: DraftComment[];
  /** Comments drafted against an older diff, which submitting refuses. */
  stale: CommentLocation[];
  /** Discussions with the review assistant, under their line's comment or in its place. */
  discussions: Discussion[];
  /** The draft loaded and its PR is open, so its comments can change. */
  editable: boolean;
  busy: boolean;
  /** A comment is being written, so no other can be opened for editing. */
  writing: boolean;
  /** Where the diff shows the comment box, while it's open there. `asking` when it writes to the agent. */
  composer: (CommentLocation & { editing: boolean; asking: boolean }) | null;
  /** Open the comment box at a line, on the line's comment if it has one. */
  open(at: CommentLocation): void;
  /** Open a box at a line for a message to the review assistant. */
  ask(at: CommentLocation): void;
  remove(comment: DraftComment): void;
  /** Drop the discussion at a line that has no comment. */
  dismiss(at: CommentLocation): void;
  /** Show the review assistant's chat, when the review has one. */
  chat: (() => void) | null;
}

/** The comment box's text. Apart from InlineDraft so that typing re-renders only the box, not the diff. */
export interface InlineComposer {
  body: string;
  change(body: string): void;
  save(): void;
  /** Send the text to the review assistant instead of saving it. */
  askAgent(): void;
  cancel(): void;
  textareaRef: RefObject<HTMLTextAreaElement | null>;
}

export const InlineDraftContext = createContext<InlineDraft | null>(null);
export const InlineComposerContext = createContext<InlineComposer | null>(null);

/** Marks a line's comment and discussion in the diff, so the panel can scroll to them. */
export const locationKey = (at: CommentLocation) => `${at.file}:${at.line}:${at.side}`;

// The diff renders these inside its code view, so set the text style instead of inheriting the code's.
const card = "mx-2 my-1.5 overflow-hidden rounded-md border border-border bg-background font-sans text-sm leading-normal whitespace-normal text-foreground shadow-sm";
const bar = "flex min-h-8 flex-wrap items-center gap-x-2 border-b border-border px-3 py-0.5 text-xs text-muted-foreground";
const action = "h-7 px-2";

/** A line's draft comment, its discussion with the agent, and the comment box while it's open there. */
export const InlineLocation = memo(function InlineLocation({ at }: { at: CommentLocation }) {
  const draft = useContext(InlineDraftContext);
  if (!draft) return null;
  const comment = draft.comments.find((c) => sameLocation(c, at));
  const discussion = draft.discussions.find((d) => sameLocation(d, at));
  const composer = draft.composer && sameLocation(draft.composer, at) ? draft.composer : null;
  const box = composer && (composer.editing ? "edit" : composer.asking ? "ask" : "new");
  if (!comment && !discussion && !box) return null;
  return (
    <div data-draft-at={locationKey(at)} className={card}>
      {box === "edit" ? <ComposerBox mode="edit" /> : comment ? <CommentView comment={comment} draft={draft} /> : discussion && <DiscussionBar discussion={discussion} draft={draft} boxOpen={!!box} />}
      {discussion && <DiscussionView discussion={discussion} draft={draft} titled={!!comment || box === "edit"} />}
      {box && box !== "edit" && <ComposerBox mode={box} divided={!!(comment || discussion)} />}
    </div>
  );
});
InlineLocation.displayName = "InlineLocation";

function CommentView({ comment, draft }: { comment: DraftComment; draft: InlineDraft }) {
  const stale = draft.stale.some((at) => sameLocation(at, comment));
  return (
    <article aria-label={`Draft comment on ${comment.file}:${comment.line}`}>
      <div className={bar}>
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
            <Button variant="ghost" size="sm" className={action} disabled={draft.busy || draft.writing} onClick={() => draft.ask(comment)}>Ask agent</Button>
            <Button variant="ghost" size="sm" className={action} disabled={draft.busy || draft.writing} onClick={() => draft.open(comment)}>Edit</Button>
            <Button variant="ghost" size="sm" className={action} disabled={draft.busy} onClick={() => draft.remove(comment)}>Remove</Button>
          </span>
        )}
      </div>
      <p className="whitespace-pre-wrap break-words px-3 py-2">{comment.body}</p>
    </article>
  );
}

/** Heads a discussion with no comment: a question about the line, or one whose comment the agent removed. */
function DiscussionBar({ discussion, draft, boxOpen }: { discussion: Discussion; draft: InlineDraft; boxOpen: boolean }) {
  const removed = discussion.entries.filter((entry) => entry.kind !== "message").slice(-1)[0]?.kind === "removed";
  return (
    <div className={bar}>
      <Icon name="MessageQuestion" className="size-3.5 shrink-0" aria-hidden />
      <span className="font-medium text-foreground">{removed ? "Removed by agent" : "Discussion with agent"}</span>
      {draft.editable && !boxOpen && (
        <span className="ml-auto flex">
          <Button variant="ghost" size="sm" className={action} disabled={draft.busy || draft.writing} onClick={() => draft.ask(discussion)}>Ask agent</Button>
          <Button variant="ghost" size="sm" className={action} disabled={draft.busy} onClick={() => draft.dismiss(discussion)}>Dismiss</Button>
        </span>
      )}
    </div>
  );
}

const changes: Record<Exclude<DiscussionEntry["kind"], "message">, string> = {
  added: "Agent added this comment.",
  edited: "Agent edited the comment.",
  removed: "Agent removed the comment.",
};

function DiscussionView({ discussion, draft, titled }: { discussion: Discussion; draft: InlineDraft; titled: boolean }) {
  const last = discussion.entries[discussion.entries.length - 1];
  const unanswered = !discussion.waiting && last?.kind === "message" && last.author === "reviewer";
  return (
    <section aria-label={`Discussion with agent on ${discussion.file}:${discussion.line}`} className={cn("space-y-2 bg-muted/40 px-3 py-2", titled && "border-t border-border")}>
      {titled && <p className="text-xs font-medium text-muted-foreground">Discussion with agent</p>}
      {discussion.entries.map((entry, index) => entry.kind === "message"
        ? <div key={index}>
            <p className="text-xs font-medium text-muted-foreground">{entry.author === "agent" ? "Agent" : "You"}</p>
            <p className="whitespace-pre-wrap break-words">{entry.body}</p>
          </div>
        : <p key={index} className="text-xs italic text-muted-foreground">{changes[entry.kind]}</p>)}
      {discussion.waiting
        ? <p role="status" className="flex items-center gap-1.5 text-xs text-muted-foreground"><Icon name="Loading" className="size-3.5 animate-spin motion-reduce:animate-none" aria-hidden />Waiting for agent…</p>
        : unanswered && <p className="flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
            The agent didn’t reply here.
            {draft.chat && <Button variant="link" size="sm" className="h-auto p-0 text-xs" onClick={draft.chat}>Open Ask agent</Button>}
          </p>}
    </section>
  );
}

/** The box for a new comment, an edit, or a message to the agent. */
function ComposerBox({ mode, divided = false }: { mode: "new" | "edit" | "ask"; divided?: boolean }) {
  const draft = useContext(InlineDraftContext);
  const composer = useContext(InlineComposerContext);
  if (!draft?.composer || !composer) return null;
  const empty = !composer.body.trim();
  return (
    <div className={cn("space-y-2 p-2", divided && "border-t border-border")}>
      <Textarea
        ref={composer.textareaRef}
        aria-label={mode === "ask" ? "Message to agent" : "Draft comment"}
        disabled={draft.busy}
        value={composer.body}
        onChange={(event) => composer.change(event.target.value)}
        placeholder={mode === "ask" ? "Ask about this, or say what to change" : "What should the author know?"}
      />
      <div className="flex flex-wrap items-center justify-end gap-2">
        {mode === "ask" && <span className="mr-auto text-xs text-muted-foreground">Goes to the agent, not GitHub.</span>}
        <Button variant="ghost" size="sm" disabled={draft.busy} onClick={composer.cancel}>Cancel</Button>
        {mode === "new" && <Button variant="outline" size="sm" disabled={draft.busy || empty} onClick={composer.askAgent}>Ask agent</Button>}
        <Button size="sm" disabled={draft.busy || empty} onClick={mode === "ask" ? composer.askAgent : composer.save}>
          {mode === "edit" ? "Save comment" : mode === "ask" ? "Send to agent" : "Add to draft"}
        </Button>
      </div>
    </div>
  );
}
