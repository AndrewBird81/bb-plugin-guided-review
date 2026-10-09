import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import type { Store } from "./store";

const PREFIX = "needs-you:pending:";
const MAX_AGE = 24 * 60 * 60 * 1000;
interface Pending {
  generationId: string; targetKey: string; occurredAt: number;
  status: "ready" | "error"; projectId: string;
}
const managers = new WeakMap<BbPluginApi, ReturnType<typeof createNotifications>>();
export function completionNotifications(bb: BbPluginApi, store: Store) {
  let manager = managers.get(bb);
  if (!manager) { manager = createNotifications(bb, store); managers.set(bb, manager); }
  return manager;
}

function createNotifications(bb: BbPluginApi, store: Store) {
  let disposed = false;
  let flushing: Promise<void> | undefined;
  let dirty = false;
  let storageTail = Promise.resolve();
  function locked<T>(work: () => Promise<T>): Promise<T> {
    const next = storageTail.then(work);
    storageTail = next.then(() => {}, () => {});
    return next;
  }
  bb.onDispose(() => { disposed = true; });

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
        if (Date.now() - record.occurredAt > MAX_AGE || !store.isCurrentGeneration(record.targetKey, record.generationId)) await bb.storage.kv.delete(key);
        else liveKeys.push(key);
      }
    });
    if (!liveKeys.length || disposed) return;
    // Optional dependency. Older Needs You installs do not support durable activity.
    const capability = await bb.sdk.plugins.callRpc({ pluginId: "inbox", method: "activityCapabilities", input: null,
      outputSchema: z.object({ version: z.literal(1) }) }).catch(() => null);
    if (!capability || disposed) return;
    for (const key of liveKeys) {
      if (disposed) return;
      const record = await locked(async () => {
        const pending = await bb.storage.kv.get<Pending>(key);
        if (!pending || disposed) return null;
        if (Date.now() - pending.occurredAt > MAX_AGE || !store.isCurrentGeneration(pending.targetKey, pending.generationId) || store.getReview(pending.targetKey)?.status !== pending.status) {
          await bb.storage.kv.delete(key);
          return null;
        }
        return pending;
      });
      if (!record || disposed) continue;
      const meta = store.getReview(record.targetKey);
      // The async storage lock yields; a new generation may have started since
      // its read. Recheck immediately before dispatch, with no intervening await.
      if (!store.isCurrentGeneration(record.targetKey, record.generationId) || meta?.status !== record.status) continue;
      const title = (meta.title || store.getGuide(record.targetKey)?.title || "Review guide").slice(0, 240);
      const result = await bb.sdk.plugins.callRpc({ pluginId: "inbox", method: "publishActivity", input: {
        sourceId: "guided-review", sourceName: "Guided Review", entityId: record.targetKey,
        eventId: record.generationId, occurredAt: record.occurredAt, projectId: record.projectId,
        title, status: record.status,
        body: record.status === "ready" ? "Your guide is ready. Open it to start reviewing." : "The guide couldn’t be generated. Open the review to try again.",
        target: { panel: "review", segments: [record.targetKey] },
      }, outputSchema: z.object({ accepted: z.literal(true), id: z.string(), duplicate: z.boolean() }) }).catch(() => null);
      if (disposed) return;
      // A newer generation may have queued while this RPC was in flight.
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
  return {
    flush,
    /** Drop a deleted review's queued outcome and ordering clock. */
    forget(targetKey: string): Promise<void> {
      return locked(async () => {
        await bb.storage.kv.delete(`${PREFIX}${targetKey}`);
        await bb.storage.kv.delete(`needs-you:clock:${targetKey}`);
      });
    },
    async queue(record: Omit<Pending, "occurredAt">) {
      if (disposed || !store.isCurrentGeneration(record.targetKey, record.generationId)) return;
      await locked(async () => {
        const key = `${PREFIX}${record.targetKey}`;
        const clockKey = `needs-you:clock:${record.targetKey}`;
        const previous = await bb.storage.kv.get<number>(clockKey);
        if (disposed || !store.isCurrentGeneration(record.targetKey, record.generationId)) return;
        const occurredAt = Math.max(Date.now(), (previous ?? 0) + 1);
        await bb.storage.kv.set(clockKey, occurredAt);
        await bb.storage.kv.set(key, { ...record, occurredAt });
        dirty = true;
      });
      await flush();
    },
  };
}
