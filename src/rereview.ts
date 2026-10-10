import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { Store } from "./store";
import { ensureGitHeaders } from "./patch";
import { generateGuide, guideWriterUnavailable } from "./generate";
import { gitDiffArgs } from "./gh";
import { readPrSnapshot } from "./pr-snapshot";
import { reanchor } from "./reanchor";
import { pruneDiffs } from "./feedback-view";

interface Deps {
  bb: BbPluginApi; store: Store;
  gh: { runGh: typeof import("./gh").runGh; runGit: typeof import("./gh").runGit };
}

/** Re-read the target and regenerate its guide. `notify: false` leaves alerts to the turn that asked for it. */
export async function rerunReview(deps: Deps, targetKey: string, options: { notify?: boolean } = {}): Promise<{ ok: boolean; error?: string }> {
  const m = deps.store.getReview(targetKey);
  if (!m || !m.projectId) return { ok: false, error: "Unknown review or missing project." };
  const unavailable = await guideWriterUnavailable(deps.bb, deps.store);
  if (unavailable) return { ok: false, error: unavailable };

  let patch = "";
  if (m.kind === "pr" && m.number && m.repo) {
    try {
      const snapshot = await readPrSnapshot(deps.gh.runGh, m.number, m.repo);
      patch = snapshot.patch;
      m.headSha = snapshot.pr.headRefOid;
      m.base = snapshot.pr.baseRefName;
      m.head = snapshot.pr.headRefName;
      m.gitRef = `${m.base}...${m.head}`;
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : "Could not load the PR." };
    }
  } else if (m.kind === "ref" && m.gitRef) {
    if (!m.cwd) return { ok: false, error: "Local-ref re-review needs the original working dir; re-run `bb review` in the terminal." };
    const diff = await deps.gh.runGit(gitDiffArgs(m.gitRef), { cwd: m.cwd });
    if (diff.code !== 0) return { ok: false, error: diff.stderr || "git diff failed" };
    patch = diff.stdout;
  } else {
    return { ok: false, error: "Review has no re-runnable target." };
  }
  if (!patch.trim()) return { ok: false, error: "No changes found." };

  const previous = deps.store.readPatch(targetKey, 0, deps.store.readPatch(targetKey, 0, 0).total).text;
  const next = ensureGitHeaders(patch);
  deps.store.savePatch(targetKey, next);
  deps.store.saveReview({ ...m, status: "generating" });
  if (m.headSha) deps.store.saveSnapshot(targetKey, m.headSha, next);
  // Unsent draft comments follow their lines into the new diff; ones whose lines are gone stay flagged.
  for (const comment of deps.store.getDraft(targetKey).comments) {
    const placed = reanchor({ ...comment, code: deps.store.draftCommentCode(targetKey, comment) }, previous, next);
    if (placed.status !== "lost") deps.store.rebaseDraftComment(targetKey, comment, placed.status === "moved" ? placed.line : comment.line);
  }
  pruneDiffs(deps.store, deps.store.getReview(targetKey)!);
  void generateGuide(deps.bb, deps.store, targetKey, m.projectId, options);
  return { ok: true };
}
