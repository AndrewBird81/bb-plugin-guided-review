// bb-plugin-guided-review — backend entry.
//
// Turns a GitHub PR (or local git ref) into an agent-authored chaptered
// walkthrough, rendered and reviewed in a bb panel, submitted back to GitHub.
// This factory is extended task-by-task (store, cli, tools, rpc, realtime).
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { rpcContract } from "./src/rpc-contract";
import { createStore } from "./src/store";
import { changedFiles, splitPatchByFile } from "./src/patch";
import { validateGuide, checkCoverage } from "./src/guide";
import { runReviewCommand } from "./src/review-command";
import { createPrReview } from "./src/start-review";
import { assistantInstructions, getConversation, isAssistantAnswering, newConversation, refreshAssistants, startConversation } from "./src/agent";
import { listMachines } from "./src/machines";
import { isMissingThread } from "./src/thread-errors";
import { computeFileViewState, hashForFile } from "./src/file-views";
import {
  ghPrViewArgs,
  ghPrCommentsArgs,
  ghPrChecksJsonArgs,
  ghReviewThreadsArgs,
  ghReplyThreadArgs,
  ghResolveThreadArgs,
  ghUnresolveThreadArgs,
  ghPrHeadArgs,
  runGh,
  runGit,
  ghErrorMessage,
} from "./src/gh";
import { createReviewSync } from "./src/review-lifecycle";
import { setTimeout as delay } from "node:timers/promises";
import { requireReviewRevision, reviewRevision } from "./src/review-revision";
import { createReviewSubmitter } from "./src/submit-review";
import { stopGuideGenerations, hasGuideGenerations } from "./src/generate";
import { parseChecks, parseReviewThreads } from "./src/threads";
import { rerunReview } from "./src/rereview";
import { getGhAccounts, switchGhAccount, checkRepoAccess } from "./src/gh-accounts";

import { completionNotifications } from "./src/completion-notifications";
import { createPluginUpdates } from "./src/plugin-updates";

export { rpcContract } from "./src/rpc-contract";

export default async function plugin(bb: BbPluginApi) {
  const store = createStore(bb);
  store.interruptGenerations();
  const submitReview = createReviewSubmitter(store, runGh);
  const sync = createReviewSync(bb, store, runGh);
  const notifications = completionNotifications(bb, store);
  const updates = createPluginUpdates(bb, () => hasGuideGenerations(bb));
  bb.background.service("plugin-updates", {
    async start(signal) {
      while (!signal.aborted) {
        await delay(60_000, undefined, { signal }).catch(() => {});
        if (!signal.aborted) await updates.run(() => notifications.flush(), false).catch(() => {});
        if (!signal.aborted) await updates.tick().catch(() => {});
      }
    },
  });
  bb.background.service("review-state", {
    async start(signal) {
      while (!signal.aborted) {
        await updates.run(() => sync.all(), false).catch(() => {});
        await delay(60_000, undefined, { signal }).catch(() => {});
      }
    },
  });
  bb.onDispose(() => { stopGuideGenerations(bb); });

  bb.log.info("guided-review loaded");

  const handlers: Omit<Parameters<typeof bb.rpc.register<typeof rpcContract>>[1], keyof typeof import("./src/plugin-updates").releaseRpc> = {
    async getSetupStatus() {
      const [cli, user, providers, projects] = await Promise.all([
        runGh(["--version"]), runGh(["api", "user", "--jq", ".login"]),
        bb.sdk.providers.list().catch(() => null), bb.sdk.projects.list({ includePersonal: true }).catch(() => null),
      ]);
      return { githubCli: cli.code === 0, account: user.code === 0 ? user.stdout.trim() || null : null, agentAvailable: providers ? providers.some(p => p.available) : null, projectAvailable: projects ? projects.length > 0 : null };
    },
    getReviewBundle({ targetKey }) {
      return { review: JSON.parse(JSON.stringify(store.getReview(targetKey))), guide: store.getGuide(targetKey),
        patch: store.readPatch(targetKey, 0, store.readPatch(targetKey, 0, 0).total).text, revision: reviewRevision(store, targetKey) };
    },
    getPreferences() { return store.getPreferences(); },
    savePreferences({ preferences, revision }) {
      const before = store.getPreferences().preferences.assistantInstructions;
      const result = store.savePreferences(preferences, revision);
      bb.realtime.publish("preferences", {});
      if (result.preferences.assistantInstructions !== before) void refreshAssistants(bb, store);
      return result;
    },
    async getAgentDefaults() {
      // Panel-started reviews run in the personal project (see startReview).
      try {
        const projects = await bb.sdk.projects.list({ includePersonal: true });
        const project = projects.find((p) => p.kind === "personal") ?? projects[0];
        const d = project ? await bb.sdk.projects.defaultExecutionOptions({ projectId: project.id }) : null;
        return { defaults: d && { providerId: d.providerId, model: d.model, reasoningLevel: d.reasoningLevel, permissionMode: d.permissionMode, serviceTier: d.serviceTier } };
      } catch {
        return { defaults: null };
      }
    },
    async listMachines() {
      return { machines: await listMachines(bb) };
    },
    getReviewerNotes({ targetKey }) { return store.getReviewerNotes(targetKey); },
    saveReviewerNotes({ targetKey, body, revision }) { return store.saveReviewerNotes(targetKey, body, revision); },
    ping() {
      return { ok: true };
    },

    // Panel: start a review by pasting a GitHub PR URL. The nav panel isn't
    // project-scoped, so the frontend can't reliably supply a projectId —
    // resolve one server-side (prefer the personal project, else the first).
    async startReview({ input }) {
      let projectId: string | undefined;
      try {
        const projects = await bb.sdk.projects.list({ includePersonal: true });
        const personal = projects.find((p) => p.kind === "personal");
        projectId = (personal ?? projects[0])?.id;
      } catch {
        return { ok: false, error: "Could not resolve a project to run generation." };
      }
      if (!projectId) return { ok: false, error: "No project available to run generation." };
      return createPrReview({ bb, store, gh: { runGh, runGit } }, { input, projectId });
    },

    // Task 10: read data plane
    listReviews() {
      // ReviewMeta rows carry optional fields as literal `undefined` own
      // properties (store.ts's rowToMeta), which the rpc layer's strict JSON
      // output check rejects; round-trip through JSON to drop them.
      return { reviews: JSON.parse(JSON.stringify(store.listReviews())) };
    },
    async refreshReviews() {
      await sync.all(true);
      return { reviews: JSON.parse(JSON.stringify(store.listReviews())) };
    },
    getReview({ targetKey }) {
      return { review: JSON.parse(JSON.stringify(store.getReview(targetKey))) };
    },
    getGuide({ targetKey }) {
      return { guide: store.getGuide(targetKey), status: store.getReview(targetKey)?.status ?? "error" };
    },
    getPatch({ targetKey }) {
      const total = store.readPatch(targetKey, 0, 0).total;
      return { patch: store.readPatch(targetKey, 0, total).text };
    },
    async getPr({ targetKey }) {
      const m = store.getReview(targetKey);
      if (!m || m.kind !== "pr" || !m.number) return { pr: null };
      const r = await runGh(ghPrViewArgs(m.number, m.repo));
      return { pr: r.code === 0 ? JSON.parse(r.stdout) : null };
    },
    async getThreads({ targetKey }) {
      const m = store.getReview(targetKey);
      if (!m || m.kind !== "pr" || !m.number || !m.repo) return { comments: [] };
      const r = await runGh(ghPrCommentsArgs(m.repo, m.number));
      return { comments: r.code === 0 ? JSON.parse(r.stdout) : [] };
    },
    async getChecks({ targetKey }) {
      const m = store.getReview(targetKey);
      if (!m || m.kind !== "pr" || !m.number) return { bucket: "none", checks: [] };
      const r = await runGh(ghPrChecksJsonArgs(m.number, m.repo));
      const parsed = parseChecks([0, 1, 8].includes(r.code) ? r.stdout : "");
      return { bucket: parsed.bucket, checks: parsed.checks };
    },

    // Phase 2: review threads, reply/resolve, staleness, re-review
    async getReviewThreads({ targetKey }) {
      const m = store.getReview(targetKey);
      if (!m || m.kind !== "pr" || !m.number || !m.repo) return { threads: [] };
      const [owner, repo] = m.repo.split("/");
      const r = await runGh(ghReviewThreadsArgs(owner, repo, m.number));
      return { threads: parseReviewThreads(r.code === 0 ? r.stdout : "").threads };
    },
    async replyToThread({ targetKey, inReplyTo, body }) {
      const m = store.getReview(targetKey);
      if (!m || m.kind !== "pr" || !m.number || !m.repo) return { ok: false, error: "Not a PR." };
      const r = await runGh(ghReplyThreadArgs(m.repo, m.number, inReplyTo), { stdin: JSON.stringify({ body }) });
      return r.code === 0 ? { ok: true } : { ok: false, error: ghErrorMessage(r) };
    },
    async resolveThread({ threadId }) {
      const r = await runGh(ghResolveThreadArgs(threadId));
      return r.code === 0 ? { ok: true } : { ok: false, error: ghErrorMessage(r) };
    },
    async unresolveThread({ threadId }) {
      const r = await runGh(ghUnresolveThreadArgs(threadId));
      return r.code === 0 ? { ok: true } : { ok: false, error: ghErrorMessage(r) };
    },
    async checkForUpdates({ targetKey }) {
      await sync.one(targetKey);
      const m = store.getReview(targetKey);
      if (!m || m.kind !== "pr" || !m.number || m.archivedAt) return { hasNewCommits: false };
      const r = await runGh(ghPrHeadArgs(m.number, m.repo));
      if (r.code !== 0) return { hasNewCommits: false };
      let head: any;
      try {
        head = JSON.parse(r.stdout);
      } catch {
        return { hasNewCommits: false };
      }
      if (typeof head?.headRefOid !== "string") return { hasNewCommits: false };
      return { hasNewCommits: !!m.headSha && head.headRefOid !== m.headSha, current: head.headRefOid, ...(m.headSha ? { stored: m.headSha } : {}) };
    },
    async rereview({ targetKey }) {
      await sync.one(targetKey, true);
      if (store.getReview(targetKey)?.archivedAt) return { ok: false, error: "This PR is archived. Its guide and conversation are still available." };
      return rerunReview({ bb, store, gh: { runGh, runGit } }, targetKey);
    },
    archiveReview({ targetKey, archived }) {
      if (!store.getReview(targetKey)) return { ok: false, error: "This review no longer exists." };
      store.setLifecycle(targetKey, { userArchivedAt: archived ? Date.now() : null });
      bb.realtime.publish(`review:${targetKey}`, { ts: Date.now() });
      bb.realtime.publish("reviews", { ts: Date.now() });
      return { ok: true };
    },
    async deleteReview({ targetKey }) {
      const review = store.getReview(targetKey);
      if (!review) return { ok: true };
      // A guide worker can't be cancelled per review, and an answer in progress is the reviewer's to finish.
      if (review.status === "generating") return { ok: false, error: "Wait for the guide to finish generating, then delete the review." };
      if (await isAssistantAnswering(bb, store, targetKey)) return { ok: false, error: "Wait for the assistant to finish answering, then delete the review." };
      const threadIds = [store.getAssistantThread(targetKey), store.getAgentThread(targetKey)];
      store.deleteReview(targetKey);
      bb.realtime.publish(`review:${targetKey}`, { ts: Date.now() });
      bb.realtime.publish("reviews", { ts: Date.now() });
      await notifications.forget(targetKey).catch(() => {});
      for (const threadId of threadIds) {
        if (!threadId) continue;
        await bb.sdk.threads.stop({ threadId }).catch(() => {});
        await bb.sdk.threads.delete({ threadId, childThreadsConfirmed: false }).catch((error) => {
          if (!isMissingThread(error)) bb.log.warn(`Could not delete review thread ${threadId}: ${String(error)}`);
        });
      }
      return { ok: true };
    },

    // Task 11: draft + submit
    getDraft({ targetKey }) {
      return { draft: store.getDraft(targetKey) };
    },
    saveDraftComment({ targetKey, comment, revision }) {
      requireReviewRevision(store, targetKey, revision);
      return { draft: store.upsertDraftComment(targetKey, comment) };
    },
    removeDraftComment({ targetKey, index }) {
      return { draft: store.removeDraftComment(targetKey, index) };
    },
    setVerdict({ targetKey, verdict, body, revision }) {
      requireReviewRevision(store, targetKey, revision);
      return { draft: store.setVerdict(targetKey, verdict, body) };
    },
    async submitReview({ targetKey, revision, account }) {
      if (!account) return { ok: false, error: "Verify your GitHub account before submitting. Reload this review to check access." };
      try { requireReviewRevision(store, targetKey, revision); } catch (error) { return { ok: false, error: (error as Error).message }; }
      const result = await submitReview(targetKey, revision, account);
      bb.realtime.publish(`review:${targetKey}`, { ts: Date.now() });
      bb.realtime.publish("reviews", { ts: Date.now() });
      return result;
    },

    // Feature 1: per-file "Viewed" state (viewed/stale computed against the patch)
    getFileViews({ targetKey }) {
      const total = store.readPatch(targetKey, 0, 0).total;
      const patch = store.readPatch(targetKey, 0, total).text;
      return { views: computeFileViewState(store.getFileViews(targetKey), patch) };
    },
    setFileViewed({ targetKey, file, viewed }) {
      if (!viewed) {
        store.unsetFileViewed(targetKey, file);
        return { ok: true };
      }
      const total = store.readPatch(targetKey, 0, 0).total;
      const hash = hashForFile(store.readPatch(targetKey, 0, total).text, file);
      if (!hash) return { ok: false };
      store.setFileViewed(targetKey, file, hash);
      return { ok: true };
    },

    // Review assistant: a hidden bb thread per review, shown with ThreadChat
    getConversation({ targetKey }) {
      return getConversation(bb, store, targetKey);
    },
    startConversation({ targetKey, text, agent }) {
      return startConversation(bb, store, { targetKey, text, agent });
    },
    async newConversation({ targetKey }) {
      await newConversation(bb, store, targetKey);
      return { ok: true };
    },
    // GitHub account indicator + switcher
    async getGhAccounts() {
      return getGhAccounts(runGh);
    },
    async switchGhAccount({ login }) {
      const r = await switchGhAccount(runGh, login);
      if (r.ok) bb.realtime.publish("gh-account", { active: r.active });
      return r;
    },
    async checkRepoAccess({ targetKey }) {
      const repo = store.getReview(targetKey)?.repo ?? null;
      return checkRepoAccess(runGh, repo);
    },
  };
  const guarded = Object.fromEntries(Object.entries(handlers).map(([name, handler]) =>
    [name, (input: unknown) => updates.run(() => (handler as (input: unknown) => unknown)(input))])) as unknown as typeof handlers;
  bb.rpc.register(rpcContract, {
    ...guarded,
    getReleaseStatus: () => updates.status(),
    checkPluginUpdates: () => updates.check(),
    setAutomaticUpdates: ({ enabled }) => updates.setAutomatic(enabled),
    setReviewPresence: ({ clientId, open }) => updates.presence(clientId, open),
    applyPluginUpdate: ({ clientId, candidateVersion }) => updates.apply(clientId, candidateVersion),
  });

  bb.agents.registerTool({
    name: "read_review_patch",
    description: "Return the diff text for a Guided Review target (paginated). Pass file to read one file's diff.",
    parameters: z.object({
      targetKey: z.string(),
      file: z.string().optional(),
      offset: z.number().int().min(0).optional(),
      limit: z.number().int().min(1).max(200_000).optional(),
    }),
    async execute({ targetKey, file, offset, limit }) {
      if (file !== undefined) {
        const diff = splitPatchByFile(store.readPatch(targetKey, 0, store.readPatch(targetKey, 0, 0).total).text).find((f) => f.path === file);
        if (!diff) return { content: [{ type: "text", text: `This review has no diff for ${file}.` }], isError: true };
        const text = diff.text.slice(offset ?? 0, (offset ?? 0) + (limit ?? 200_000));
        const end = (offset ?? 0) + text.length;
        return text + (end < diff.text.length ? `\n\n[${end}/${diff.text.length} bytes — call again with offset=${end}]` : "");
      }
      const { text, total } = store.readPatch(targetKey, offset, limit);
      const end = (offset ?? 0) + text.length;
      const more = end < total ? `\n\n[${end}/${total} bytes — call again with offset=${end}]` : "";
      return text + more;
    },
  });

  bb.agents.registerTool({
    name: "generate_review_guide",
    description: "Submit the authored guide. Validates shape and coverage.",
    parameters: z.object({ targetKey: z.string(), generationId: z.string(), guide: z.unknown() }),
    async execute({ targetKey, generationId, guide }) {
      if (!store.isCurrentGeneration(targetKey, generationId) || store.getReview(targetKey)?.status !== "generating") {
        return { content: [{ type: "text", text: "This generation was superseded or interrupted. Do not overwrite the current review." }], isError: true };
      }
      const v = validateGuide(guide);
      if (!v.ok) return { content: [{ type: "text", text: "Invalid guide:\n" + v.errors.join("\n") }], isError: true };
      const total = store.readPatch(targetKey, 0, 0).total;
      const files = changedFiles(store.readPatch(targetKey, 0, total).text);
      const cov = checkCoverage(v.guide, files);
      if (!cov.ok) return { content: [{ type: "text", text: "Coverage errors:\n" + cov.errors.join("\n") }], isError: true };
      // Stamp the store's authoritative gitRef/base over whatever the agent
      // submitted — the guide must never carry a wrong or stale review ref.
      const meta = store.getReview(targetKey);
      if (meta?.gitRef) v.guide.review = { gitRef: meta.gitRef, ...(meta.base ? { base: meta.base } : {}) };
      store.saveGuide(targetKey, v.guide);
      return "Guide accepted.";
    },
  });

  // Only expose these tools to THIS plugin's own spawned generation thread.
  // Both the generation thread and the review-agent thread are spawned by this
  // plugin (origin.pluginId matches for both), so the origin check alone is
  // not enough — gate on the generation thread's distinctive title too.
  bb.agents.configure((context) => {
    if (context.origin?.pluginId !== bb.pluginId) return { tools: [], skills: [] };
    const title = context.thread?.title ?? "";
    if (title.startsWith("Generate guide:")) {
      return { tools: ["read_review_patch", "generate_review_guide"], skills: ["guided-review-generate"] };
    }
    // The review assistant can read any file's diff on demand, so the chat
    // works across the whole review — but it never gets the guide-writing tool
    // or the generation skill. Its review context arrives as instructions.
    if (title.startsWith("Review agent:")) {
      const { targetKey } = context.pluginMetadata;
      const review = typeof targetKey === "string" ? store.getReview(targetKey) : null;
      return {
        tools: ["read_review_patch"], skills: [],
        ...(review ? { instructions: assistantInstructions(review.targetKey, store.getGuide(review.targetKey), store.getPreferences().preferences) } : {}),
      };
    }
    return { tools: [], skills: [] };
  });

  bb.cli.register({
    name: "review",
    summary: "Open a Guided Review of a GitHub PR or local git ref",
    commands: [{ name: "review", summary: "Review a PR or ref", usage: "bb review <pr-url | pr-number | git-ref> [--base <ref>]" }],
    async run(argv, ctx) {
      return updates.run(() => runReviewCommand({ bb, store, gh: { runGh, runGit } }, argv, ctx));
    },
  });
}
