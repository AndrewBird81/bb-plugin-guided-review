import { memo, useCallback, useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import * as Tooltip from "@radix-ui/react-tooltip";
import { useRealtime, useRpc } from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import type { rpcContract } from "../src/rpc-contract";
import { reviewState, type ReviewItem } from "../lib/review-state";
import { sameLocation, type CommentLocation, type Discussion, type Draft, type DraftComment, type Verdict } from "../src/draft";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Textarea } from "./ui/textarea";
import { Icon } from "./ui/icon";
import { ReviewerNotes } from "./ReviewerNotes";
import { cn } from "../lib/utils";
import { AgentDock, type AgentDockProps } from "./AgentDock";
import { getReviewState, patchReviewState } from "../lib/panel-state";
import { readDraftRecovery, updateDraftRecovery } from "../lib/draft-recovery";
import { usePortalScopeProps } from "../lib/portal-scope";
import { InlineComposerContext, InlineDraftContext, type InlineComposer, type InlineDraft } from "./InlineDraft";

/**
 * A request from the diff to comment on a line, or with `ask` to message the
 * agent about it; the box opens there. `startLine` is the other end of a selection.
 */
export interface CommentPrefill { file: string; line: number; side: "LEFT" | "RIGHT"; startLine?: number; ask?: boolean; nonce: number; }

export const DraftTray = memo(function DraftTray({ targetKey, activeChapterId, activeFiles, prefill, isLocal = false, review, onSubmitted, onShowComment, agent, reviewRevision, account, children }: {
  targetKey: string; activeChapterId: string; activeFiles: string[]; prefill?: CommentPrefill; isLocal?: boolean; review?: ReviewItem; onSubmitted?: () => void; onShowComment?: (at: CommentLocation) => void;
  reviewRevision?: string; account?: string;
  agent?: Omit<AgentDockProps, "targetKey" | "active" | "onDock" | "onCollapse">;
  /** The diff, which shows the draft's comments under their lines. */
  children?: ReactNode;
}) {
  const rpc = useRpc<typeof rpcContract>();
  const [draft, setDraft] = useState<Draft>({ targetKey, verdict: "COMMENT", body: "", comments: [] });
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState("Draft saved");
  const [file, setFile] = useState(activeFiles[0] ?? "");
  const [line, setLine] = useState("1");
  const [side, setSide] = useState<"LEFT" | "RIGHT">("RIGHT");
  const [body, setBody] = useState("");
  const [showComposer, setShowComposer] = useState(false);
  const [editing, setEditing] = useState<DraftComment | null>(null);
  // Whether the open comment box is in the diff rather than this panel.
  const [inline, setInline] = useState(false);
  // Whether the box's text is a message to the agent rather than a comment, and the other end of the lines it's about.
  const [asking, setAsking] = useState(false);
  const [startLine, setStartLine] = useState<number | undefined>();
  const [stale, setStale] = useState<CommentLocation[]>([]);
  const [discussions, setDiscussions] = useState<Discussion[]>([]);
  const [writeAnother, setWriteAnother] = useState(false);
  const [receipt, setReceipt] = useState<Verdict | null>(null);
  const [showNotes, setShowNotes] = useState(false);
  const [tab, setTab] = useState<"draft" | "notes" | "agent">(() => {
    const saved = getReviewState(targetKey).activeTool;
    return saved === "notes" || saved === "agent" && agent ? saved : "draft";
  });
  const [toolsOpen, setToolsOpen] = useState(() => getReviewState(targetKey).toolsOpen !== false);
  const panelId = useId();
  const railRef = useRef<HTMLDivElement>(null);
  const scopeProps = usePortalScopeProps();
  useEffect(() => { patchReviewState(targetKey, { activeTool: tab, toolsOpen }); }, [targetKey, tab, toolsOpen]);
  useEffect(() => { if (agent?.injection) { setTab("agent"); setToolsOpen(true); } }, [agent?.injection]);
  function collapse() {
    setToolsOpen(false);
    railRef.current?.querySelector<HTMLButtonElement>(`[data-tool="${tab}"]`)?.focus();
  }
  function selectTool(next: typeof tab) {
    if (toolsOpen && tab === next) collapse();
    else { setTab(next); setToolsOpen(true); }
  }
  const bodyRef = useRef<HTMLTextAreaElement>(null);
  const mounted = useRef(true);
  const lock = useRef(false);
  const writes = useRef<Promise<unknown>>(Promise.resolve());
  const pending = useRef<ReturnType<typeof setTimeout> | null>(null);
  const revisionRef = useRef(reviewRevision); revisionRef.current = reviewRevision;
  const summaryRevision = useRef(reviewRevision);
  const summaryRecoveryId = useRef<string | undefined>(undefined);
  const composerRevision = useRef(reviewRevision);
  const summary = useRef({ verdict: "COMMENT" as Verdict, body: "", revision: 0, dirty: false });
  const shownComments = useRef(draft.comments); shownComments.current = draft.comments;

  useEffect(() => {
    if (!loaded) return;
    updateDraftRecovery(targetKey, { composer: body ? { file, line, side, body, revision: composerRevision.current, inline, ...(asking ? { asking } : {}), ...(startLine ? { startLine } : {}) } : undefined });
  }, [loaded, targetKey, file, line, side, body, inline, asking, startLine]);
  useEffect(() => {
    const protect = (event: BeforeUnloadEvent) => { if (body.trim() || summary.current.dirty) event.preventDefault(); };
    window.addEventListener("beforeunload", protect);
    return () => window.removeEventListener("beforeunload", protect);
  }, [body]);

  const enqueue = useCallback(<T,>(operation: () => Promise<T>) => {
    const next = writes.current.catch(() => {}).then(operation);
    writes.current = next;
    return next;
  }, []);

  const flush = useCallback(() => {
    if (pending.current) clearTimeout(pending.current);
    pending.current = null;
    const current = summary.current;
    if (!current.dirty) return writes.current;
    const { verdict, body, revision } = current;
    const viewedRevision = summaryRevision.current;
    const recoveryId = summaryRecoveryId.current;
    current.dirty = false;
    return enqueue(async () => {
      try {
        await rpc.call("setVerdict", { targetKey, verdict, body, ...(viewedRevision ? { revision: viewedRevision } : {}) });
        if (summary.current.revision === revision) {
          if (recoveryId && readDraftRecovery(targetKey).summary?.editId === recoveryId) updateDraftRecovery(targetKey, { summary: undefined });
          if (mounted.current) setSaved("Draft saved");
        }
      } catch (error) {
        if (summary.current.revision === revision) {
          summary.current.dirty = true;
          if (mounted.current) setSaved(error instanceof Error ? `Couldn’t save summary. ${error.message}` : "Couldn’t save summary. Try again.");
        }
        throw error;
      }
    });
  }, [enqueue, rpc, targetKey]);

  const load = useCallback(async () => {
    setLoadError(false);
    try {
      const result = await rpc.call("getDraft", { targetKey });
      if (!mounted.current) return;
      const next = result.draft as Draft;
      const recovered = readDraftRecovery(targetKey);
      setDraft({ ...next, ...(recovered.summary ? { verdict: recovered.summary.verdict, body: recovered.summary.body } : {}) });
      setStale(result.stale ?? []);
      setDiscussions(result.discussions ?? []);
      summary.current = { verdict: recovered.summary?.verdict ?? next.verdict, body: recovered.summary?.body ?? next.body, revision: 0, dirty: !!recovered.summary };
      if (recovered.summary) {
        summaryRevision.current = recovered.summary.revision;
        summaryRecoveryId.current = recovered.summary.editId;
        setShowNotes(true);
        setSaved("Couldn’t save earlier edits. Recovered in this tab; check the revision before saving again.");
      }
      if (recovered.composer) {
        const comment = recovered.composer;
        composerRevision.current = comment.revision;
        setFile(comment.file); setLine(comment.line); setSide(comment.side); setBody(comment.body); setInline(comment.inline === true); setShowComposer(true);
        setAsking(comment.asking === true); setStartLine(comment.startLine);
        setEditing(comment.asking ? null : next.comments.find((c) => sameLocation(c, { file: comment.file, line: Number(comment.line), side: comment.side })) ?? null);
      }
      setLoaded(true);
    } catch {
      if (mounted.current) setLoadError(true);
    }
  }, [rpc, targetKey]);

  useEffect(() => {
    mounted.current = true;
    void load();
    return () => { mounted.current = false; void flush().catch(() => {}); };
  }, [load, flush]);
  // The review assistant adds comments while the draft is open.
  const refreshComments = useCallback(() => {
    void enqueue(() => rpc.call("getDraft", { targetKey })).then(updateComments).catch(() => {});
  }, [enqueue, rpc, targetKey]);
  useRealtime(`draft:${targetKey}`, refreshComments);

  useEffect(() => { if (!showComposer && !body.trim()) setFile(activeFiles[0] ?? ""); }, [activeFiles, showComposer, body]);
  /**
   * Open the comment box, in the diff or this panel, on a line's comment if it has one;
   * with `ask`, a box for a message to the agent. An unfinished comment or message is shown instead.
   */
  function openComposer(at: (CommentLocation & { startLine?: number }) | null, inDiff: boolean, ask = false) {
    const writing = !!body.trim();
    if (writing) toast.info(asking ? "Send or cancel your message to the agent first." : "Finish or cancel the comment you’re writing first.");
    else {
      const existing = !ask && at ? draft.comments.find((comment) => sameLocation(comment, at)) : undefined;
      composerRevision.current = revisionRef.current;
      setEditing(existing ?? null);
      if (at) { setFile(at.file); setLine(String(at.line)); setSide(at.side); }
      setStartLine(at?.startLine !== at?.line ? at?.startLine : undefined);
      setAsking(ask);
      setBody(existing ? existing.body : "");
      setInline(inDiff);
      setShowComposer(true);
    }
    if (writing ? !inline : !inDiff) { setTab("draft"); setToolsOpen(true); }
    requestAnimationFrame(() => bodyRef.current?.focus());
  }
  useEffect(() => { if (prefill) openComposer(prefill, true, prefill.ask); }, [prefill]);
  function changeBody(text: string) {
    if (!body) composerRevision.current = revisionRef.current;
    setBody(text);
  }
  function closeComposer() { setBody(""); setEditing(null); setAsking(false); setStartLine(undefined); setShowComposer(false); }

  function updateSummary(change: Partial<Pick<Draft, "verdict" | "body">>) {
    setDraft((previous) => ({ ...previous, ...change }));
    summaryRevision.current = revisionRef.current;
    summary.current = { ...summary.current, ...change, revision: summary.current.revision + 1, dirty: true };
    summaryRecoveryId.current = crypto.randomUUID();
    updateDraftRecovery(targetKey, { summary: { editId: summaryRecoveryId.current, verdict: summary.current.verdict, body: summary.current.body, revision: summaryRevision.current } });
    setSaved("Saving draft…");
    if (pending.current) clearTimeout(pending.current);
    pending.current = setTimeout(() => { void flush().catch(() => {}); }, 400);
  }

  async function mutate(operation: () => Promise<void>) {
    if (lock.current) return;
    lock.current = true; setBusy(true);
    try { await operation(); }
    catch (error) { toast.error(error instanceof Error ? error.message : "Couldn’t save the draft. Try again."); }
    finally { lock.current = false; if (mounted.current) setBusy(false); }
  }

  function updateComments(next: { draft: Draft; stale?: CommentLocation[]; discussions?: Discussion[] }) {
    if (!mounted.current) return;
    setDraft((previous) => ({ ...previous, comments: next.draft.comments }));
    setStale(next.stale ?? []);
    setDiscussions(next.discussions ?? []);
  }
  /** Send the box's text to the agent, which answers in the line's discussion. */
  async function askAgent() {
    if (!body.trim()) return;
    await mutate(async () => {
      const result = await enqueue(() => rpc.call("askAgent", { targetKey, file, line: Number(line), side, ...(startLine ? { startLine } : {}), body: body.trim() }));
      updateComments(result); closeComposer();
    });
  }
  async function dismissDiscussion({ file, line, side }: CommentLocation) {
    await mutate(async () => {
      updateComments(await enqueue(() => rpc.call("dismissDiscussion", { targetKey, file, line, side })));
    });
  }
  async function addComment() {
    if (!file.trim() || !body.trim() || !Number.isInteger(Number(line)) || Number(line) < 1) return;
    await mutate(async () => {
      const result = await enqueue(() => rpc.call("saveDraftComment", { targetKey, ...(composerRevision.current ? { revision: composerRevision.current } : {}), comment: { file, line: Number(line), side, chapterId: editing?.chapterId ?? activeChapterId, body: body.trim() } }));
      updateComments(result); closeComposer();
    });
  }
  async function removeComment({ file, line, side }: DraftComment) {
    await mutate(async () => {
      const result = await enqueue(() => rpc.call("removeDraftComment", { targetKey, file, line, side }));
      updateComments(result);
    });
  }
  async function submit() {
    if (isLocal || !loaded || body.trim()) return;
    await mutate(async () => {
      await flush();
      const result = await enqueue(() => rpc.call("submitReview", { targetKey, ...(reviewRevision ? { revision: reviewRevision } : {}), ...(account ? { account } : {}), comments: shownComments.current }));
      if (!result.ok) { setSaved(result.error ?? "Submit failed. Your draft is still here."); toast.error(result.error ?? "Submit failed. Your draft is still here."); refreshComments(); return; }
      setReceipt(summary.current.verdict);
      setWriteAnother(false);
      onSubmitted?.();
      toast.success("Review submitted to GitHub");
      await load();
      setSaved("Review submitted");
    });
  }

  const hasReview = draft.comments.length > 0 || draft.body.trim().length > 0 || draft.verdict === "APPROVE";
  const submittedVerdict = review ? review.submittedVerdict : receipt;
  const closed = review?.prState === "MERGED" || review?.prState === "CLOSED";
  const completed = submittedVerdict && !hasReview && !writeAnother && !body.trim();
  // The diff shows the draft's comments and discussions, and the comment box while it's open there.
  const latest = useRef({ openComposer, removeComment, addComment, askAgent, dismissDiscussion, changeBody, closeComposer });
  latest.current = { openComposer, removeComment, addComment, askAgent, dismissDiscussion, changeBody, closeComposer };
  const open = useCallback((at: CommentLocation) => latest.current.openComposer(at, true), []);
  const ask = useCallback((at: CommentLocation) => latest.current.openComposer(at, true, true), []);
  const remove = useCallback((comment: DraftComment) => { void latest.current.removeComment(comment); }, []);
  const dismiss = useCallback((at: CommentLocation) => { void latest.current.dismissDiscussion(at); }, []);
  const showChat = useCallback(() => { setTab("agent"); setToolsOpen(true); }, []);
  const editable = loaded && !loadError && !closed;
  const writing = !!body.trim();
  const composerInDiff = editable && showComposer && inline;
  const chat = agent ? showChat : null;
  const inlineDraft = useMemo<InlineDraft>(() => ({
    comments: draft.comments, stale, discussions, editable, busy, writing, open, ask, remove, dismiss, chat,
    composer: composerInDiff ? { file, line: Number(line), side, editing: editing !== null, asking } : null,
  }), [draft.comments, stale, discussions, editable, busy, writing, open, ask, remove, dismiss, chat, composerInDiff, file, line, side, editing, asking]);
  const inlineComposer = useMemo<InlineComposer | null>(() => composerInDiff ? {
    body, textareaRef: bodyRef,
    change: (text) => latest.current.changeBody(text),
    save: () => { void latest.current.addComment(); },
    askAgent: () => { void latest.current.askAgent(); },
    cancel: () => latest.current.closeComposer(),
  } : null, [composerInDiff, body]);
  const toolItems = [
    { id: "draft", label: "Draft comments", icon: "MessageSquare", count: draft.comments.length },
    { id: "notes", label: "Reviewer notes", icon: "EditFile", count: 0 },
    ...(agent ? [{ id: "agent", label: "Ask agent", icon: "MessageQuestion", count: 0 }] as const : []),
  ] as const;
  return <InlineDraftContext.Provider value={inlineDraft}><InlineComposerContext.Provider value={inlineComposer}>
  {children}
  <aside aria-label="Review tools" className={cn("flex max-h-[50vh] min-h-0 shrink-0 flex-col border-t border-border bg-background @min-[1024px]/review:h-full @min-[1024px]/review:max-h-none @min-[1024px]/review:flex-row-reverse @min-[1024px]/review:border-l @min-[1024px]/review:border-t-0", toolsOpen ? "@min-[1024px]/review:w-[384px]" : "@min-[1024px]/review:w-11", toolsOpen && tab === "agent" && "h-[50vh]")}>
    <div ref={railRef} role="group" aria-label="Review tools" className={cn("flex h-11 shrink-0 items-center gap-0.5 bg-muted/20 p-0.5 @min-[1024px]/review:h-full @min-[1024px]/review:w-11 @min-[1024px]/review:flex-col", toolsOpen && "border-b border-border @min-[1024px]/review:border-b-0 @min-[1024px]/review:border-l")}>
      <Tooltip.Provider delayDuration={350}>
        {toolItems.map((tool) => <Tooltip.Root key={tool.id}>
          <Tooltip.Trigger asChild>
            <Button variant="ghost" size="icon" data-tool={tool.id} aria-label={tool.label} aria-pressed={toolsOpen && tab === tool.id} aria-expanded={toolsOpen && tab === tool.id} aria-controls={panelId} onClick={() => selectTool(tool.id)} className={cn("relative size-10 shrink-0 rounded-none text-muted-foreground [&_svg]:size-[18px]", toolsOpen && tab === tool.id && "after:absolute after:inset-x-2 after:bottom-0 after:h-0.5 after:bg-primary @min-[1024px]/review:after:inset-y-2 @min-[1024px]/review:after:left-auto @min-[1024px]/review:after:right-0 @min-[1024px]/review:after:h-auto @min-[1024px]/review:after:w-0.5")}>
              <Icon name={tool.icon} aria-hidden />
              {tool.count > 0 && <span aria-hidden className="absolute right-0.5 top-0.5 min-w-3.5 rounded-full bg-foreground px-0.5 text-center text-[10px] leading-[14px] text-background">{tool.count > 99 ? "99+" : tool.count}</span>}
            </Button>
          </Tooltip.Trigger>
          <Tooltip.Portal container={agent?.container ?? undefined}><Tooltip.Content {...scopeProps} side="left" sideOffset={8} collisionPadding={8} className="z-[75] rounded-md border border-border bg-popover px-2.5 py-1.5 text-xs text-popover-foreground shadow-md">{tool.label}{tool.count > 0 ? ` (${tool.count})` : ""}</Tooltip.Content></Tooltip.Portal>
        </Tooltip.Root>)}
      </Tooltip.Provider>
      <span className="ml-auto min-w-0 truncate px-2 text-xs text-muted-foreground @min-[1024px]/review:hidden">{toolsOpen ? toolItems.find((tool) => tool.id === tab)?.label : "Review tools"}</span>
      {toolsOpen && <Button variant="ghost" size="icon" className="size-8 shrink-0 text-muted-foreground @min-[1024px]/review:hidden" aria-label="Collapse review panel" onClick={collapse}><Icon name="X" aria-hidden /></Button>}
    </div>
    <div id={panelId} hidden={!toolsOpen} className={cn("flex min-h-0 min-w-0 flex-1 flex-col", !toolsOpen && "hidden")}>
      {tab !== "agent" && <div className="hidden h-11 shrink-0 items-center gap-2 border-b border-border px-3 @min-[1024px]/review:flex"><h2 className="min-w-0 flex-1 truncate text-xs font-medium">{tab === "draft" ? "Draft comments" : "Reviewer notes"}</h2><Button variant="ghost" size="icon" className="size-7 text-muted-foreground" aria-label="Collapse review panel" onClick={collapse}><Icon name="X" aria-hidden /></Button></div>}
    {agent && <AgentDock targetKey={targetKey} {...agent} active={toolsOpen && tab === "agent"} onDock={() => { setTab("agent"); setToolsOpen(true); }} onCollapse={collapse} />}
    <div hidden={tab !== "notes"} className={cn("min-h-0 overflow-y-auto", tab !== "notes" && "hidden")}><ReviewerNotes targetKey={targetKey} /></div>
    <div hidden={tab !== "draft"} className={cn("min-h-0 flex-1 overflow-y-auto", tab !== "draft" && "hidden")}>
      {loadError ? <div role="alert" className="space-y-3 p-3 text-sm"><p>Couldn’t load your draft. Editing is paused to protect it.</p><Button variant="outline" onClick={() => void load()}>Retry draft</Button></div> : !loaded ? <p role="status" className="p-3 text-sm text-muted-foreground">Loading draft…</p> : closed ?
        <section aria-label="Archived review" className="space-y-2 p-3">
          <p className="text-sm font-medium">{review?.prState === "MERGED" ? "Merged" : "Closed"} · Archived</p>
          <p className="text-xs text-muted-foreground">This review is saved in Archive. The guide, notes, and conversation remain available.</p>
          {(draft.comments.length > 0 || draft.body) && <details className="text-sm"><summary className="cursor-pointer">Unsubmitted draft</summary><p className="mt-2 whitespace-pre-wrap">{draft.body}</p>{draft.comments.map((comment, index) => <p key={index} className="mt-2 break-words">{comment.file}:{comment.line} — {comment.body}</p>)}</details>}
        </section> : completed ?
        <section aria-label="Submitted review" className="space-y-3 p-3">
          <p className="flex items-center gap-2 text-sm font-medium"><Icon name="Check" className="size-4" aria-hidden />{reviewState({ targetKey, ...review, submittedVerdict }).label}</p>
          <p className="text-xs text-muted-foreground">Review submitted to GitHub</p>
          <Button variant="outline" size="sm" onClick={() => setWriteAnother(true)}>Add another review</Button>
        </section> : <section aria-label="Review draft" className="flex flex-col">
          <div className="space-y-3 p-3">
            <div className="flex flex-wrap items-center justify-between gap-2"><span role="status" className="text-xs text-muted-foreground">{saved}</span><Button variant="ghost" size="sm" aria-expanded={showComposer && !inline} onClick={() => openComposer(null, false)}><Icon name="Plus" className="size-4" aria-hidden /> Add comment</Button></div>
            {saved.startsWith("Couldn’t") && <Button variant="outline" size="sm" onClick={() => void flush().catch(() => {})}>Save again</Button>}
            {draft.comments.length ? <ul className="divide-y divide-border text-sm">{draft.comments.map((comment) => <li key={`${comment.file}:${comment.line}:${comment.side}`} className="space-y-2 py-3 first:pt-0">
              <button type="button" className="block w-full break-words text-left text-xs text-muted-foreground hover:text-foreground hover:underline" onClick={() => onShowComment?.(comment)}>{comment.file}:{comment.line} · {comment.side === "LEFT" ? "Original" : "Changed"}{comment.author === "agent" ? " · Added by agent" : ""}{stale.some((at) => sameLocation(at, comment)) ? " · Older diff" : ""}{discussionLabel(discussions.find((d) => sameLocation(d, comment)))}</button>
              <p className="whitespace-pre-wrap break-words">{comment.body}</p>
              <div className="flex gap-1"><Button variant="ghost" size="sm" disabled={busy || !!body.trim()} aria-label={`Edit comment on ${comment.file}:${comment.line}`} onClick={() => openComposer(comment, false)}>Edit</Button><Button variant="ghost" size="sm" disabled={busy} aria-label={`Remove comment on ${comment.file}:${comment.line}`} onClick={() => void removeComment(comment)}>Remove</Button></div>
            </li>)}</ul> : !showComposer && <p className="py-4 text-sm leading-relaxed text-muted-foreground">Select a line in the diff or add a comment here.</p>}
            {showComposer && (inline ? <div className="flex flex-wrap items-center gap-2 border-t border-border pt-3 text-xs text-muted-foreground">
              <span className="min-w-0 flex-1 break-words">{asking ? `Writing to the agent about ${file}:${line} in the diff.` : `Writing a comment on ${file}:${line} in the diff.`}</span>
              <Button variant="ghost" size="sm" onClick={() => onShowComment?.({ file, line: Number(line), side })}>Show in diff</Button>
            </div> : <div className="space-y-3 border-t border-border pt-3">
              <label className="block space-y-1 text-xs text-muted-foreground">File<Input aria-label="Comment file" disabled={busy || !!editing} value={file} onChange={(event) => setFile(event.target.value)} /></label>
              <div className="grid grid-cols-[80px_minmax(0,1fr)] gap-3">
                <label className="space-y-1 text-xs text-muted-foreground">Line<Input aria-label="Comment line" disabled={busy || !!editing} type="number" min={1} value={line} onChange={(event) => setLine(event.target.value)} /></label>
                <label className="space-y-1 text-xs text-muted-foreground">Side<select aria-label="Comment side" disabled={busy || !!editing} className="h-9 w-full rounded-md border border-border bg-background px-2 text-sm text-foreground" value={side} onChange={(event) => setSide(event.target.value as "LEFT" | "RIGHT")}><option value="RIGHT">Changed lines</option><option value="LEFT">Original lines</option></select></label>
              </div>
              <Textarea ref={bodyRef} aria-label="Draft comment" disabled={busy} value={body} onChange={(event) => changeBody(event.target.value)} placeholder="What should the author know?" />
              <div className="flex flex-wrap gap-2"><Button disabled={busy || !file.trim() || !body.trim() || !Number.isInteger(Number(line)) || Number(line) < 1} onClick={() => void addComment()}>{editing ? "Save comment" : "Add to draft"}</Button><Button variant="ghost" disabled={busy} onClick={closeComposer}>Cancel</Button></div>
            </div>)}
          </div>
          <div className="space-y-3 border-t border-border p-3">
            <Button variant="ghost" size="sm" aria-expanded={showNotes} onClick={() => setShowNotes((value) => !value)}><Icon name={showNotes ? "ChevronDown" : "Plus"} className="size-4" aria-hidden /> Review summary</Button>
            {showNotes ? <label className="block space-y-2"><span className="text-xs text-muted-foreground">{isLocal ? "Saved with your local draft." : "Included with your GitHub review."}</span><Textarea aria-label="Review summary" disabled={busy} value={draft.body} onChange={(event) => updateSummary({ body: event.target.value })} onBlur={() => void flush().catch(() => {})} placeholder={isLocal ? "Summary of this review" : "What should the author know overall?"} /></label> : draft.body.trim() && <p className="line-clamp-3 whitespace-pre-wrap text-sm text-muted-foreground">{draft.body}</p>}
          </div>
          <div className="space-y-3 border-t border-border p-3">
            {!isLocal && <>
              <div role="group" aria-label="Review verdict" className="flex max-w-full flex-wrap items-center gap-1 rounded-md border border-border p-1">
                {([["APPROVE", "Approve"], ["COMMENT", "Comment"], ["REQUEST_CHANGES", "Request changes"]] as const).map(([verdict, label]) => <Button key={verdict} type="button" variant="ghost" size="sm" disabled={busy} aria-pressed={draft.verdict === verdict} onClick={() => { updateSummary({ verdict }); if (verdict === "REQUEST_CHANGES") setShowNotes(true); }}>{label}</Button>)}
              </div>
              <Button className="w-full" disabled={busy || !hasReview || !!body.trim()} onClick={() => void submit()}>{busy ? "Saving…" : "Submit to GitHub"}</Button>
            </>}
            <p className="text-xs leading-relaxed text-muted-foreground">{isLocal ? "Local review. Comments and notes stay in this BB installation." : body.trim() ? asking ? "Send or cancel your message to the agent before submitting." : "Add the comment you’re writing to the draft before submitting." : "Drafts stay in BB until you submit."}</p>
          </div>
        </section>}
    </div>
    </div>
  </aside>
  </InlineComposerContext.Provider></InlineDraftContext.Provider>;
});
DraftTray.displayName = "DraftTray";

/** How a comment's discussion with the agent reads in the panel. */
function discussionLabel(discussion: Discussion | undefined): string {
  if (!discussion) return "";
  const messages = discussion.entries.filter((entry) => entry.kind === "message").length;
  return `${messages ? ` · ${messages} message${messages === 1 ? "" : "s"}` : ""}${discussion.waiting ? " · Waiting for agent" : ""}`;
}
