import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { Store } from "./store";
import { completionNotifications } from "./completion-notifications";
import { defaultPreferences, guidePreferencesPrompt, spawnExecution, type ReviewPreferences } from "./preferences";
import { refreshAssistants, startAutomaticReview } from "./agent";
import { agentPlacement, machineUnavailable } from "./machines";
import { startVerification } from "./verification";
import { baselineOf } from "./feedback-view";
import type { Guide } from "./guide";

const preparedListeners = new WeakMap<BbPluginApi, (targetKey: string) => void>();
/** Told when a guide's automatic follow-up (the review or the feedback check) has started or can't. */
export function onPrepared(bb: BbPluginApi, listener: (targetKey: string) => void) { preparedListeners.set(bb, listener); }

const active = new WeakMap<BbPluginApi, Set<AbortController>>();
export function hasGuideGenerations(bb: BbPluginApi) { return (active.get(bb)?.size ?? 0) > 0; }
export function stopGuideGenerations(bb: BbPluginApi) {
  for (const controller of active.get(bb) ?? []) controller.abort();
}

/** Why a guide can't start now: the guide writer's machine is offline or removed. */
export function guideWriterUnavailable(bb: BbPluginApi, store: Store): Promise<string | null> {
  return machineUnavailable(bb, store.getPreferences().preferences.guideAgent, "guide writer");
}

export function buildGenerationPrompt(targetKey: string, generationId?: string, preferences: ReviewPreferences = defaultPreferences, earlier?: { guide: Guide | null; reviewed: boolean }): string {
  const chapters = earlier?.guide?.sections.map((s) => `- ${s.id}: ${s.title} (${s.diffs.map((d) => d.file).join(", ")})`) ?? [];
  return [
    "Author a Guided Review for this change.",
    "Follow the guided-review-generate skill exactly.",
    `The target key is: ${targetKey}`,
    ...(generationId ? [`Pass generationId "${generationId}" to generate_review_guide. It identifies this exact generation run.`] : []),
    "Start by calling read_review_patch, then submit with generate_review_guide.",
    ...(chapters.length ? ["A guide exists for an earlier revision of this change. Keep its chapter ids, titles, and order where the files still fit, so the reviewer's map of the change stays stable:", ...chapters] : []),
    ...(earlier?.reviewed ? ["The reviewer reviewed an earlier revision. Call read_changes_since_review, then summarize what changed since their review in the guide's sinceReview field, in 2–4 sentences."] : []),
    guidePreferencesPrompt(preferences),
  ].join("\n");
}

/** `notify: false` leaves the Needs You alert to the turn that started this re-review. */
export async function generateGuide(
  bb: BbPluginApi,
  store: Store,
  targetKey: string,
  projectId: string,
  options: { notify?: boolean } = {},
): Promise<void> {
  let generationId: string | undefined;
  let workerId: string | undefined;
  let threads: BbPluginApi["sdk"]["threads"] | undefined;
  const controller = new AbortController();
  const runs = active.get(bb) ?? new Set<AbortController>();
  active.set(bb, runs);
  runs.add(controller);
  try {
    const review = store.getReview(targetKey);
    const earlier = { guide: store.getGuide(targetKey), reviewed: !!(review && baselineOf(review).at) };
    generationId = store.beginGeneration(targetKey);
    threads = bb.sdk.threads;
    const preferences = store.getPreferences().preferences;
    const worker = await threads.spawn({
      ...(await agentPlacement(bb, preferences.guideAgent, projectId)),
      prompt: buildGenerationPrompt(targetKey, generationId, preferences, earlier),
      title: `Generate guide: ${targetKey}`,
      visibility: "hidden",
      ...spawnExecution(preferences.guideAgent),
    });
    workerId = worker.id;
    await threads.wait({ threadId: worker.id, status: "idle", timeoutMs: 600_000, signal: controller.signal });
  } catch (error) {
    // spawn/wait failed — fall through and finalize as error below. The log
    // carries the reason, such as a custom agent bb can no longer start.
    if (!controller.signal.aborted) bb.log.warn(`Guide generation for ${targetKey} failed: ${String(error)}`);
  } finally {
    if (workerId && threads) {
      try { await threads.archive({ threadId: workerId }); } catch { /* best effort */ }
      try { await threads.stop({ threadId: workerId }); } catch { /* best effort */ }
    }
  }
  try {
    if (!generationId || !store.isCurrentGeneration(targetKey, generationId)) return;
    const ok = !controller.signal.aborted && store.getGuide(targetKey) !== null;
    // A failed rebuild keeps the guide you had; a guide this run already submitted stands.
    if (ok) store.dropGuideBackup(targetKey);
    else store.restoreGuide(targetKey);
    store.setStatus(targetKey, ok ? "ready" : "error");
    // The review's assistant reads the new guide when its runtime restarts.
    if (ok) void refreshAssistants(bb, store, [targetKey]);
    bb.realtime.publish(`review:${targetKey}`, { status: ok ? "ready" : "error" });
    bb.realtime.publish("reviews", { ts: Date.now() });
    // A review you already reviewed gets its feedback checked; a new one, the automatic review.
    const review = store.getReview(targetKey);
    const checking = ok && !!review && !!baselineOf(review).at && await startVerification(bb, store, targetKey, "the guide was rebuilt for the PR's new commits");
    if (ok && !checking && !(review && baselineOf(review).at)) await startAutomaticReview(bb, store, targetKey).catch((error) => {
      bb.log.warn(`The automatic review of ${targetKey} didn't start: ${String(error)}`);
    });
    if (!checking) store.setLifecycle(targetKey, { preparedAt: Date.now() });
    preparedListeners.get(bb)?.(targetKey);
    if (!controller.signal.aborted && options.notify !== false) await completionNotifications(bb, store).queue({
      targetKey, generationId, projectId, status: ok ? "ready" : "error",
    });
  } catch {
    // A plugin reload can dispose storage/realtime while a worker is finishing.
    // The next factory marks interrupted runs as errors without reusing a guide.
  } finally {
    runs.delete(controller);
  }
}
