import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import type { Store, ReviewLifecycle } from "./store";
import { isMissingThread } from "./thread-errors";
import type { runGh } from "./gh";
import { verdictOf } from "./review-verdict";

const query = `query($owner:String!,$repo:String!,$number:Int!){
  viewer{login} repository(owner:$owner,name:$repo){pullRequest(number:$number){
    state headRefOid reviews(last:100){nodes{state submittedAt body author{login} commit{oid} comments(first:1){totalCount nodes{replyTo{id}}}}}
  }}
}`;
const resultSchema = z.object({ data: z.object({
  viewer: z.object({ login: z.string() }),
  repository: z.object({ pullRequest: z.object({
    state: z.enum(["OPEN", "CLOSED", "MERGED"]), headRefOid: z.string(),
    reviews: z.object({ nodes: z.array(z.object({
      state: z.string(), submittedAt: z.string().nullable(), body: z.string().nullish(), author: z.object({ login: z.string() }).nullable(), commit: z.object({ oid: z.string() }).nullable(),
      comments: z.object({ totalCount: z.number(), nodes: z.array(z.object({ replyTo: z.object({ id: z.string() }).nullable() })) }).nullish(),
    })) }),
  }) }),
}) });

/** Reconcile durable review state without making any GitHub writes. */
export function createReviewSync(bb: BbPluginApi, store: Store, run: typeof runGh) {
  const pending = new Map<string, Promise<void>>();
  const checked = new Map<string, number>();
  const hidden = new Set<string>();
  const archived = new Set<string>();
  let disposed = false;
  bb.onDispose(() => { disposed = true; });

  // Tidies a legacy review-agent worker. Assistant threads in bb stay
  // unarchived, because an archived thread cannot take messages.
  async function maintainThread(targetKey: string) {
    const threadId = store.getAgentThread(targetKey);
    if (!threadId || disposed) return;
    try {
      if (!hidden.has(threadId)) {
        await bb.sdk.threads.update({ threadId, visibility: "hidden" });
        hidden.add(threadId);
      }
      if (store.getReview(targetKey)?.archivedAt && !archived.has(threadId) && !disposed) {
        try { await bb.sdk.threads.stop({ threadId }); }
        finally { if (!disposed) await bb.sdk.threads.archive({ threadId }); }
        archived.add(threadId);
      }
    } catch (error) {
      if (disposed) return;
      if (isMissingThread(error)) {
        // Retain the transcript, and never detach a different replacement worker.
        if (store.getAgentThread(targetKey) === threadId) store.clearAgentThread(targetKey);
      } else bb.log.warn(`Could not tidy review thread ${threadId}: ${String(error)}`);
    }
  }

  function one(targetKey: string, force = false): Promise<void> {
    if (disposed) return Promise.resolve();
    if (pending.has(targetKey)) return pending.get(targetKey)!;
    const task = (async () => {
      await maintainThread(targetKey);
      const m = store.getReview(targetKey);
      if (!m || m.kind !== "pr" || !m.repo || !m.number || m.prState === "MERGED") return;
      if (!force && Date.now() - (checked.get(targetKey) ?? 0) < 60_000) return;
      checked.set(targetKey, Date.now());
      const startedAt = Date.now();
      const [owner, repo] = m.repo.split("/");
      try {
        const result = await run(["api", "graphql", "-f", `query=${query}`, "-f", `owner=${owner}`, "-f", `repo=${repo}`, "-F", `number=${m.number}`]);
        if (disposed || result.code !== 0) return;
        const parsed = resultSchema.safeParse(JSON.parse(result.stdout));
        if (!parsed.success) return;
        const { viewer, repository: { pullRequest: pr } } = parsed.data.data;
        const current = store.getReview(targetKey)!;
        if (current.prState === "MERGED" && pr.state !== "MERGED") return;
        const state: ReviewLifecycle = { prState: pr.state, latestHeadSha: pr.headRefOid,
          archivedAt: pr.state === "OPEN" ? null : current.archivedAt ?? Date.now() };
        // Replies to threads arrive as reviews of their own; they don't change your verdict.
        const own = verdictOf(pr.reviews.nodes.filter((r) => r.author?.login === viewer.login));
        if ((current.submittedAt ?? 0) < startedAt) {
          // GitHub can lag immediately after a write. Never replace a newer local receipt with an older response.
          const remoteAt = own?.at ?? 0;
          if (own && (remoteAt >= (current.submittedAt ?? 0) - 1000 || own.verdict === null) || current.reviewer && current.reviewer !== viewer.login) {
            Object.assign(state, { submittedVerdict: own?.verdict ?? null, submittedAt: remoteAt || null,
              submittedHeadSha: own?.sha ?? null, reviewer: viewer.login });
          }
        }
        store.setLifecycle(targetKey, state);
        await maintainThread(targetKey);
        if (!disposed && JSON.stringify(current) !== JSON.stringify(store.getReview(targetKey))) {
          bb.realtime.publish(`review:${targetKey}`, { ts: Date.now() });
          bb.realtime.publish("reviews", { ts: Date.now() });
        }
      } catch (error) { if (!disposed) bb.log.warn(`Could not refresh ${targetKey}: ${String(error)}`); }
    })().finally(() => pending.delete(targetKey));
    pending.set(targetKey, task);
    return task;
  }
  async function all(force = false) {
    const reviews = store.listReviews();
    // Bound GitHub concurrency, including on startup with a large archive.
    for (let i = 0; i < reviews.length && !disposed; i += 3) {
      await Promise.allSettled(reviews.slice(i, i + 3).map((review) => one(review.targetKey, force)));
    }
  }
  return { one, all };
}
