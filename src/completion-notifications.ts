import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import type { Store } from "./store";

const PREFIX = "needs-you:pending:";
const MAX_AGE = 24 * 60 * 60 * 1000;
interface Pending {
  /** A guide's outcome, or a review becoming your turn. Absent in records from earlier versions: a guide. */
  kind?: "generation" | "turn";
  /** The generation id, or the turn's signal. */
  generationId: string;
  targetKey: string; occurredAt: number;
  status: "ready" | "error"; projectId: string;
  /** A turn alert's text. */
  body?: string;
}
const managers = new WeakMap<BbPluginApi, ReturnType<typeof createNotifications>>();
export function completionNotifications(bb: BbPluginApi, store: Store) {
  let manager = managers.get(bb);
  if (!manager) { manager = createNotifications(bb, store); managers.set(bb, manager); }
  return manager;
}

/** The inbox item Needs You keeps for a review. */
const activityId = (targetKey: string) => `activity:guided-review:${encodeURIComponent(targetKey)}`;

function createNotifications(bb: BbPluginApi, store: Store) {
  let disposed = false;
  let flushing: Promise<void> | undefined;
  let dirty = false;
  let storageTail = Promise.resolve();
  // The signal that currently makes each review your turn; set by the sync.
  let turnSignal: (targetKey: string) => string | null = () => null;
  function locked<T>(work: () => Promise<T>): Promise<T> {
    const next = storageTail.then(work);
    storageTail = next.then(() => {}, () => {});
    return next;
  }
  bb.onDispose(() => { disposed = true; });

  /** Whether an outcome still describes the review: a newer generation or turn replaces it. */
  function current(record: Pending, checkStatus = true): boolean {
    if (Date.now() - record.occurredAt > MAX_AGE) return false;
    if (record.kind === "turn") return turnSignal(record.targetKey) === record.generationId;
    return store.isCurrentGeneration(record.targetKey, record.generationId) && (!checkStatus || store.getReview(record.targetKey)?.status === record.status);
  }

  async function capable(): Promise<boolean> {
    // Optional dependency. Older Needs You installs do not support durable activity.
    return !!await bb.sdk.plugins.callRpc({ pluginId: "inbox", method: "activityCapabilities", input: null,
      outputSchema: z.object({ version: z.literal(1) }) }).catch(() => null);
  }

  async function drain() {
    const keys = await bb.storage.kv.list(PREFIX);
    if (!keys.length || disposed) return;
    // Expire the outbox even when the optional recipient stays uninstalled.
    const liveKeys: string[] = [];
    await locked(async () => {
      for (const key of keys) {
        if (disposed) return;
        const record = await bb.storage.kv.get<Pending>(key);
        if (!record) continue;
        if (!current(record, false)) await bb.storage.kv.delete(key);
        else liveKeys.push(key);
      }
    });
    if (!liveKeys.length || disposed) return;
    if (!await capable() || disposed) return;
    for (const key of liveKeys) {
      if (disposed) return;
      const record = await locked(async () => {
        const pending = await bb.storage.kv.get<Pending>(key);
        if (!pending || disposed) return null;
        if (!current(pending)) {
          await bb.storage.kv.delete(key);
          return null;
        }
        return pending;
      });
      if (!record || disposed) continue;
      const meta = store.getReview(record.targetKey);
      // The async storage lock yields; a new generation may have started since
      // its read. Recheck immediately before dispatch, with no intervening await.
      if (!meta || !current(record)) continue;
      const title = (meta.title || store.getGuide(record.targetKey)?.title || "Review guide").slice(0, 240);
      const body = record.kind === "turn" ? (record.body ?? "It’s your turn to review.")
        : record.status === "ready" ? "Your guide is ready. Open it to start reviewing." : "The guide couldn’t be generated. Open the review to try again.";
      const result = await bb.sdk.plugins.callRpc({ pluginId: "inbox", method: "publishActivity", input: {
        sourceId: "guided-review", sourceName: "Guided Review", entityId: record.targetKey,
        eventId: (record.kind === "turn" ? `turn:${record.generationId}` : record.generationId).slice(0, 128),
        occurredAt: record.occurredAt, projectId: record.projectId,
        title, status: record.status, body: body.slice(0, 600),
        target: { panel: "review", segments: [record.targetKey] },
      }, outputSchema: z.object({ accepted: z.literal(true), id: z.string(), duplicate: z.boolean() }) }).catch(() => null);
      if (disposed) return;
      // A newer outcome may have queued while this RPC was in flight.
      if (result) await locked(async () => {
        if ((await bb.storage.kv.get<Pending>(key))?.generationId === record.generationId) await bb.storage.kv.delete(key);
      });
    }
  }
  function flush(): Promise<void> {
    if (disposed) return Promise.resolve();
    if (!flushing) flushing = (async () => {
      do { dirty = false; await drain(); } while (dirty && !disposed);
    })().catch(() => {}).finally(() => { flushing = undefined; });
    return flushing;
  }
  async function enqueue(record: Omit<Pending, "occurredAt">) {
    await locked(async () => {
      const key = `${PREFIX}${record.targetKey}`;
      const clockKey = `needs-you:clock:${record.targetKey}`;
      const previous = await bb.storage.kv.get<number>(clockKey);
      if (disposed || !current({ ...record, occurredAt: Date.now() }, false)) return;
      const occurredAt = Math.max(Date.now(), (previous ?? 0) + 1);
      await bb.storage.kv.set(clockKey, occurredAt);
      await bb.storage.kv.set(key, { ...record, occurredAt });
      dirty = true;
    });
    await flush();
  }
  return {
    flush,
    /** Tell the outbox which signal makes each review your turn now, so stale turn alerts drop. */
    useTurns(signal: (targetKey: string) => string | null) { turnSignal = signal; },
    /** Drop a deleted review's queued outcome and ordering clock. */
    forget(targetKey: string): Promise<void> {
      return locked(async () => {
        await bb.storage.kv.delete(`${PREFIX}${targetKey}`);
        await bb.storage.kv.delete(`needs-you:clock:${targetKey}`);
      });
    },
    async queue(record: Omit<Pending, "occurredAt" | "kind" | "body">) {
      if (disposed || !store.isCurrentGeneration(record.targetKey, record.generationId)) return;
      await enqueue({ ...record, kind: "generation" });
    },
    /** Alert that a review became your turn; `signal` identifies the event, so it alerts once. */
    async queueTurn(record: { targetKey: string; signal: string; projectId: string; body: string }) {
      if (disposed) return;
      await enqueue({ kind: "turn", generationId: record.signal, targetKey: record.targetKey, projectId: record.projectId, status: "ready", body: record.body });
    },
    /** You acted on the review: clear its inbox item and anything queued for it. */
    async dismiss(targetKey: string): Promise<void> {
      if (disposed) return;
      await locked(() => bb.storage.kv.delete(`${PREFIX}${targetKey}`));
      if (!await capable() || disposed) return;
      await bb.sdk.plugins.callRpc({ pluginId: "inbox", method: "dismissActivity", input: { id: activityId(targetKey), attentionAt: Date.now() },
        outputSchema: z.object({ ok: z.boolean() }) }).catch(() => null);
    },
  };
}
