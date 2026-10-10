import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { Store } from "./store";
import { parseTarget, targetKey } from "./targets";
import { ensureGitHeaders } from "./patch";
import { generateGuide, guideWriterUnavailable } from "./generate";
import { readPrSnapshot } from "./pr-snapshot";
import { resolve } from "node:path";
import { existsSync } from "node:fs";
import {
  ghRepoViewArgs, gitDiffArgs, ghErrorMessage,
} from "./gh";

interface Deps {
  bb: BbPluginApi;
  store: Store;
  gh: { runGh: typeof import("./gh").runGh; runGit: typeof import("./gh").runGit };
}
interface Ctx { projectId?: string; threadId?: string; cwd?: string }

const USAGE = [
  "usage: bb review <pr-url | pr-number | git-ref> [--base <ref>] [--context <text>]",
  "       bb review comment <list | add | edit | delete> …   (see bb review comment --help)",
  "",
  "  --context  text for the assistant's automatic review, such as the ticket the change implements. It's kept with the review; '' removes it.",
].join("\n");
const CONTEXT_LIMIT = 12_000;

export async function runReviewCommand(deps: Deps, argv: string[], ctx: Ctx) {
  let input: string | undefined;
  let base: string | undefined;
  let context: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const value = argv[i];
    if (value === "--help" || value === "-h") return { exitCode: 0, stdout: USAGE };
    if (value === "--base") {
      if (base || !argv[i + 1] || argv[i + 1].startsWith("-")) return { exitCode: 2, stderr: "--base requires a git ref." };
      base = argv[++i];
    } else if (value === "--context") {
      // Any text, including text that starts with "-", such as a bulleted list.
      if (context !== undefined || i + 1 >= argv.length) return { exitCode: 2, stderr: "--context requires text, given once. Pass '' to remove a review's context." };
      context = argv[++i];
      if (context.length > CONTEXT_LIMIT) return { exitCode: 2, stderr: "--context is limited to 12,000 characters." };
    } else if (value.startsWith("-") || input) {
      return { exitCode: 2, stderr: `Unexpected argument: ${value}` };
    } else input = value;
  }
  if (!input) return { exitCode: 2, stderr: USAGE };
  if (!ctx.projectId) return { exitCode: 2, stderr: "Run `bb review` inside a project thread." };
  const target = parseTarget(input, base);
  if (target.kind === "pr" && base) return { exitCode: 2, stderr: "--base is only supported for local git refs." };
  if (target.kind === "ref" || !target.repo) {
    if (!ctx.cwd) return { exitCode: 2, stderr: "A local ref or PR number needs a working directory. Run `bb review` in the repository." };
    // The caller's directory may be on another machine; git and gh run on the bb server.
    if (!existsSync(resolve(ctx.cwd))) return { exitCode: 2, stderr: `A local ref or PR number needs a checkout on the bb server, and ${ctx.cwd} isn't on it. Pass the PR's URL instead, or run \`bb review\` in a checkout on the server.` };
  }
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
      // The repo is known, so gh needs no checkout. The caller's directory may be on another machine.
      snapshot = await readPrSnapshot(deps.gh.runGh, target.number, repo);
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
  deps.store.unignoreDiscovery(key);

  if (context !== undefined) deps.store.setReviewContext(key, context.trim() || null);

  // Fire-and-forget generation; the panel refetches on the realtime signal.
  void generateGuide(deps.bb, deps.store, key, ctx.projectId);

  const lines = [`Guided Review started for ${key}. Open the Guided Review panel to watch it build and review.`];
  if (context !== undefined && !context.trim()) lines.push("Removed the review's context.");
  else if (context !== undefined) lines.push(
    !deps.store.getPreferences().preferences.automaticReview.trim() ? "Automatic review is off in Review settings, so no assistant gets this context."
    : deps.store.getAssistantThread(key) ? "This review already has an assistant conversation, so the automatic review won't run and won't see this context. Paste it into Ask agent instead."
    : "The assistant's automatic review will include this context.");
  return { exitCode: 0, stdout: lines.join("\n") };
}
