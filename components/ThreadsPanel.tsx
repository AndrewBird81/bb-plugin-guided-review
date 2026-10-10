import { memo, useEffect, useRef, useState } from "react";
import { Markdown, useRpc } from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import type { rpcContract } from "../src/rpc-contract";
import { Button } from "./ui/button";
import { Textarea } from "./ui/textarea";
import { withLineBreaks } from "../src/line-breaks";
import { Badge } from "./ui/badge";
import { Avatar } from "./ui/avatar";
import { Icon } from "./ui/icon";

export const ThreadsPanel = memo(function ThreadsPanel({ targetKey }: { targetKey: string }) {
  const rpc = useRpc<typeof rpcContract>();
  const [threads, setThreads] = useState<any[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [busyId, setBusyId] = useState<string | null>(null);
  const cancelledRef = useRef(false);

  async function load() {
    try {
      const { threads } = await rpc.call("getReviewThreads", { targetKey });
      if (cancelledRef.current) return;
      setThreads(threads);
      setLoadError(false);
    } catch (err) {
      if (cancelledRef.current) return;
      setLoadError(true);
      toast.error(err instanceof Error ? err.message : "Failed to load review threads");
    } finally {
      if (!cancelledRef.current) setLoaded(true);
    }
  }

  useEffect(() => {
    cancelledRef.current = false;
    void load();
    return () => {
      cancelledRef.current = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rpc, targetKey]);

  async function reply(thread: any) {
    const body = (drafts[thread.id] ?? "").trim();
    const inReplyTo = thread.comments?.[0]?.databaseId;
    if (!body || inReplyTo == null) return;
    setBusyId(thread.id);
    try {
      const res = await rpc.call("replyToThread", { targetKey, inReplyTo, body });
      if (res.ok) {
        setDrafts((d) => ({ ...d, [thread.id]: "" }));
        await load();
      } else {
        toast.error(res.error ?? "Reply failed");
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Something went wrong");
    } finally {
      setBusyId(null);
    }
  }

  async function toggleResolve(thread: any) {
    setBusyId(thread.id);
    try {
      const method = thread.isResolved ? "unresolveThread" : "resolveThread";
      const res = await rpc.call(method, { targetKey, threadId: thread.id });
      if (res.ok) {
        await load();
      } else {
        toast.error(res.error ?? "Failed to update thread");
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Something went wrong");
    } finally {
      setBusyId(null);
    }
  }

  if (loaded && loadError) {
    return (
      <div className="m-4 flex items-start gap-2 rounded-lg border border-destructive/20 bg-destructive/10 px-3 py-2 text-sm text-destructive-text">
        <Icon name="AlertCircle" className="mt-0.5 size-4 shrink-0" aria-hidden />
        <p>Couldn't load review threads.</p>
      </div>
    );
  }

  if (loaded && threads.length === 0) {
    return (
      <div className="flex flex-col items-center gap-3 p-8 text-center">
        <span aria-hidden className="flex size-10 items-center justify-center rounded-full bg-muted/60 text-muted-foreground ring-1 ring-inset ring-border">
          <Icon name="MessageSquare" className="size-5" />
        </span>
        <p className="text-sm text-muted-foreground">No review threads yet.</p>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {threads.map((t) => (
        <div key={t.id} className="rounded-xl border border-border bg-card p-3 shadow-xs">
          <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            <span className="min-w-0 break-all font-mono text-foreground">
              {t.path ?? "unknown file"}
              {t.line != null ? `:${t.line}` : ""}
            </span>
            {t.isResolved && <Badge tone="success">resolved</Badge>}
            {t.isOutdated && <Badge tone="warning">outdated</Badge>}
            <Button
              variant="outline"
              size="sm"
              className="ml-auto h-6 px-2 text-[10px]"
              disabled={busyId === t.id}
              onClick={() => toggleResolve(t)}
            >
              {t.isResolved ? "Unresolve" : "Resolve"}
            </Button>
          </div>
          <ul className="mt-3 space-y-3">
            {(t.comments ?? []).map((c: any) => (
              <li key={c.id} className="space-y-1 text-sm text-foreground">
                <div className="flex items-center gap-2">
                  <Avatar login={String(c.author ?? "")} size={20} />
                  <span className="font-medium">{c.author}</span>
                </div>
                <div className="pl-7">
                  <Markdown content={withLineBreaks(c.body)} className="text-sm leading-relaxed" />
                </div>
              </li>
            ))}
          </ul>
          <div className="mt-3 flex items-end gap-2 border-t border-border pt-3">
            <Textarea
              value={drafts[t.id] ?? ""}
              onChange={(e) => setDrafts((d) => ({ ...d, [t.id]: e.target.value }))}
              placeholder="Reply…"
              className="flex-1"
            />
            <Button
              size="sm"
              disabled={busyId === t.id || !(drafts[t.id] ?? "").trim()}
              onClick={() => reply(t)}
            >
              Reply
            </Button>
          </div>
        </div>
      ))}
    </div>
  );
});
ThreadsPanel.displayName = "ThreadsPanel";
