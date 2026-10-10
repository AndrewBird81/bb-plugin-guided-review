import { bindGhAccount } from "./gh-identity";
import type { Store } from "./store";
import { ghErrorMessage, ghPrHeadArgs, ghSubmitReviewArgs, type runGh } from "./gh";
import { sameComments, toGithubReviewPayload, type DraftComment } from "./draft";
import { requireReviewRevision } from "./review-revision";
import { invalidComments } from "./review-positions";

export function createReviewSubmitter(store: Store, run: typeof runGh) {
  const inFlight = new Set<string>();
  /** `shown` is the list of comments the reviewer's page displays; the draft must still match it. */
  return async (targetKey: string, revision?: string, account?: string, shown?: Pick<DraftComment, "file" | "line" | "side" | "body">[]): Promise<{ ok: boolean; error?: string }> => {
    if (inFlight.has(targetKey)) return { ok: false, error: "This review is already being submitted." };
    inFlight.add(targetKey);
    try {
      if (revision) requireReviewRevision(store, targetKey, revision);
      const m = store.getReview(targetKey);
      if (!m || m.kind !== "pr" || !m.number || !m.repo) return { ok: false, error: "Submitting requires a GitHub PR target." };
      if (m.prState === "MERGED" || m.prState === "CLOSED") return { ok: false, error: `This PR is ${m.prState.toLowerCase()}. Your draft has been kept.` };
      if (m.status === "generating") return { ok: false, error: "Wait for the review to finish generating before submitting." };
      if (!m.headSha) return { ok: false, error: "Re-review this PR before submitting so the reviewed revision can be verified." };
      const draft = store.getDraft(targetKey);
      if (shown && !sameComments(draft.comments, shown)) return { ok: false, error: "Your draft comments changed since this page showed them, possibly from the assistant. Check them, then submit again." };
      if (draft.verdict === "COMMENT" && !draft.body.trim() && !draft.comments.length) return { ok: false, error: "Add a summary or at least one comment before submitting a Comment review." };
      if (draft.verdict === "REQUEST_CHANGES" && !draft.body.trim()) return { ok: false, error: "Add a summary explaining the requested changes before submitting." };
      if (draft.comments.some((c) => !c.body.trim())) return { ok: false, error: "Draft comments cannot be blank." };
      if (store.staleDraftComments(targetKey).length) return { ok: false, error: "The diff changed after these comments were drafted. Remove affected comments and add them again against the current diff before submitting." };
      const patch = store.readPatch(targetKey, 0, store.readPatch(targetKey, 0, 0).total).text;
      const bad = invalidComments(patch, draft.comments);
      if (bad.length) return { ok: false, error: `These comments are outside the current diff: ${bad.map((c) => `${c.file}:${c.line}`).join(", ")}. Remove them and add any replacement comments on lines in the current diff.` };
      const authenticatedRun = account ? await bindGhAccount(run, account) : run;
      const head = await authenticatedRun(ghPrHeadArgs(m.number, m.repo));
      if (head.code !== 0) return { ok: false, error: ghErrorMessage(head) };
      let current: unknown;
      try {
        const snapshot = JSON.parse(head.stdout);
        current = snapshot?.headRefOid;
        if (snapshot.state === "MERGED" || snapshot.state === "CLOSED") {
          store.setLifecycle(targetKey, { prState: snapshot.state, archivedAt: Date.now() });
          return { ok: false, error: `This PR is ${snapshot.state.toLowerCase()}. Your draft has been kept.` };
        }
      } catch { /* reject below */ }
      if (typeof current !== "string" || !current) return { ok: false, error: "Could not verify the PR revision. Your draft has been kept." };
      if (current !== m.headSha) return { ok: false, error: "The PR has new commits. Re-review the latest changes before submitting. Your draft has been kept." };
      if (store.getReview(targetKey)?.status === "generating" || store.getReview(targetKey)?.headSha !== m.headSha) return { ok: false, error: "The review changed during submission. Wait for generation and review the draft again." };
      if (revision) requireReviewRevision(store, targetKey, revision);
      const result = await authenticatedRun(ghSubmitReviewArgs(m.repo, m.number), {
        stdin: JSON.stringify({ ...toGithubReviewPayload(draft), commit_id: m.headSha }),
      });
      if (result.code !== 0) return { ok: false, error: ghErrorMessage(result) };
      let reviewer: string | undefined;
      let reviewId: string | null = null;
      try {
        const receipt = JSON.parse(result.stdout);
        if (typeof receipt?.user?.login === "string") reviewer = receipt.user.login;
        // The review's GraphQL id, to recognize it when the sync reads it back.
        if (typeof receipt?.node_id === "string") reviewId = receipt.node_id;
      } catch { /* A successful response still records the submitted verdict. */ }
      store.setLifecycle(targetKey, { submittedVerdict: draft.verdict, submittedAt: Date.now(), submittedHeadSha: m.headSha, submittedReviewId: reviewId, ...(reviewer ? { reviewer } : {}) });
      store.clearSubmittedDraft(draft);
      return { ok: true };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : "Could not submit the review. Your draft has been kept." };
    } finally {
      inFlight.delete(targetKey);
    }
  };
}
