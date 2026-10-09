import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { Store } from "./store";
import { parseTarget, targetKey } from "./targets";
import { ensureGitHeaders } from "./patch";
import { generateGuide, guideWriterUnavailable } from "./generate";
import { readPrSnapshot } from "./pr-snapshot";

interface Deps {
  bb: BbPluginApi;
  store: Store;
  gh: { runGh: typeof import("./gh").runGh; runGit: typeof import("./gh").runGit };
}

// Panel-driven counterpart to review-command.ts's PR branch: a user pastes a
// full GitHub PR URL into the panel instead of running `bb review` in a
// terminal. Only full PR URLs are accepted here — a bare PR number or local
// git ref needs a project-scoped cwd/branch that the nav panel doesn't have,
// so those still route through the CLI.
export async function createPrReview(
  deps: Deps,
  args: { input: string; projectId: string },
): Promise<{ ok: boolean; error?: string; targetKey?: string }> {
  const target = parseTarget(args.input);
  if (target.kind !== "pr" || !target.repo) {
    return {
      ok: false,
      error:
        "Paste a full GitHub PR URL (github.com/owner/repo/pull/N). For a PR number or local ref, run `bb review` in a terminal.",
    };
  }

  const unavailable = await guideWriterUnavailable(deps.bb, deps.store);
  if (unavailable) return { ok: false, error: unavailable };

  let snapshot: Awaited<ReturnType<typeof readPrSnapshot>>;
  try {
    snapshot = await readPrSnapshot(deps.gh.runGh, target.number, target.repo);
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "Could not load the PR." };
  }
  const { pr, patch } = snapshot;

  const key = targetKey(target);
  const now = Date.now();

  deps.store.saveReview({
    targetKey: key,
    kind: "pr",
    number: target.number,
    repo: target.repo,
    title: pr.title,
    author: pr.author?.login,
    base: pr.baseRefName,
    head: pr.headRefName,
    url: pr.url,
    gitRef: `${pr.baseRefName}...${pr.headRefName}`,
    headSha: pr.headRefOid,
    projectId: args.projectId,
    status: "generating",
    createdAt: now,
  });
  deps.store.savePatch(key, ensureGitHeaders(patch));

  // Fire-and-forget generation; the panel refetches on the realtime signal.
  void generateGuide(deps.bb, deps.store, key, args.projectId);

  return { ok: true, targetKey: key };
}
