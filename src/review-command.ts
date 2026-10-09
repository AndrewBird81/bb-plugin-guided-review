import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { Store } from "./store";
import { parseTarget, targetKey } from "./targets";
import { ensureGitHeaders } from "./patch";
import { generateGuide, guideWriterUnavailable } from "./generate";
import { readPrSnapshot } from "./pr-snapshot";
import { resolve } from "node:path";
import {
  ghRepoViewArgs, gitDiffArgs, ghErrorMessage,
} from "./gh";

interface Deps {
  bb: BbPluginApi;
  store: Store;
  gh: { runGh: typeof import("./gh").runGh; runGit: typeof import("./gh").runGit };
}
interface Ctx { projectId?: string; threadId?: string; cwd?: string }

const USAGE = "usage: bb review <pr-url | pr-number | git-ref> [--base <ref>]\n       bb review comment <list | add | edit | delete> …   (see bb review comment --help)";

export async function runReviewCommand(deps: Deps, argv: string[], ctx: Ctx) {
  let input: string | undefined;
  let base: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const value = argv[i];
    if (value === "--help" || value === "-h") return { exitCode: 0, stdout: USAGE };
    if (value === "--base") {
      if (base || !argv[i + 1] || argv[i + 1].startsWith("-")) return { exitCode: 2, stderr: "--base requires a git ref." };
      base = argv[++i];
    } else if (value.startsWith("-") || input) {
      return { exitCode: 2, stderr: `Unexpected argument: ${value}` };
    } else input = value;
  }
  if (!input) return { exitCode: 2, stderr: USAGE };
  if (!ctx.projectId) return { exitCode: 2, stderr: "Run `bb review` inside a project thread." };
  const target = parseTarget(input, base);
  if (target.kind === "pr" && base) return { exitCode: 2, stderr: "--base is only supported for local git refs." };
  if ((target.kind === "ref" || !target.repo) && !ctx.cwd) return { exitCode: 2, stderr: "A local ref or PR number needs a working directory. Run `bb review` in the repository." };
  const unavailable = await guideWriterUnavailable(deps.bb, deps.store);
  if (unavailable) return { exitCode: 1, stderr: unavailable };
  const cwd = ctx.cwd ? resolve(ctx.cwd) : undefined;
  let key = targetKey(target, cwd ? { projectId: ctx.projectId, cwd } : undefined);
  const now = Date.now();

  let patch = "";
  const meta: any = { targetKey: key, kind: target.kind, status: "generating", createdAt: now };
  meta.projectId = ctx.projectId;
  meta.cwd = cwd;

  if (target.kind === "pr") {
    let repo = target.repo;
    if (!repo) {
      const r = await deps.gh.runGh(ghRepoViewArgs(), { cwd });
      if (r.code !== 0) return { exitCode: 1, stderr: ghErrorMessage(r) };
      try {
        repo = JSON.parse(r.stdout).nameWithOwner as string;
      } catch {
        return { exitCode: 1, stderr: "Unexpected gh output (could not parse JSON)." };
      }
    }
    if (!repo || !/^[A-Za-z0-9-]+\/[A-Za-z0-9_.-]+$/.test(repo)) return { exitCode: 1, stderr: "Could not resolve the GitHub repository." };
    key = targetKey({ ...target, repo });
    meta.targetKey = key;
    let snapshot: Awaited<ReturnType<typeof readPrSnapshot>>;
    try {
      snapshot = await readPrSnapshot(deps.gh.runGh, target.number, repo, cwd);
    } catch (error) {
      return { exitCode: 1, stderr: error instanceof Error ? error.message : "Could not load the PR." };
    }
    const { pr } = snapshot;
    Object.assign(meta, {
      number: target.number, repo, title: pr.title, author: pr.author?.login,
      base: pr.baseRefName, head: pr.headRefName, url: pr.url, gitRef: `${pr.baseRefName}...${pr.headRefName}`,
      headSha: pr.headRefOid,
    });
    patch = snapshot.patch;
  } else {
    const diff = await deps.gh.runGit(gitDiffArgs(target.gitRef, target.base), { cwd });
    if (diff.code !== 0) return { exitCode: 1, stderr: diff.stderr || "git diff failed" };
    patch = diff.stdout;
    meta.gitRef = target.base && !target.gitRef.includes("..") ? `${target.base}...${target.gitRef}` : target.gitRef;
    meta.base = target.base;
  }

  if (!patch.trim()) return { exitCode: 1, stderr: "No changes found for that target." };

  deps.store.saveReview(meta);
  deps.store.savePatch(key, ensureGitHeaders(patch));

  // Fire-and-forget generation; the panel refetches on the realtime signal.
  void generateGuide(deps.bb, deps.store, key, ctx.projectId);

  return {
    exitCode: 0,
    stdout: `Guided Review started for ${key}. Open the Guided Review panel to watch it build and review.`,
  };
}
