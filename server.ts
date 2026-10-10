// bb-plugin-guided-review — backend entry.
//
// Turns a GitHub PR (or local git ref) into an agent-authored chaptered
// walkthrough, rendered and reviewed in a bb panel, submitted back to GitHub.
// This factory is extended task-by-task (store, cli, tools, rpc, realtime).
import type { BbPluginApi, PluginAgentToolResult } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { rpcContract } from "./src/rpc-contract";
import { createStore } from "./src/store";
import { changedFiles, splitPatchByFile } from "./src/patch";
import { validateGuide, checkCoverage } from "./src/guide";
import { runReviewCommand } from "./src/review-command";
import { createPrReview } from "./src/start-review";
import { assistantInstructions, getConversation, isAssistantAnswering, newConversation, refreshAssistants, startConversation } from "./src/agent";
import { listMachines } from "./src/machines";
import { addComment, assistantReview, deleteComment, describeComments, editComment, replyInDiscussion, type DraftResult } from "./src/draft-comments";
import { askAgent, settleDiscussions } from "./src/discussions";
import { runCommentCommand } from "./src/comment-command";
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
import { onPrepared } from "./src/generate";
import { feedbackProgress } from "./lib/turn";
import { baselineOf, feedbackView, headOf, pruneDiffs, remainingBody, sinceReview } from "./src/feedback-view";
import { assess, changesSinceReview, describeFeedback, readFileAt, startVerification } from "./src/verification";
import { fetchMyThreads } from "./src/github/threads";
import type { ReviewMeta } from "./src/store";
import { threadSignals } from "./src/turn-signals";

export { rpcContract } from "./src/rpc-contract";


// Raise when the review assistant's tools change.
const ASSISTANT_TOOLS = 3;

export default async function plugin(bb: BbPluginApi) {
  const store = createStore(bb);
  store.interruptGenerations();
  const submitReview = createReviewSubmitter(store, runGh);
  const notifications = completionNotifications(bb, store);
  let personalProject: string | null = null;
  const reasons: Record<string, string> = {
    "re-requested": "the author re-requested the reviewer's review", handled: "every thread of the reviewer's feedback is resolved or answered",
    "looks-ready": "the last check found the feedback addressed", dismissed: "GitHub dismissed the reviewer's review",
  };
  const sync = createReviewSync(bb, store, runGh, { actions: {
    async prepare(targetKey, reason) {
      const review = store.getReview(targetKey);
      if (!review) return false;
      // An out-of-date guide is rebuilt first; its completion starts the check.
      if (review.status === "tracked" || review.headSha !== headOf(review)) return (await rerunReview({ bb, store, gh: { runGh, runGit } }, targetKey, { notify: false })).ok;
      return startVerification(bb, store, targetKey, reasons[reason] ?? "the review came back to the reviewer");
    },
    checkPushes: (targetKey) => startVerification(bb, store, targetKey, "the author pushed new commits and they have settled"),
    async autoStart(targetKey) {
      return (await rerunReview({ bb, store, gh: { runGh, runGit } }, targetKey, { notify: false })).ok;
    },
    async projectId() {
      if (personalProject) return personalProject;
      const projects = await bb.sdk.projects.list({ includePersonal: true }).catch(() => []);
      personalProject = (projects.find((p) => p.kind === "personal") ?? projects[0])?.id ?? null;
      return personalProject;
    },
  } });
  onPrepared(bb, (targetKey) => { void sync.evaluate(targetKey); });
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

  // Reviews leave the server with whose turn they are and how far your feedback got.
  // JSON round-trips drop the literal `undefined` fields rowToMeta leaves, which strict rpc output rejects.
  const decorate = (review: ReviewMeta | null) => review && JSON.parse(JSON.stringify({ ...review, turn: sync.turnOf(review), progress: feedbackProgress(review) }));
  const changed = (targetKey: string) => {
    bb.realtime.publish(`review:${targetKey}`, { ts: Date.now() });
    bb.realtime.publish("reviews", { ts: Date.now() });
  };
  /** Re-read your threads on a PR now. */
  async function refreshThreads(review: ReviewMeta) {
    if (review.kind !== "pr" || !review.repo || !review.number || !baselineOf(review).at) return;
    const login = (await runGh(["api", "user", "--jq", ".login"])).stdout.trim();
    if (!login) return;
    store.saveFeedbackThreads(review.targetKey, await fetchMyThreads(runGh, review.repo, review.number, login), store.feedbackFetched(review.targetKey)?.prUpdatedAt ?? null);
    store.setLifecycle(review.targetKey, { signals: { ...store.getReview(review.targetKey)!.signals, ...threadSignals(store.listFeedbackThreads(review.targetKey)) } });
    bb.realtime.publish(`feedback:${review.targetKey}`, { ts: Date.now() });
  }
  const view = (targetKey: string) => {
    const review = store.getReview(targetKey);
    return review ? feedbackView(store, review) : null;
  };

  function turnHandlers() {
    return {
      async snoozeReview({ targetKey, snoozed }: { targetKey: string; snoozed: boolean }) {
        if (!store.getReview(targetKey)) return { ok: false, error: "This review no longer exists." };
        store.setLifecycle(targetKey, { snoozedAt: snoozed ? Date.now() : null });
        if (snoozed) await notifications.dismiss(targetKey);
        await sync.evaluate(targetKey);
        changed(targetKey);
        return { ok: true };
      },
      async markSeen({ targetKey }: { targetKey: string }) {
        await notifications.dismiss(targetKey);
        return { ok: true };
      },
      async startTrackedReview({ targetKey }: { targetKey: string }) {
        const review = store.getReview(targetKey);
        if (!review) return { ok: false, error: "This review no longer exists." };
        if (review.status === "generating") return { ok: true };
        const result = await rerunReview({ bb, store, gh: { runGh, runGit } }, targetKey);
        changed(targetKey);
        return result;
      },
      getFeedback({ targetKey }: { targetKey: string }) {
        return { feedback: view(targetKey) };
      },
      async refreshFeedback({ targetKey }: { targetKey: string }) {
        const review = store.getReview(targetKey);
        if (review) await refreshThreads(review).catch((error) => bb.log.warn(`Could not read your threads on ${targetKey}: ${String(error)}`));
        await sync.evaluate(targetKey);
        return { feedback: view(targetKey) };
      },
      async checkFeedback({ targetKey }: { targetKey: string }) {
        const review = store.getReview(targetKey);
        if (!review) return { ok: false, error: "This review no longer exists." };
        if (!baselineOf(review).at) return { ok: false, error: "Submit a review first; then the assistant can check your feedback." };
        if (!store.getPreferences().preferences.verificationPrompt.trim()) return { ok: false, error: "The re-review check is off. Turn it on in Review settings." };
        if (await isAssistantAnswering(bb, store, targetKey)) return { ok: false, error: "The assistant is still answering. Try again when it finishes." };
        await refreshThreads(review).catch(() => {});
        return await startVerification(bb, store, targetKey, "the reviewer asked for a check") ? { ok: true } : { ok: false, error: "The assistant couldn't start. Open Ask agent to choose its agent." };
      },
      async replyToFeedback({ targetKey, threadId, body }: { targetKey: string; threadId: string; body: string }) {
        const review = store.getReview(targetKey);
        const thread = store.listFeedbackThreads(targetKey).find((t) => t.id === threadId);
        if (!review?.repo || !review.number || !thread) return { ok: false, error: "That thread isn't part of this review anymore. Refresh and try again." };
        const r = await runGh(ghReplyThreadArgs(review.repo, review.number, thread.commentId), { stdin: JSON.stringify({ body }), timeoutMs: 0 });
        if (r.code !== 0) return { ok: false, error: ghErrorMessage(r) };
        store.deleteReplyDraft(targetKey, threadId);
        await refreshThreads(review).catch(() => {});
        return { ok: true, feedback: view(targetKey) };
      },
      saveReplyDraft({ targetKey, threadId, body }: { targetKey: string; threadId: string; body: string }) {
        if (body.trim()) store.setReplyDraft(targetKey, threadId, body, "reviewer");
        else store.deleteReplyDraft(targetKey, threadId);
        return { ok: true };
      },
      discardReplyDraft({ targetKey, threadId }: { targetKey: string; threadId: string }) {
        store.deleteReplyDraft(targetKey, threadId);
        bb.realtime.publish(`feedback:${targetKey}`, { ts: Date.now() });
        return { ok: true };
      },
      useSuggestedVerdict({ targetKey, revision, mode }: { targetKey: string; revision?: string; mode: "suggested" | "remaining" }) {
        try { requireReviewRevision(store, targetKey, revision); } catch (error) { return { ok: false, error: (error as Error).message }; }
        const feedback = view(targetKey);
        if (!feedback) return { ok: false, error: "This review no longer exists." };
        let verdict: "APPROVE" | "REQUEST_CHANGES" | "COMMENT";
        let body: string;
        if (mode === "suggested") {
          if (!feedback.run) return { ok: false, error: "The assistant hasn't suggested a verdict yet." };
          verdict = feedback.run.suggestedVerdict ?? "COMMENT";
          body = feedback.run.suggestedBody;
        } else {
          body = remainingBody(feedback);
          if (!body) return { ok: false, error: "Nothing is left open. Consider approving." };
          verdict = "REQUEST_CHANGES";
        }
        const draft = store.setVerdict(targetKey, verdict, body);
        bb.realtime.publish(`draft-summary:${targetKey}`, { ts: Date.now() });
        return { ok: true, draft };
      },
      async getSinceReview({ targetKey }: { targetKey: string }) {
        const review = store.getReview(targetKey);
        if (!review) return { baseline: null, files: [] };
        try {
          const since = await sinceReview(store, runGh, review);
          return since ? { baseline: since.baseline, files: since.files } : { baseline: null, files: [] };
        } catch (error) {
          return { baseline: null, files: [], error: error instanceof Error ? error.message : "Couldn't compare with your last review." };
        }
      },
    };
  }

  // The draft, its comments drafted against an older diff (which submitting refuses), and the discussions at its lines.
  const draftState = (targetKey: string, draft = store.getDraft(targetKey)) => ({
    draft,
    stale: store.staleDraftComments(targetKey).map(({ file, line, side }) => ({ file, line, side })),
    discussions: store.listDiscussions(targetKey),
  });

  const handlers: Omit<Parameters<typeof bb.rpc.register<typeof rpcContract>>[1], keyof typeof import("./src/plugin-updates").releaseRpc> = {
    async getSetupStatus() {
      const [cli, user, providers, projects] = await Promise.all([
        runGh(["--version"]), runGh(["api", "user", "--jq", ".login"]),
        bb.sdk.providers.list().catch(() => null), bb.sdk.projects.list({ includePersonal: true }).catch(() => null),
      ]);
      return { githubCli: cli.code === 0, account: user.code === 0 ? user.stdout.trim() || null : null, agentAvailable: providers ? providers.some(p => p.available) : null, projectAvailable: projects ? projects.length > 0 : null };
    },
    getReviewBundle({ targetKey }) {
      return { review: decorate(store.getReview(targetKey)), guide: store.getGuide(targetKey),
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
      return { reviews: store.listReviews().map(decorate) };
    },
    async refreshReviews() {
      await sync.all(true);
      return { reviews: store.listReviews().map(decorate) };
    },
    getReview({ targetKey }) {
      return { review: decorate(store.getReview(targetKey)) };
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
      const r = await runGh(ghReplyThreadArgs(m.repo, m.number, inReplyTo), { stdin: JSON.stringify({ body }), timeoutMs: 0 });
      return r.code === 0 ? { ok: true } : { ok: false, error: ghErrorMessage(r) };
    },
    async resolveThread({ threadId }) {
      const r = await runGh(ghResolveThreadArgs(threadId), { timeoutMs: 0 });
      return r.code === 0 ? { ok: true } : { ok: false, error: ghErrorMessage(r) };
    },
    async unresolveThread({ threadId }) {
      const r = await runGh(ghUnresolveThreadArgs(threadId), { timeoutMs: 0 });
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
      // Reading the PR may have started an automatic rebuild already.
      if (store.getReview(targetKey)?.status === "generating") return { ok: true };
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
      // Discovery won't add a PR you deleted back to the list; starting it again does.
      if (review.kind === "pr") store.ignoreDiscovery(targetKey);
      await notifications.dismiss(targetKey).catch(() => {});
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
      return draftState(targetKey);
    },
    saveDraftComment({ targetKey, comment, revision }) {
      requireReviewRevision(store, targetKey, revision);
      return draftState(targetKey, store.upsertDraftComment(targetKey, comment));
    },
    removeDraftComment({ targetKey, file, line, side }) {
      // Already gone, for example deleted by an agent: the current draft shows that.
      const draft = store.deleteDraftComment(targetKey, { file, line, side }) ?? store.getDraft(targetKey);
      store.deleteDiscussion(targetKey, { file, line, side });
      return draftState(targetKey, draft);
    },
    async askAgent({ targetKey, ...input }) {
      const { started } = await askAgent(bb, store, targetKey, input);
      if (started) bb.realtime.publish(`conversation:${targetKey}`, {});
      return draftState(targetKey);
    },
    dismissDiscussion({ targetKey, file, line, side }) {
      store.deleteDiscussion(targetKey, { file, line, side });
      return draftState(targetKey);
    },
    setVerdict({ targetKey, verdict, body, revision }) {
      requireReviewRevision(store, targetKey, revision);
      return { draft: store.setVerdict(targetKey, verdict, body) };
    },
    async submitReview({ targetKey, revision, account, comments }) {
      if (!account) return { ok: false, error: "Verify your GitHub account before submitting. Reload this review to check access." };
      try { requireReviewRevision(store, targetKey, revision); } catch (error) { return { ok: false, error: (error as Error).message }; }
      const result = await submitReview(targetKey, revision, account, comments);
      // The discussions were about this draft. The assistant's conversation keeps them.
      if (result.ok) {
        store.clearDiscussions(targetKey);
        const review = store.getReview(targetKey)!;
        // The diff you reviewed is what "since your review" compares against.
        if (review.headSha) store.saveSnapshot(targetKey, review.headSha, store.readPatch(targetKey, 0, store.readPatch(targetKey, 0, 0).total).text);
        pruneDiffs(store, review);
        // Your review answers whatever turn was holding.
        store.setLifecycle(targetKey, { heldTurn: null });
        await notifications.dismiss(targetKey).catch(() => {});
        await sync.evaluate(targetKey);
      }
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
      // The archived conversation won't answer discussions waiting for it.
      if (store.stopWaiting(targetKey)) bb.realtime.publish(`draft:${targetKey}`, {});
      return { ok: true };
    },
    // GitHub account indicator + switcher
    async getGhAccounts() {
      return getGhAccounts(runGh);
    },
    async switchGhAccount({ login }) {
      const r = await switchGhAccount(runGh, login);
      if (r.ok) {
        sync.resetViewer();
        bb.realtime.publish("gh-account", { active: r.active });
      }
      return r;
    },
    async checkRepoAccess({ targetKey }) {
      const repo = store.getReview(targetKey)?.repo ?? null;
      return checkRepoAccess(runGh, repo);
    },
    ...turnHandlers(),
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

  // The review assistant's draft tools act only on its own review's local draft.
  function assistantDraft(threadId: string, changes: boolean, act: (targetKey: string) => DraftResult): PluginAgentToolResult {
    const targetKey = assistantReview(store, threadId);
    const result: DraftResult = targetKey ? act(targetKey) : { ok: false, error: "This conversation is no longer a review's assistant, so it has no draft." };
    if (!result.ok) return { content: [{ type: "text", text: result.error }], isError: true };
    if (changes) bb.realtime.publish(`draft:${targetKey}`, {});
    return result.text;
  }
  const location = {
    file: z.string().describe("Repo-relative path, exactly as the diff shows it."),
    line: z.number().int().min(1).describe("The line's number in the new file (side RIGHT) or the old file (side LEFT)."),
    side: z.enum(["RIGHT", "LEFT"]).optional().describe("RIGHT, the default, for an added or unchanged line; LEFT for a removed line."),
  };
  const body = z.string().trim().min(1).describe("The comment, in GitHub Markdown.");
  bb.agents.registerTool({
    name: "list_draft_comments",
    description: "List the comments in the reviewer's local draft for this review: each one's location, who added it (an agent or the reviewer), and text.",
    parameters: z.object({}),
    execute: (_input, { threadId }) => assistantDraft(threadId, false, (targetKey) => ({ ok: true, text: describeComments(store, targetKey) })),
  });
  bb.agents.registerTool({
    name: "add_draft_comment",
    description: "Add an inline comment to the reviewer's local draft for this review, on one line of the current diff. Nothing reaches GitHub: the reviewer edits, removes, or submits it. Refuses a line that already has a draft comment.",
    instructions: "Whenever a comment is warranted, such as a bug, a risk, a missing case, or a question about specific lines, add it with add_draft_comment on the line it concerns. Prefer this to a general remark, because an inline comment keeps the issue's location. Put one issue in each comment. Points about the change as a whole go in your reply. list_draft_comments shows the draft and who added each comment; edit_draft_comment and delete_draft_comment change it. Change or delete the reviewer's own comments only when they ask. The draft is the reviewer's: they edit, remove, and submit it. Never post to GitHub yourself, for example with gh pr review, gh pr comment, gh api writes, or git push.",
    parameters: z.object({
      ...location,
      code: z.string().describe("The line's text, without the diff's leading +, -, or space. It must match the line."),
      body,
    }),
    execute: (input, { threadId }) => assistantDraft(threadId, true, (targetKey) => addComment(store, targetKey, input)),
  });
  bb.agents.registerTool({
    name: "edit_draft_comment",
    description: "Replace the text of the draft comment at a file, line, and side in the reviewer's local draft. Its location stays; to move a comment, delete it and add it again. Nothing reaches GitHub.",
    parameters: z.object({ ...location, body }),
    execute: (input, { threadId }) => assistantDraft(threadId, true, (targetKey) => editComment(store, targetKey, input)),
  });
  bb.agents.registerTool({
    name: "delete_draft_comment",
    description: "Delete the draft comment at a file, line, and side from the reviewer's local draft. Nothing reaches GitHub.",
    parameters: z.object(location),
    execute: (input, { threadId }) => assistantDraft(threadId, true, (targetKey) => deleteComment(store, targetKey, input)),
  });
  bb.agents.registerTool({
    name: "reply_in_discussion",
    description: "Reply in the reviewer's discussion at a line of the diff, shown under the line's draft comment, or in its place when there's none. Only the reviewer sees it; nothing reaches GitHub. The reviewer starts discussions, so there must be one at that file, line, and side.",
    instructions: "Messages from a discussion in the diff say which line they're about. When a reply is warranted, answer with reply_in_discussion on that line, where the reviewer reads it, and keep your chat reply to one short line. When they ask for a change to the draft comment there, make it with add_draft_comment, edit_draft_comment, or delete_draft_comment instead of describing it.",
    parameters: z.object({ ...location, body: z.string().trim().min(1).describe("The reply, in Markdown.") }),
    execute: (input, { threadId }) => assistantDraft(threadId, true, (targetKey) => replyInDiscussion(store, targetKey, input)),
  });
  // Checking your feedback: the review assistant reads it and what changed, then records a verdict per item.
  async function assistantReviewOf(threadId: string): Promise<ReviewMeta | string> {
    const targetKey = assistantReview(store, threadId);
    const review = targetKey ? store.getReview(targetKey) : null;
    if (!review) return "This conversation is no longer a review's assistant.";
    if (review.kind !== "pr") return "This is a local review; there's no GitHub feedback to check.";
    return review;
  }
  const failed = (text: string): PluginAgentToolResult => ({ content: [{ type: "text", text }], isError: true });
  bb.agents.registerTool({
    name: "list_feedback",
    description: "List the reviewer's feedback on this PR: each review thread they started (id, location, their comment, replies, resolved/outdated state, any earlier verdict) and their review summaries.",
    instructions: "When a review comes back to the reviewer, check whether each piece of their feedback was properly addressed: list_feedback, then read_changes_since_review, then read_file where you need context. Judge the fix itself, not just whether the lines changed: a renamed variable doesn't fix a race. Record every thread, and each distinct ask in the summaries as \"summary:<n>\" with a title, with assess_feedback: addressed, partial, not_addressed, disputed (the author argues against it; say why in the evidence), or unclear. Then suggest a verdict with a short summary the reviewer could submit. Draft a reply on each thread with draft_thread_reply when one helps, such as \"Fixed in abc123, thanks.\" or what's still missing. The reviewer posts replies and resolves threads; you never do.",
    parameters: z.object({}),
    async execute(_input, { threadId }) {
      const review = await assistantReviewOf(threadId);
      if (typeof review === "string") return failed(review);
      await refreshThreads(review).catch(() => {});
      return describeFeedback(store, store.getReview(review.targetKey)!);
    },
  });
  bb.agents.registerTool({
    name: "read_changes_since_review",
    description: "What changed in this PR since the reviewer's last review: the PR's diff then compared with its diff now, file by file (rebases and base-branch merges don't show), plus the commits since. Pass file for one file.",
    parameters: z.object({ file: z.string().optional().describe("Repo-relative path, as the diff shows it.") }),
    async execute({ file }, { threadId }) {
      const targetKey = assistantReview(store, threadId) ?? (await generationReview(threadId));
      const review = targetKey ? store.getReview(targetKey) : null;
      if (!review || review.kind !== "pr") return failed("There's no PR review to compare.");
      try { return await changesSinceReview(store, runGh, review, file); }
      catch (error) { return failed(error instanceof Error ? error.message : "Couldn't compare with the reviewer's last review."); }
    },
  });
  bb.agents.registerTool({
    name: "read_file",
    description: "Read a file of this PR at the PR's head (ref \"current\") or at the commit the reviewer last reviewed (ref \"reviewed\"), with line numbers. Returns up to 400 lines from startLine.",
    parameters: z.object({
      path: z.string().min(1).describe("Repo-relative path."),
      ref: z.enum(["current", "reviewed"]).optional(),
      startLine: z.number().int().min(1).optional(),
      endLine: z.number().int().min(1).optional(),
    }),
    async execute({ path, ref, startLine, endLine }, { threadId }) {
      const review = await assistantReviewOf(threadId);
      if (typeof review === "string") return failed(review);
      return readFileAt(runGh, review, path, ref ?? "current", startLine, endLine);
    },
  });
  bb.agents.registerTool({
    name: "assess_feedback",
    description: "Record whether each piece of the reviewer's feedback was addressed at the PR's current head. Items are thread ids from list_feedback, or \"summary:<n>\" (with a title) for asks in a review summary. Optionally add an overall summary and the verdict you'd suggest. The reviewer sees it in the Feedback view; nothing reaches GitHub.",
    parameters: z.object({
      items: z.array(z.object({
        id: z.string().min(1),
        verdict: z.enum(["addressed", "partial", "not_addressed", "disputed", "unclear"]),
        evidence: z.string().trim().min(1).describe("One line: what changed, or what's missing."),
        title: z.string().optional().describe("For a summary ask: the ask, briefly."),
        file: z.string().optional().describe("Where the evidence is, in the current diff."),
        line: z.number().int().min(1).optional(),
      })).min(1),
      summary: z.string().optional().describe("Two or three sentences on where the PR stands."),
      suggestedVerdict: z.enum(["APPROVE", "REQUEST_CHANGES", "COMMENT"]).optional(),
      suggestedBody: z.string().optional().describe("The review summary you'd submit with that verdict, in GitHub Markdown."),
    }),
    async execute(input, { threadId }) {
      const review = await assistantReviewOf(threadId);
      if (typeof review === "string") return failed(review);
      const result = assess(store, review, input);
      if (!result.ok) return failed(result.error);
      bb.realtime.publish(`feedback:${review.targetKey}`, { ts: Date.now() });
      await sync.evaluate(review.targetKey);
      changed(review.targetKey);
      return result.text;
    },
  });
  bb.agents.registerTool({
    name: "draft_thread_reply",
    description: "Draft a reply on one of the reviewer's review threads. It waits in the Feedback view; only the reviewer sends it to GitHub.",
    parameters: z.object({ threadId: z.string().min(1).describe("The thread id from list_feedback."), body: z.string().trim().min(1).describe("The reply, in GitHub Markdown.") }),
    async execute({ threadId: thread, body }, { threadId }) {
      const review = await assistantReviewOf(threadId);
      if (typeof review === "string") return failed(review);
      if (!store.listFeedbackThreads(review.targetKey).some((t) => t.id === thread)) return failed(`There's no thread ${thread} from the reviewer. Use an id from list_feedback.`);
      store.setReplyDraft(review.targetKey, thread, body, "agent");
      bb.realtime.publish(`feedback:${review.targetKey}`, { ts: Date.now() });
      return "Drafted. The reviewer can edit and send it from the Feedback view.";
    },
  });
  /** The review a guide-writing worker is generating, from its title. */
  async function generationReview(threadId: string): Promise<string | null> {
    const title = await bb.sdk.threads.get({ threadId }).then((thread) => thread.title ?? "", () => "");
    return title.startsWith("Generate guide: ") ? title.slice("Generate guide: ".length) : null;
  }

  // A discussion the assistant didn't answer by the end of its turn stops waiting for it.
  const settle = async ({ thread }: { thread: { id: string } }) => {
    const targetKey = await settleDiscussions(bb, store, thread.id);
    if (targetKey) bb.realtime.publish(`draft:${targetKey}`, {});
    // A feedback check ends with the assistant's turn; an alert waiting for it can go now. A check still
    // queued behind another message hasn't run yet.
    const checked = assistantReview(store, thread.id);
    if (checked && store.getReview(checked)?.verifyingSince && !(await bb.sdk.threads.queuedMessages.list({ threadId: thread.id }).catch(() => [])).length) {
      store.setLifecycle(checked, { verifyingSince: null, verifyingHead: null, preparedAt: Date.now() });
      await sync.evaluate(checked);
      bb.realtime.publish(`feedback:${checked}`, { ts: Date.now() });
    }
  };
  bb.events.on("thread.idle", settle);
  bb.events.on("thread.failed", settle);

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
      return { tools: ["read_review_patch", "read_changes_since_review", "generate_review_guide"], skills: ["guided-review-generate"] };
    }
    // The review assistant can read any file's diff on demand, so the chat
    // works across the whole review, and change its own review's local draft
    // comments — but it never gets the guide-writing tool or the generation
    // skill. Its review context arrives as instructions.
    if (title.startsWith("Review agent:")) {
      const { targetKey } = context.pluginMetadata;
      const review = typeof targetKey === "string" ? store.getReview(targetKey) : null;
      return {
        tools: ["read_review_patch", "list_draft_comments", "add_draft_comment", "edit_draft_comment", "delete_draft_comment", "reply_in_discussion",
          "list_feedback", "read_changes_since_review", "read_file", "assess_feedback", "draft_thread_reply"], skills: [],
        ...(review ? { instructions: assistantInstructions(review.targetKey, store.getGuide(review.targetKey), store.getPreferences().preferences) } : {}),
      };
    }
    return { tools: [], skills: [] };
  });
  // An assistant's runtime keeps the tools it started with. Restart idle ones
  // once, so conversations from before reply_in_discussion get it.
  void (async () => {
    if (await bb.storage.kv.get<number>("assistant-tools") === ASSISTANT_TOOLS) return;
    await refreshAssistants(bb, store);
    await bb.storage.kv.set("assistant-tools", ASSISTANT_TOOLS);
  })().catch(() => {});

  bb.cli.register({
    name: "review",
    summary: "Open a Guided Review of a GitHub PR or local git ref, or change its local draft comments",
    rendersHelp: true,
    commands: [
      { name: "review", summary: "Review a PR or ref", usage: "bb review <pr-url | pr-number | git-ref> [--base <ref>] [--context <text>]" },
      { name: "comment", summary: "List, add, edit, or delete a review's local draft comments; never posts to GitHub", usage: "bb review comment <list | add | edit | delete> <review> [<file>:<line>] [--side LEFT|RIGHT] [--code <text>] [--body <text>] [--json]" },
    ],
    async run(argv, ctx) {
      return updates.run(() => argv[0] === "comment"
        ? runCommentCommand(store, argv.slice(1), (targetKey) => bb.realtime.publish(`draft:${targetKey}`, {}))
        : runReviewCommand({ bb, store, gh: { runGh, runGit } }, argv, ctx));
    },
  });
}
