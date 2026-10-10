import { useCallback, useEffect, useRef, useState } from "react";
import { useRpc } from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "../src/rpc-contract";
import { Textarea } from "./ui/textarea";
import { Button } from "./ui/button";
import { Icon } from "./ui/icon";
import { cn } from "../lib/utils";
import type { ReviewerNotesRecord } from "../src/preferences";

export function ReviewerNotes({ targetKey }: { targetKey: string }) {
  const rpc = useRpc<typeof rpcContract>();
  const backupKey = `gr:notes-draft:${targetKey}`;
  const [body, setBody] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [status, setStatus] = useState("Loading notes…");
  const [error, setError] = useState(false);
  const [saving, setSaving] = useState(false);
  const [comparison, setComparison] = useState<ReviewerNotesRecord | null>(null);
  const state = useRef({ body: "", revision: 0, dirty: false });
  const mounted = useRef(true);
  const pending = useRef<ReturnType<typeof setTimeout> | null>(null);
  const writes = useRef<Promise<unknown>>(Promise.resolve());
  const flush = useCallback(() => {
    if (pending.current) clearTimeout(pending.current);
    pending.current = null;
    const next = writes.current.catch(() => {}).then(async () => {
      if (!state.current.dirty) return;
      const { body, revision } = state.current;
      if (mounted.current) setSaving(true);
      try {
        const saved = await rpc.call("saveReviewerNotes", { targetKey, body, revision });
        state.current.revision = saved.revision;
        if (state.current.body === body) {
          state.current.dirty = false;
          try { if (JSON.parse(localStorage.getItem(backupKey) ?? "null")?.body === body) localStorage.removeItem(backupKey); } catch { /* best effort */ }
          if (mounted.current) { setStatus("Notes saved"); setError(false); }
        } else {
          try { if (JSON.parse(localStorage.getItem(backupKey) ?? "null")?.body === state.current.body) localStorage.setItem(backupKey, JSON.stringify({ body: state.current.body, revision: saved.revision })); } catch { /* best effort */ }
        }
      } catch (error) {
        if (mounted.current) { setError(true); setStatus(error instanceof Error ? error.message : "Couldn’t save notes. Your text is kept here."); }
        throw error;
      } finally {
        if (mounted.current) setSaving(false);
      }
    });
    writes.current = next;
    return next;
  }, [rpc, targetKey, backupKey]);
  const load = useCallback(async () => {
    try {
      const saved = await rpc.call("getReviewerNotes", { targetKey });
      if (!mounted.current) return;
      let backup: { body: string; revision: number } | null = null;
      try { backup = JSON.parse(localStorage.getItem(backupKey) ?? "null"); } catch { /* best effort */ }
      const recovered = backup && typeof backup.body === "string" && Number.isInteger(backup.revision) && backup.body !== saved.body;
      state.current = { body: recovered ? backup!.body : saved.body, revision: recovered ? backup!.revision : saved.revision, dirty: !!recovered };
      setBody(state.current.body); setLoaded(true); setError(false);
      if (!recovered) { try { localStorage.removeItem(backupKey); } catch { /* best effort */ } }
      setStatus(recovered ? "Recovered unsaved notes. Save when ready." : "Notes saved");
    } catch { if (mounted.current) { setError(true); setStatus("Couldn’t load notes. Try again."); } }
  }, [rpc, targetKey, backupKey]);
  useEffect(() => {
    mounted.current = true; void load();
    return () => { mounted.current = false; void flush().catch(() => {}); };
  }, [load, flush]);
  async function compareSaved() {
    try {
      const saved = await rpc.call("getReviewerNotes", { targetKey });
      if (mounted.current) setComparison(saved);
    } catch { if (mounted.current) { setStatus("Couldn’t load the saved version. Your edits are still here."); setError(true); } }
  }
  return <section aria-label="Private reviewer notes" className="space-y-3 p-3">
    <p className="flex items-start gap-2 rounded-lg border border-border bg-muted/25 px-3 py-2 text-xs leading-relaxed text-muted-foreground"><Icon name="Lock" className="mt-0.5 size-3.5 shrink-0 text-subtle-foreground" aria-hidden />Your scratchpad for questions, checks, and decisions. Saved in BB, never included in GitHub submissions or assistant prompts.</p>
    <Textarea aria-label="Private reviewer notes" rows={10} maxLength={100000} disabled={!loaded} value={body} placeholder="What do you want to verify before you finish?" className="rounded-lg bg-surface-raised font-mono text-[13px] leading-relaxed" onChange={(event) => {
      const value = event.target.value;
      setBody(value); state.current.body = value; state.current.dirty = true;
      try { localStorage.setItem(backupKey, JSON.stringify({ body: value, revision: state.current.revision })); } catch { /* best effort */ }
      setStatus("Saving notes…"); setError(false);
      if (pending.current) clearTimeout(pending.current);
      pending.current = setTimeout(() => { void flush().catch(() => {}); }, 500);
    }} onBlur={() => void flush().catch(() => {})} />
    <p role={error ? "alert" : "status"} className={cn("flex items-center gap-1.5 text-xs", error ? "text-destructive-text" : "text-muted-foreground")}><Icon name={error ? "AlertCircle" : saving || status.startsWith("Saving") ? "Loading" : status === "Notes saved" ? "CircleCheck" : "Info"} className={cn("size-3.5", !error && status === "Notes saved" && "text-diff-added", (saving || status.startsWith("Saving")) && "animate-spin motion-reduce:animate-none")} aria-hidden />{status}</p>
    {(error || state.current.dirty) && <div className="flex flex-wrap gap-2"><Button variant="outline" size="sm" disabled={!loaded || saving} onClick={() => void flush().catch(() => {})}>Save notes</Button>{error && <Button variant="ghost" size="sm" disabled={saving} onClick={() => loaded ? void compareSaved() : void load()}>{loaded ? "Compare saved notes" : "Retry notes"}</Button>}</div>}
    {comparison && <div className="space-y-3 border-t border-border pt-3">
      <p className="text-xs text-muted-foreground">Saved version below. Your edits are still in the editor above.</p>
      <Textarea aria-label="Saved reviewer notes" rows={5} value={comparison.body} readOnly />
      <div className="flex flex-wrap gap-2">
        <Button variant="outline" size="sm" disabled={saving} onClick={() => {
          state.current.revision = comparison.revision; state.current.dirty = true;
          try { localStorage.setItem(backupKey, JSON.stringify({ body: state.current.body, revision: comparison.revision })); } catch { /* best effort */ }
          setComparison(null); void flush().catch(() => {});
        }}>Save my version</Button>
        <Button variant="ghost" size="sm" disabled={saving} onClick={() => {
          if (pending.current) clearTimeout(pending.current);
          state.current = { ...comparison, dirty: false }; setBody(comparison.body);
          try { localStorage.removeItem(backupKey); } catch { /* best effort */ }
          setComparison(null); setError(false); setStatus("Notes saved");
        }}>Discard mine, use saved</Button>
      </div>
    </div>}
  </section>;
}
