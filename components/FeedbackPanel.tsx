import { memo, useCallback, useEffect, useRef, useState, type FocusEvent, type ReactNode } from "react";
import { Markdown, useRealtime, useRpc } from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import type { rpcContract } from "../src/rpc-contract";
import type { Verdict } from "../src/draft";
import type { FeedbackThread } from "../src/github/types";
import type { AssessmentVerdict, FeedbackItem, FeedbackView } from "../lib/feedback";
import { withLineBreaks } from "../src/line-breaks";
import { cn } from "../lib/utils";
import { Button } from "./ui/button";
import { Textarea } from "./ui/textarea";
import { Badge, type Tone } from "./ui/badge";
import { Avatar } from "./ui/avatar";
import { Icon } from "./ui/icon";
import { FilePath } from "./ui/file-path";
import { InlineCode } from "./ui/inline-code";
import { timeAgo } from "./time-ago";

type Side = "LEFT" | "RIGHT";

const VERDICT_LOOK: Record<AssessmentVerdict, { label: string; tone: Tone }> = {
  addressed: { label: "Addressed", tone: "success" },
  partial: { label: "Partial", tone: "warning" },
  not_addressed: { label: "Not addressed", tone: "danger" },
  disputed: { label: "Author disagrees", tone: "warning" },
  unclear: { label: "Unclear", tone: "neutral" },
};

const STATUS_LOOK: Record<FeedbackThread["status"], { label: string; tone: Tone }> = {
  resolved: { label: "Resolved", tone: "success" },
  question: { label: "Question for you", tone: "primary" },
  answered: { label: "Author replied", tone: "neutral" },
  open: { label: "Open", tone: "neutral" },
};

const SUGGESTED_LABEL: Record<Verdict, string> = { APPROVE: "Approve", REQUEST_CHANGES: "Request changes", COMMENT: "Comment" };

/** Needs a look first, then waiting on the author, then done. */
export function feedbackRank(item: FeedbackItem): number {
  const verdict = item.assessment?.verdict;
  if (verdict) return verdict === "addressed" ? 2 : 0;
  const status = item.thread?.status;
  return status === "resolved" || status === "answered" ? 2 : 1;
}

/** "4 of 5 addressed" from the assistant's check, or "2 of 5 resolved or answered" from GitHub. */
export function feedbackTally(items: FeedbackItem[]): string | null {
  if (items.some((item) => item.assessment)) {
    return `${items.filter((item) => item.assessment?.verdict === "addressed").length} of ${items.length} addressed`;
  }
  const threads = items.flatMap((item) => (item.thread ? [item.thread] : []));
  if (!threads.length) return null;
  return `${threads.filter((thread) => thread.status === "resolved" || thread.status === "answered").length} of ${threads.length} resolved or answered`;
}

function VerdictChip({ verdict }: { verdict: AssessmentVerdict }) {
  const look = VERDICT_LOOK[verdict];
  return <Badge tone={look.tone} title="The assistant’s check" icon={<Icon name="Sparkles" aria-hidden />}>{look.label}</Badge>;
}

function Evidence({ text }: { text: string }) {
  return (
    <div className="flex gap-2 rounded-md border-l-2 border-(--ansi-13)/60 bg-(--ansi-13)/5 px-2.5 py-1.5">
      <Icon name="Sparkles" className="mt-0.5 size-3.5 shrink-0 text-(--ansi-13)" aria-label="Assistant" />
      <Markdown content={text} className="min-w-0 text-sm leading-relaxed" />
    </div>
  );
}

const CLAMP_THRESHOLD = 280;

function Clamped({ text }: { text: string }) {
  const [expanded, setExpanded] = useState(false);
  const long = text.length > CLAMP_THRESHOLD || text.split("\n").length > 5;
  return (
    <div>
      <div className={cn(!expanded && long && "max-h-[5.5rem] overflow-hidden [mask-image:linear-gradient(to_bottom,black_4rem,transparent)]")}>
        <Markdown content={withLineBreaks(text)} className="text-sm leading-relaxed" />
      </div>
      {long && (
        <button type="button" className="mt-0.5 inline-flex items-center gap-0.5 rounded-sm text-xs text-muted-foreground hover:text-foreground" aria-expanded={expanded} onClick={() => setExpanded((value) => !value)}>
          {expanded ? "less" : "more"}
          <Icon name={expanded ? "ChevronUp" : "ChevronDown"} className="size-3" aria-hidden />
        </button>
      )}
    </div>
  );
}

function Replies({ replies }: { replies: FeedbackThread["replies"] }) {
  const [all, setAll] = useState(false);
  const hidden = replies.length - 2;
  const shown = all ? replies : replies.slice(-2);
  if (!replies.length) return null;
  return (
    <div className="space-y-2">
      {hidden > 0 && (
        <button type="button" className="text-xs text-muted-foreground hover:text-foreground" aria-expanded={all} onClick={() => setAll((value) => !value)}>
          {all ? "Show fewer replies" : `Show ${hidden} earlier repl${hidden === 1 ? "y" : "ies"}`}
        </button>
      )}
      <ul className="space-y-2">
        {shown.map((reply, index) => (
          <li key={`${reply.createdAt}:${index}`} className="space-y-1">
            <div className="flex items-center gap-1.5 text-xs">
              <Avatar login={reply.author} size={18} />
              <span className="font-medium text-foreground">{reply.mine ? "You" : `@${reply.author}`}</span>
              {timeAgo(reply.createdAt) && <span className="text-muted-foreground">{timeAgo(reply.createdAt)}</span>}
            </div>
            <div className="pl-6"><Markdown content={withLineBreaks(reply.body)} className="text-sm leading-relaxed" /></div>
          </li>
        ))}
      </ul>
    </div>
  );
}

interface ThreadActions {
  resolve: (thread: FeedbackThread, resolved: boolean) => Promise<void>;
  send: (thread: FeedbackThread, body: string) => Promise<boolean>;
  discard: (thread: FeedbackThread) => Promise<void>;
  saveDraft: (thread: FeedbackThread, body: string) => void;
}

function ThreadCard({ item, thread, actions, onShowLocation, onFollowUp }: {
  item: FeedbackItem;
  thread: NonNullable<FeedbackItem["thread"]>;
  actions: ThreadActions;
  onShowLocation: (file: string, line: number | null, side: Side) => void;
  onFollowUp: (file: string, line: number | null, side: Side) => void;
}) {
  const draftBody = item.replyDraft?.body ?? "";
  const [text, setText] = useState(draftBody);
  const [replying, setReplying] = useState(!!draftBody);
  const [busy, setBusy] = useState(false);
  // The reply as last saved; a newer drafted reply replaces the box's text only when it isn't edited.
  const saved = useRef(draftBody);
  useEffect(() => {
    setText((current) => (current === saved.current ? draftBody : current));
    saved.current = draftBody;
    if (draftBody) setReplying(true);
  }, [draftBody]);

  const file = thread.path;
  // The thread's line in the current diff; an outdated thread may only have the assistant's pointer.
  const line = thread.line ?? (item.assessment?.file === file ? item.assessment?.line ?? null : null);
  const side: Side = thread.side ?? "RIGHT";
  const shownLine = thread.line ?? thread.originalLine;
  const status = STATUS_LOOK[thread.status];
  const drafted = item.replyDraft?.author === "agent" && text === draftBody && !!draftBody;

  async function run(operation: () => Promise<unknown>) {
    setBusy(true);
    try { await operation(); } finally { setBusy(false); }
  }
  function saveIfChanged(event: FocusEvent<HTMLTextAreaElement>) {
    // Send and Discard settle the draft themselves.
    if (text === saved.current || (event.relatedTarget as HTMLElement | null)?.dataset.replyAction) return;
    saved.current = text;
    actions.saveDraft(thread, text);
  }

  return (
    <article aria-label={item.title} className="space-y-2.5 rounded-xl border border-border border-l-[3px] border-l-primary/60 bg-card p-3 shadow-xs">
      <div className="flex flex-wrap items-center gap-1.5">
        {item.assessment && <VerdictChip verdict={item.assessment.verdict} />}
        <Badge tone={status.tone}>{status.label}</Badge>
        {thread.isOutdated && <Badge icon={<Icon name="GitCommit" aria-hidden />}>Code changed</Badge>}
        <button
          type="button"
          disabled={!file}
          aria-label={file ? `Show ${file}${shownLine != null ? `:${shownLine}` : ""} in the diff` : "No file"}
          className="ml-auto flex min-w-0 max-w-full items-center rounded-sm text-xs decoration-muted-foreground/50 underline-offset-2 enabled:hover:underline disabled:opacity-60"
          onClick={() => file && onShowLocation(file, line, side)}
        >
          {file ? <><FilePath path={file} className="min-w-0 text-[11px]" />{shownLine != null && <span className="shrink-0 font-mono text-[11px] text-primary">:{shownLine}</span>}</> : <span className="text-muted-foreground">Whole PR</span>}
        </button>
      </div>
      <div className="space-y-1">
        <p className="text-xs font-medium text-muted-foreground">Your comment</p>
        <Clamped text={thread.body} />
      </div>
      <Replies replies={thread.replies} />
      {item.assessment?.evidence && <Evidence text={item.assessment.evidence} />}
      {replying && (
        <div className="space-y-2 border-t border-border pt-2.5">
          {drafted && <Badge tone="agent" size="sm" icon={<Icon name="Sparkles" aria-hidden />}>Drafted by assistant</Badge>}
          <Textarea aria-label={`Reply to ${item.title}`} value={text} disabled={busy} onChange={(event) => setText(event.target.value)} onBlur={saveIfChanged} placeholder="Reply on GitHub…" />
          <div className="flex flex-wrap gap-2">
            <Button size="sm" data-reply-action="send" disabled={busy || !text.trim()} onClick={() => void run(async () => {
              if (await actions.send(thread, text.trim())) { saved.current = ""; setText(""); setReplying(false); }
            })}><Icon name="Github" aria-hidden />Send</Button>
            <Button size="sm" variant="ghost" data-reply-action="discard" disabled={busy} onClick={() => void run(async () => {
              if (saved.current || item.replyDraft) await actions.discard(thread);
              saved.current = ""; setText(""); setReplying(false);
            })}>Discard</Button>
          </div>
        </div>
      )}
      <div className="-mb-1 -ml-2 flex flex-wrap gap-0.5">
        <Button variant="ghost" size="sm" className="h-7 px-2 text-xs text-muted-foreground" disabled={busy} onClick={() => void run(() => actions.resolve(thread, !thread.isResolved))}>
          <Icon name={thread.isResolved ? "RotateCcw" : "CircleCheck"} className="size-3.5" aria-hidden />{thread.isResolved ? "Unresolve" : "Resolve"}
        </Button>
        {!replying && <Button variant="ghost" size="sm" className="h-7 px-2 text-xs text-muted-foreground" onClick={() => setReplying(true)}><Icon name="CornerDownRight" className="size-3.5" aria-hidden />Reply</Button>}
        <Button variant="ghost" size="sm" className="h-7 px-2 text-xs text-muted-foreground" disabled={!file} onClick={() => file && onFollowUp(file, thread.line, side)}>
          <Icon name="MessageSquarePlus" className="size-3.5" aria-hidden />Follow up
        </Button>
      </div>
    </article>
  );
}

function SummaryCard({ item }: { item: FeedbackItem }) {
  return (
    <article aria-label={item.title} className="space-y-2 rounded-xl border border-border border-l-[3px] border-l-primary/60 bg-card p-3 shadow-xs">
      <div className="flex flex-wrap items-center gap-1.5">
        {item.assessment && <VerdictChip verdict={item.assessment.verdict} />}
        <span className="text-xs text-muted-foreground">From your review summary</span>
      </div>
      <p className="text-sm text-foreground"><InlineCode text={item.title} /></p>
      {item.assessment?.evidence && <Evidence text={item.assessment.evidence} />}
    </article>
  );
}

function EmptyState({ text, children }: { text: string; children?: ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-3 p-8 text-center">
      <span aria-hidden className="flex size-10 items-center justify-center rounded-full bg-muted/60 text-muted-foreground ring-1 ring-inset ring-border">
        <Icon name="ChatFeedback" className="size-5" />
      </span>
      <p className="text-sm text-muted-foreground">{text}</p>
      {children}
    </div>
  );
}

/** Your feedback from your last review, where each piece stands on GitHub, and the assistant's check of it. */
export const FeedbackPanel = memo(function FeedbackPanel({ targetKey, review, revision, onShowLocation, onFollowUp, onDraftUpdated }: {
  targetKey: string;
  review?: { submittedVerdict?: Verdict | null } | null;
  /** The review revision the page shows, for draft changes. */
  revision?: string;
  onShowLocation: (file: string, line: number | null, side: Side) => void;
  /** Open a comment box at the line, or show the file when the thread has no current line. */
  onFollowUp: (file: string, line: number | null, side: Side) => void;
  /** The assistant's suggestion went into the draft. */
  onDraftUpdated: () => void;
}) {
  const rpc = useRpc<typeof rpcContract>();
  const [feedback, setFeedback] = useState<FeedbackView | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [busy, setBusy] = useState<"check" | "refresh" | "suggested" | "remaining" | null>(null);
  const request = useRef(0);

  const load = useCallback(async () => {
    const id = ++request.current;
    try {
      const { feedback } = await rpc.call("getFeedback", { targetKey });
      if (id !== request.current) return;
      setFeedback(feedback as FeedbackView);
      setLoadError(false);
    } catch {
      if (id === request.current) setLoadError(true);
    }
  }, [rpc, targetKey]);
  useEffect(() => {
    void load();
    return () => { request.current++; };
  }, [load]);
  useRealtime(`feedback:${targetKey}`, () => { void load(); });
  useRealtime(`review:${targetKey}`, () => { void load(); });

  const show = (next: unknown) => {
    request.current++;
    if (next) setFeedback(next as FeedbackView);
  };

  async function act(kind: NonNullable<typeof busy>, operation: () => Promise<void>) {
    setBusy(kind);
    try { await operation(); }
    catch (error) { toast.error(error instanceof Error ? error.message : "Something went wrong"); }
    finally { setBusy(null); }
  }
  const checkAgain = () => act("check", async () => {
    const result = await rpc.call("checkFeedback", { targetKey });
    if (result.ok) toast.success("Checking your feedback against the PR.");
    else toast.error(result.error ?? "Couldn’t start the check.");
  });
  const refresh = () => act("refresh", async () => {
    show((await rpc.call("refreshFeedback", { targetKey })).feedback);
  });
  const applySuggestion = (mode: "suggested" | "remaining") => act(mode, async () => {
    const result = await rpc.call("useSuggestedVerdict", { targetKey, mode, ...(revision ? { revision } : {}) });
    if (!result.ok) return void toast.error(result.error ?? "Couldn’t update the draft.");
    onDraftUpdated();
    toast.success("Draft updated — review it before submitting.");
  });

  const actions: ThreadActions = {
    resolve: async (thread, resolved) => {
      try {
        const result = await rpc.call(resolved ? "resolveThread" : "unresolveThread", { targetKey, threadId: thread.id });
        if (!result.ok) return void toast.error(result.error ?? "Couldn’t update the thread.");
        show((await rpc.call("refreshFeedback", { targetKey })).feedback);
      } catch (error) {
        toast.error(error instanceof Error ? error.message : "Couldn’t update the thread.");
      }
    },
    send: async (thread, body) => {
      try {
        const result = await rpc.call("replyToFeedback", { targetKey, threadId: thread.id, body });
        if (!result.ok) {
          toast.error(result.error ?? "Couldn’t post the reply. It’s still here.");
          return false;
        }
        if (result.feedback) show(result.feedback);
        else void load();
        return true;
      } catch (error) {
        toast.error(error instanceof Error ? error.message : "Couldn’t post the reply. It’s still here.");
        return false;
      }
    },
    discard: async (thread) => {
      await rpc.call("discardReplyDraft", { targetKey, threadId: thread.id }).catch(() => {});
    },
    saveDraft: (thread, body) => {
      void rpc.call("saveReplyDraft", { targetKey, threadId: thread.id, body }).catch(() => toast.error("Couldn’t save your reply draft."));
    },
  };

  if (loadError && !feedback) {
    return (
      <div role="alert" className="m-4 flex flex-wrap items-center gap-2 rounded-lg border border-destructive/20 bg-destructive/10 px-3 py-2 text-sm text-destructive-text">
        <Icon name="AlertCircle" className="size-4 shrink-0" aria-hidden />
        <p className="min-w-0 flex-1">Couldn't load your feedback.</p>
        <Button variant="outline" size="sm" onClick={() => void load()}>Try again</Button>
      </div>
    );
  }
  if (!feedback) return <p role="status" className="p-4 text-sm text-muted-foreground">Loading your feedback…</p>;

  const reviewed = !!(feedback.baseline.at || feedback.baseline.verdict || feedback.baseline.sha || review?.submittedVerdict);
  if (!reviewed && !feedback.items.length) return <EmptyState text="Your feedback appears here after you submit a review." />;
  if (!feedback.items.length && !feedback.run) {
    return (
      <EmptyState text="Your last review had no line comments.">
        <Button variant="outline" size="sm" disabled={!!busy} onClick={() => void checkAgain()}>{busy === "check" ? "Checking…" : "Check again"}</Button>
      </EmptyState>
    );
  }

  const items = [...feedback.items].sort((a, b) => feedbackRank(a) - feedbackRank(b));
  const tally = feedbackTally(items);
  const run = feedback.run;
  const checked = run && timeAgo(run.assessedAt);
  const left = items.some((item) => item.assessment && item.assessment.verdict !== "addressed");

  return (
    <div className="space-y-3">
      <header className="flex flex-wrap items-start gap-2">
        <div className="min-w-0 flex-1 space-y-0.5">
          <h2 className="text-sm font-semibold text-foreground">Your feedback</h2>
          <p className="flex flex-wrap items-center gap-x-1.5 gap-y-1 text-xs text-muted-foreground">
            {tally && <span className="font-medium tabular-nums text-foreground/90">{tally}</span>}
            {tally && run && <span aria-hidden>·</span>}
            {run && <span>Checked {checked ?? "earlier"} · <span className="font-mono">{run.headSha.slice(0, 7)}</span></span>}
            {run && !run.current && <Badge tone="warning" size="sm" title="The assistant checked an earlier commit than the PR’s head.">older commit</Badge>}
          </p>
        </div>
        <Button variant="outline" size="sm" className="h-7 px-2 text-xs" disabled={!!busy} onClick={() => void checkAgain()}>
          <Icon name="Sparkles" className="size-3.5 text-(--ansi-13)" aria-hidden />{busy === "check" ? "Checking…" : "Check again"}
        </Button>
        <Button variant="ghost" size="sm" className="h-7 px-2 text-xs text-muted-foreground" disabled={!!busy} onClick={() => void refresh()}>
          <Icon name="ArrowReloadHorizontal" className={cn("size-3.5", busy === "refresh" && "animate-spin motion-reduce:animate-none")} aria-hidden />Refresh
        </Button>
      </header>
      {run && (
        <section aria-label="Assistant’s suggestion" className="space-y-2 rounded-xl border border-(--ansi-13)/30 border-l-[3px] border-l-(--ansi-13)/60 bg-(--ansi-13)/5 p-3">
          <p className="flex items-center gap-1.5 text-sm font-medium text-foreground">
            <Icon name="Sparkles" className="size-4 text-(--ansi-13)" aria-hidden />
            {run.suggestedVerdict ? `Assistant suggests: ${SUGGESTED_LABEL[run.suggestedVerdict]}` : "Assistant’s check"}
          </p>
          {(run.suggestedBody || run.summary) && <Markdown content={withLineBreaks(run.suggestedBody || run.summary)} className="text-sm leading-relaxed" />}
          {(run.suggestedVerdict || left) && (
            <div className="flex flex-wrap gap-2">
              {run.suggestedVerdict && <Button size="sm" disabled={!!busy} onClick={() => void applySuggestion("suggested")}>Use as draft</Button>}
              {left && <Button size="sm" variant="outline" disabled={!!busy} onClick={() => void applySuggestion("remaining")}>Request what’s left</Button>}
            </div>
          )}
        </section>
      )}
      {items.length ? (
        <div className="space-y-3">
          {items.map((item) => item.kind === "thread" && item.thread
            ? <ThreadCard key={item.id} item={item} thread={item.thread} actions={actions} onShowLocation={onShowLocation} onFollowUp={onFollowUp} />
            : <SummaryCard key={item.id} item={item} />)}
        </div>
      ) : <EmptyState text="Your last review had no line comments." />}
    </div>
  );
});
FeedbackPanel.displayName = "FeedbackPanel";
