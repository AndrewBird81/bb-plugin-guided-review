import { spawn } from "node:child_process";

const PR_FIELDS = "number,title,body,author,baseRefName,headRefName,url,headRefOid";

export function ghPrViewArgs(number: number, repo?: string): string[] {
  const a = ["pr", "view", String(number), "--json", PR_FIELDS];
  return repo ? [...a, "-R", repo] : a;
}
export function ghPrDiffArgs(number: number, repo?: string): string[] {
  const a = ["pr", "diff", String(number)];
  return repo ? [...a, "-R", repo] : a;
}
export function ghRepoViewArgs(): string[] {
  return ["repo", "view", "--json", "nameWithOwner"];
}
export function ghPrCommentsArgs(repo: string, number: number): string[] {
  return ["api", `repos/${repo}/pulls/${number}/comments`];
}
export function ghSubmitReviewArgs(repo: string, number: number): string[] {
  return ["api", "-X", "POST", `repos/${repo}/pulls/${number}/reviews`, "--input", "-"];
}
export function gitDiffArgs(gitRef: string, base?: string): string[] {
  if (!gitRef || gitRef.startsWith("-") || base?.startsWith("-")) throw new Error("Expected a git ref, not an option.");
  const range = gitRef.includes("..") ? gitRef : base ? `${base}...${gitRef}` : gitRef;
  return ["diff", "--no-ext-diff", "--no-textconv", range, "--"];
}
export function ghPrChecksJsonArgs(number: number, repo?: string): string[] {
  const a = ["pr", "checks", String(number), "--json", "name,state,bucket,link"];
  return repo ? [...a, "-R", repo] : a;
}
export function ghPrHeadArgs(number: number, repo?: string): string[] {
  const a = ["pr", "view", String(number), "--json", "headRefOid,reviewDecision,state"];
  return repo ? [...a, "-R", repo] : a;
}
const REVIEW_THREADS_QUERY = `query($owner:String!,$repo:String!,$number:Int!){
  repository(owner:$owner,name:$repo){ pullRequest(number:$number){
    reviewThreads(first:100){ nodes{
      id isResolved isOutdated path line
      comments(first:100){ nodes{ id databaseId author{login} body } } } } } } }`;
export function ghReviewThreadsArgs(owner: string, repo: string, number: number): string[] {
  return ["api", "graphql", "-f", `query=${REVIEW_THREADS_QUERY}`,
    "-f", `owner=${owner}`, "-f", `repo=${repo}`, "-F", `number=${number}`];
}
export function ghReplyThreadArgs(repo: string, number: number, inReplyToCommentId: number): string[] {
  return ["api", "-X", "POST", `repos/${repo}/pulls/${number}/comments/${inReplyToCommentId}/replies`, "--input", "-"];
}
export function ghResolveThreadArgs(threadId: string): string[] {
  return ["api", "graphql", "-f",
    `query=mutation($id:ID!){resolveReviewThread(input:{threadId:$id}){thread{id isResolved}}}`,
    "-f", `id=${threadId}`];
}
export function ghUnresolveThreadArgs(threadId: string): string[] {
  return ["api", "graphql", "-f",
    `query=mutation($id:ID!){unresolveReviewThread(input:{threadId:$id}){thread{id isResolved}}}`,
    "-f", `id=${threadId}`];
}

/** timeoutMs 0 waits for as long as it takes: a write killed mid-flight may still land, and a retry would duplicate it. */
interface RunOpts { cwd?: string; stdin?: string; authToken?: string; timeoutMs?: number }
/** A hung `gh` or `git` mustn't stall the review sync; long diffs still finish well inside this. */
const DEFAULT_TIMEOUT_MS = 120_000;
interface RunResult { stdout: string; stderr: string; code: number }

function run(bin: string, args: string[], opts: RunOpts = {}): Promise<RunResult> {
  return new Promise((resolve) => {
    // This plugin only accepts github.com targets; ambient GH_HOST must not
    // redirect REST requests or account selection to an enterprise host.
    const child = spawn(bin, args, { cwd: opts.cwd, env: { ...process.env, ...(opts.authToken ? { GH_TOKEN: opts.authToken } : {}), GH_HOST: "github.com", GH_PROMPT_DISABLED: "1", GIT_TERMINAL_PROMPT: "0" } });
    let stdout = "", stderr = "";
    const limit = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    // Settle at the deadline: a grandchild holding the pipes open would delay "close".
    const timer = limit > 0 ? setTimeout(() => { child.kill("SIGKILL"); resolve({ stdout, stderr: `${bin} timed out after ${Math.round(limit / 1000)}s`, code: 124 }); }, limit) : undefined;
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", (error) => { clearTimeout(timer); resolve({ stdout, stderr: `${bin} could not start: ${error.message}`, code: 1 }); });
    child.stdin.on("error", () => {}); // A failed spawn/early exit can close stdin first.
    child.on("close", (code) => { clearTimeout(timer); resolve({ stdout, stderr, code: code ?? 1 }); });
    if (opts.stdin !== undefined) child.stdin.end(opts.stdin);
    else child.stdin.end();
  });
}

export const runGh = (args: string[], opts?: RunOpts) => run("gh", args, opts);
export const runGit = (args: string[], opts?: RunOpts) => run("git", args, opts);

/**
 * Turn a failed `gh api` result into a legible message. Crucially, `gh api`
 * writes the GitHub response BODY (message + field errors) to **stdout** and
 * only a terse "gh: … (HTTP nnn)" summary to stderr — so we must parse stdout,
 * not just stderr, or the user is left with a bare "Unprocessable Entity".
 */
export function ghErrorMessage(r: { stdout: string; stderr: string }): string {
  const detail = extractGhBody(r.stdout) ?? extractGhBody(r.stderr);
  if (detail) return detail;
  const status = (r.stderr || r.stdout || "").trim().replace(/^gh:\s*/, "");
  return status || "GitHub request failed";
}

function extractGhBody(text: string): string | null {
  if (!text) return null;
  const brace = text.indexOf("{");
  if (brace < 0) return null;
  // Try the tail from the first "{", then a trimmed first..last "{...}" slice.
  for (const candidate of [text.slice(brace), text.slice(brace, text.lastIndexOf("}") + 1)]) {
    try {
      const body = JSON.parse(candidate) as { message?: unknown; errors?: unknown };
      const parts: string[] = [];
      if (typeof body.message === "string") parts.push(body.message);
      if (Array.isArray(body.errors)) {
        for (const e of body.errors as any[]) {
          if (typeof e === "string") parts.push(e);
          else if (e?.message) parts.push(String(e.message));
          else if (e?.field) parts.push(`${e.resource ?? "field"}.${e.field} ${e.code ?? "invalid"}`);
        }
      }
      if (parts.length) return [...new Set(parts)].join(" — ");
    } catch {
      // try the next candidate slice
    }
  }
  return null;
}
