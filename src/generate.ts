import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { Store } from "./store";
import { completionNotifications } from "./completion-notifications";
import { defaultPreferences, guidePreferencesPrompt, spawnExecution, type ReviewPreferences } from "./preferences";
import { refreshAssistants, startAutomaticReview } from "./agent";
import { agentPlacement, machineUnavailable } from "./machines";

const active = new WeakMap<BbPluginApi, Set<AbortController>>();
export function hasGuideGenerations(bb: BbPluginApi) { return (active.get(bb)?.size ?? 0) > 0; }
export function stopGuideGenerations(bb: BbPluginApi) {
  for (const controller of active.get(bb) ?? []) controller.abort();
}

/** Why a guide can't start now: the guide writer's machine is offline or removed. */
export function guideWriterUnavailable(bb: BbPluginApi, store: Store): Promise<string | null> {
  return machineUnavailable(bb, store.getPreferences().preferences.guideAgent, "guide writer");
}

export function buildGenerationPrompt(targetKey: string, generationId?: string, preferences: ReviewPreferences = defaultPreferences): string {
  return [
    "Author a Guided Review for this change.",
    "Follow the guided-review-generate skill exactly.",
    `The target key is: ${targetKey}`,
    ...(generationId ? [`Pass generationId "${generationId}" to generate_review_guide. It identifies this exact generation run.`] : []),
    "Start by calling read_review_patch, then submit with generate_review_guide.",
    guidePreferencesPrompt(preferences),
  ].join("\n");
}

export async function generateGuide(
  bb: BbPluginApi,
  store: Store,
  targetKey: string,
  projectId: string,
): Promise<void> {
  let generationId: string | undefined;
  let workerId: string | undefined;
  let threads: BbPluginApi["sdk"]["threads"] | undefined;
  const controller = new AbortController();
  const runs = active.get(bb) ?? new Set<AbortController>();
  active.set(bb, runs);
  runs.add(controller);
  try {
    generationId = store.beginGeneration(targetKey);
    threads = bb.sdk.threads;
    const preferences = store.getPreferences().preferences;
    const worker = await threads.spawn({
      ...(await agentPlacement(bb, preferences.guideAgent, projectId)),
      prompt: buildGenerationPrompt(targetKey, generationId, preferences),
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
    store.setStatus(targetKey, ok ? "ready" : "error");
    // The review's assistant reads the new guide when its runtime restarts.
    if (ok) void refreshAssistants(bb, store, [targetKey]);
    bb.realtime.publish(`review:${targetKey}`, { status: ok ? "ready" : "error" });
    bb.realtime.publish("reviews", { ts: Date.now() });
    if (ok) await startAutomaticReview(bb, store, targetKey).catch((error) => {
      bb.log.warn(`The automatic review of ${targetKey} didn't start: ${String(error)}`);
    });
    if (!controller.signal.aborted) await completionNotifications(bb, store).queue({
      targetKey, generationId, projectId, status: ok ? "ready" : "error",
    });
  } catch {
    // A plugin reload can dispose storage/realtime while a worker is finishing.
    // The next factory marks interrupted runs as errors without reusing a guide.
  } finally {
    runs.delete(controller);
  }
}
