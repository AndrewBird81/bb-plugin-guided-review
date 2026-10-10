import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ThreadChat, useComposers, useRealtime, useRpc, experimental_ProviderModelPicker as ProviderModelPicker } from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import type { rpcContract } from "../src/rpc-contract";
import type { AgentMessage, AgentMessageContext } from "../src/store";
import type { AgentChoice } from "../src/agent";
import { contextLabel, contextQuote } from "../src/assistant-context";
import { cn } from "../lib/utils";
import { usePortalScopeProps } from "../lib/portal-scope";
import { clampRect, defaultRect, type Rect } from "../lib/dock-geometry";
import { Icon } from "./ui/icon";
import { Button } from "./ui/button";
import { Textarea } from "./ui/textarea";

export interface DockInjection { context: AgentMessageContext; nonce: number; }
export interface AgentDockProps {
  targetKey: string;
  /** The review's patch, for quoting selected lines. */
  patch: string;
  injection?: DockInjection;
  /** Fullscreen root, so a popped-out widget remains in the visible subtree. */
  container?: HTMLElement | null;
  active?: boolean;
  onDock?: () => void;
  onCollapse?: () => void;
}
interface Persisted { mode: "panel" | "widget"; rect: Rect; }
interface Conversation {
  threadId: string | null; legacy: AgentMessage[]; defaults: AgentChoice | null;
  /** The machine chosen in Review settings, when it isn't the bb server. */
  machine?: { name: string; connected: boolean } | null;
}
// bb's picker resolves the first provider's default model from an empty seed.
const UNSET_AGENT: AgentChoice = { providerId: "", model: "", reasoningLevel: "medium" };
function bounds() { return { width: window.innerWidth, height: window.innerHeight }; }
function loadPersisted(targetKey: string): Persisted | null {
  try { return JSON.parse(localStorage.getItem(`gr:agentdock:${targetKey}`) ?? "null"); }
  catch { return null; }
}

// This controller stays mounted when changing tabs or presentation. A review's
// conversation is a hidden bb thread shown with ThreadChat; until it exists, a
// first-message composer chooses its agent.
export const AgentDock = memo(function AgentDock({ targetKey, patch, injection, container, active = true, onDock, onCollapse }: AgentDockProps) {
  const rpc = useRpc<typeof rpcContract>();
  const composers = useComposers();
  const scopeProps = usePortalScopeProps();
  const persisted = useMemo(() => loadPersisted(targetKey), [targetKey]);
  const [mode, setMode] = useState<"panel" | "widget">(persisted?.mode === "widget" ? "widget" : "panel");
  const [rect, setRect] = useState<Rect>(() => persisted?.rect && [persisted.rect.x, persisted.rect.y, persisted.rect.w, persisted.rect.h].every(Number.isFinite) ? clampRect(persisted.rect, bounds()) : defaultRect(bounds()));
  const [conversation, setConversation] = useState<Conversation | null>(null);
  const [agent, setAgent] = useState<AgentChoice>(UNSET_AGENT);
  const [input, setInput] = useState("");
  const [chip, setChip] = useState<AgentMessageContext | null>(null);
  const [busy, setBusy] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const [confirmingReset, setConfirmingReset] = useState(false);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const mounted = useRef(true);
  const locked = useRef(false);
  const gestureCleanup = useRef<(() => void) | null>(null);
  const readRevision = useRef(0);
  // An injection from before this mount was already handled.
  const handledInjection = useRef(injection?.nonce ?? null);
  const visible = active || mode === "widget";
  const threadId = conversation?.threadId ?? null;
  const hostId = conversation?.defaults?.hostId;

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; gestureCleanup.current?.(); };
  }, []);
  useEffect(() => {
    try { localStorage.setItem(`gr:agentdock:${targetKey}`, JSON.stringify({ mode, rect })); } catch { /* optional persistence */ }
  }, [targetKey, mode, rect]);
  useEffect(() => {
    const resize = () => setRect((previous) => clampRect(previous, bounds()));
    window.addEventListener("resize", resize);
    return () => window.removeEventListener("resize", resize);
  }, []);
  const load = useCallback(async () => {
    const revision = ++readRevision.current;
    try {
      const result = await rpc.call("getConversation", { targetKey });
      if (!mounted.current || revision !== readRevision.current) return;
      setConversation(result as Conversation);
      if (!result.threadId) setAgent(result.defaults ?? UNSET_AGENT);
      setLoadError(false);
    } catch { if (mounted.current && revision === readRevision.current) setLoadError(true); }
  }, [rpc, targetKey]);
  useEffect(() => { if (visible) void load(); }, [visible, load]);
  // Asking the agent from the diff can start the conversation.
  useRealtime(`conversation:${targetKey}`, load);
  useEffect(() => {
    if (!visible || threadId) return;
    const frame = requestAnimationFrame(() => composerRef.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, [visible, mode, threadId]);
  // Before the conversation exists, a selection becomes the first message's
  // context; afterwards it is quoted into bb's composer for the reviewer to edit.
  useEffect(() => {
    if (!injection || handledInjection.current === injection.nonce || !conversation) return;
    if (!threadId) {
      handledInjection.current = injection.nonce;
      setChip(injection.context);
      requestAnimationFrame(() => composerRef.current?.focus());
      return;
    }
    const composer = composers.find((candidate) => candidate.scope.kind === "thread" && candidate.scope.threadId === threadId);
    if (!composer) return; // ThreadChat's composer has not registered yet.
    handledInjection.current = injection.nonce;
    composer.insert(contextQuote(injection.context, patch), { at: "end", block: true });
    requestAnimationFrame(() => composer.focus());
  }, [injection, conversation, threadId, composers, patch]);

  async function start() {
    const message = input.trim();
    if (!message || locked.current || !conversation || !agent.providerId || !agent.model) return;
    locked.current = true; setBusy(true);
    try {
      const quote = chip ? contextQuote(chip, patch) : "";
      const result = await rpc.call("startConversation", { targetKey, text: quote ? `${message}\n\n${quote}` : message, agent });
      if (mounted.current) { setConversation({ ...conversation, threadId: result.threadId }); setInput(""); setChip(null); }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "The assistant could not start");
    } finally {
      locked.current = false;
      if (mounted.current) setBusy(false);
    }
  }
  async function reset() {
    setConfirmingReset(false);
    try { await rpc.call("newConversation", { targetKey }); }
    catch (error) { toast.error(error instanceof Error ? error.message : "Could not start a new conversation"); }
    await load();
  }
  function dock() { gestureCleanup.current?.(); setMode("panel"); onDock?.(); }
  function startGesture(event: React.PointerEvent, action: "move" | "resize") {
    event.preventDefault(); gestureCleanup.current?.();
    const start = { x: event.clientX, y: event.clientY, rect };
    const move = (event: PointerEvent) => {
      const dx = event.clientX - start.x, dy = event.clientY - start.y;
      setRect(clampRect(action === "move" ? { ...start.rect, x: start.rect.x + dx, y: start.rect.y + dy } : { ...start.rect, w: start.rect.w + dx, h: start.rect.h + dy }, bounds()));
    };
    const finish = () => {
      window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", finish); window.removeEventListener("pointercancel", finish);
      gestureCleanup.current = null;
    };
    gestureCleanup.current = finish;
    window.addEventListener("pointermove", move); window.addEventListener("pointerup", finish); window.addEventListener("pointercancel", finish);
  }

  const legacy = conversation?.legacy.length ? <div className="space-y-4 p-3">
    <p className="text-xs font-medium text-muted-foreground">Earlier conversation</p>
    {conversation.legacy.map((message) => <div key={message.id} className="space-y-1.5">
      <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground"><span className="font-medium">{message.role === "user" ? "You" : "Assistant"}</span>{message.role === "user" && message.context && <span className="break-all">{contextLabel(message.context)}</span>}</div>
      <p className={cn("whitespace-pre-wrap break-words text-sm leading-relaxed", message.role === "user" && "rounded-md bg-muted px-3 py-2")}>{message.text}</p>
    </div>)}
  </div> : undefined;
  const firstMessage = <>
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="space-y-2 p-3 text-sm leading-relaxed"><p>Ask about this change.</p><p className="text-muted-foreground">Discuss a file, check a risk, or select lines in the diff for a focused question. Your conversation stays with this review.</p></div>
      {legacy}
    </div>
    <div className="shrink-0 space-y-2 border-t border-border p-3">
      {chip && <div className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground"><span className="shrink-0">Context</span><span className="truncate text-foreground">{contextLabel(chip)}</span><Button variant="ghost" size="sm" className="h-6 px-1" aria-label="Clear selection context" onClick={() => setChip(null)}><Icon name="X" className="size-3" aria-hidden /></Button></div>}
      <Textarea ref={composerRef} aria-label="Ask the agent" disabled={busy} value={input} onChange={(event) => setInput(event.target.value)} onKeyDown={(event) => {
        if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void start(); }
      }} placeholder="Ask the agent…" className="max-h-32 min-h-20 resize-none text-sm" />
      <div className="flex min-w-0 items-center gap-2">
        <ProviderModelPicker value={agent} onChange={(next) => setAgent({ ...(hostId ? { hostId } : {}), ...next })} routing={hostId ? { kind: "host", hostId } : undefined} disabled={busy} className="min-w-0" />
        {conversation?.machine && <span className="min-w-0 truncate text-xs text-muted-foreground">{conversation.machine.connected ? `on ${conversation.machine.name}` : `${conversation.machine.name} is offline`}</span>}
        <Button size="sm" className="ml-auto" disabled={busy || !input.trim() || !agent.providerId || !agent.model} onClick={() => void start()} aria-label="Send"><Icon name="ArrowUp" className="size-4" aria-hidden /></Button>
      </div>
    </div>
  </>;
  const body = loadError
    ? <div role="alert" className="space-y-2 p-3 text-sm"><p>Couldn’t load the conversation.</p><Button variant="outline" size="sm" onClick={() => void load()}>Retry conversation</Button></div>
    : !conversation ? <p role="status" className="p-3 text-sm text-muted-foreground">Loading conversation…</p>
    : threadId ? <ThreadChat threadId={threadId} variant="compact" className="min-h-0 flex-1" leadingContent={legacy} />
    : firstMessage;

  const panel = <>
    <div className={cn("flex shrink-0 items-center gap-2 border-b border-border px-3 py-2", mode === "widget" && "cursor-move")} onPointerDown={mode === "widget" ? (event) => startGesture(event, "move") : undefined}>
      <Icon name="AiContentGenerator01" className="size-4 text-muted-foreground" aria-hidden />
      <span className="text-sm font-medium">Review assistant</span>
      {(threadId || conversation?.legacy.length) ? <Button variant="ghost" size="icon" className="ml-auto size-7" aria-label="New conversation" onPointerDown={(event) => event.stopPropagation()} onClick={() => setConfirmingReset(true)}><Icon name="MessageSquarePlus" className="size-3.5" aria-hidden /></Button> : null}
      <Button variant="ghost" size="sm" className={cn(!(threadId || conversation?.legacy.length) && "ml-auto")} aria-label={mode === "widget" ? "Dock in review panel" : "Open assistant as widget"} onPointerDown={(event) => event.stopPropagation()} onClick={mode === "widget" ? dock : () => setMode("widget")}>
        <Icon name={mode === "widget" ? "Minimize2" : "Maximize2"} className="size-3.5" aria-hidden />{mode === "widget" ? "Dock" : "Pop out"}
      </Button>
      {mode === "panel" && onCollapse && <Button variant="ghost" size="icon" className="hidden size-7 text-muted-foreground @min-[1024px]/review:inline-flex" aria-label="Collapse review panel" onClick={onCollapse}><Icon name="X" aria-hidden /></Button>}
    </div>
    {confirmingReset && <div role="alertdialog" aria-label="Start a new conversation" className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border px-3 py-2 text-xs">
      <span className="min-w-0 flex-1">Archive this conversation and start a new one?</span>
      <Button variant="outline" size="sm" onClick={() => void reset()}>Start new</Button>
      <Button variant="ghost" size="sm" onClick={() => setConfirmingReset(false)}>Cancel</Button>
    </div>}
    {body}
  </>;
  // Below z-50, where bb's own popovers (such as ThreadChat's model picker) open.
  const widget = mode === "widget" && createPortal(<div role="dialog" aria-label="Review agent" {...scopeProps} className="fixed z-[49] flex flex-col overflow-hidden rounded-lg border border-border shadow-2xl" style={{ left: rect.x, top: rect.y, width: rect.w, height: rect.h, backgroundColor: "rgb(from var(--background) r g b / 1)" }}>
    {panel}
    <div role="separator" tabIndex={0} aria-label="Resize assistant widget" aria-orientation="horizontal" onPointerDown={(event) => startGesture(event, "resize")} onKeyDown={(event) => {
      if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) return;
      event.preventDefault(); setRect((rect) => clampRect({ ...rect, w: rect.w + (event.key === "ArrowRight" ? 20 : event.key === "ArrowLeft" ? -20 : 0), h: rect.h + (event.key === "ArrowDown" ? 20 : event.key === "ArrowUp" ? -20 : 0) }, bounds()));
    }} className="absolute bottom-0 right-0 size-3 cursor-nwse-resize border-b-2 border-r-2 border-muted-foreground focus-visible:outline focus-visible:outline-ring" />
  </div>, container ?? document.body);
  return <>
    <section aria-label="Review assistant" hidden={!active} className={cn("flex min-h-0 flex-1 flex-col", !active && "hidden")}>
      {mode === "panel" ? panel : <><div className="hidden h-11 shrink-0 items-center border-b border-border px-3 @min-[1024px]/review:flex"><h2 className="flex-1 text-xs font-medium">Ask agent</h2>{onCollapse && <Button variant="ghost" size="icon" className="size-7 text-muted-foreground" aria-label="Collapse review panel" onClick={onCollapse}><Icon name="X" aria-hidden /></Button>}</div><div className="space-y-3 p-3 text-sm"><p className="text-muted-foreground">The assistant is open as a widget.</p><Button variant="outline" size="sm" onClick={dock}>Dock in review panel</Button></div></>}
    </section>
    {widget}
  </>;
});
AgentDock.displayName = "AgentDock";
