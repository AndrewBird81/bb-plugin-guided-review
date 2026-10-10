import { test, expect } from "vitest";
import {
  ghPrViewArgs, ghPrDiffArgs, ghRepoViewArgs, ghSubmitReviewArgs, gitDiffArgs,
  ghPrChecksJsonArgs, ghPrHeadArgs, ghReviewThreadsArgs, ghReplyThreadArgs,
  ghResolveThreadArgs, ghUnresolveThreadArgs, ghErrorMessage,
} from "./gh";

test("ghErrorMessage surfaces GitHub's message + field errors from a 422 body", () => {
  const stderr =
    'gh: Unprocessable Entity (HTTP 422)\n{"message":"Validation Failed","errors":[{"resource":"PullRequestReviewComment","field":"line","code":"invalid","message":"line must be part of the diff"}]}';
  const msg = ghErrorMessage({ stdout: "", stderr });
  expect(msg).toContain("Validation Failed");
  expect(msg).toContain("line must be part of the diff");
  expect(msg).not.toContain("HTTP 422"); // the opaque prefix is dropped
});

test("ghErrorMessage reads the body from stdout (where gh api writes it)", () => {
  // gh api puts the JSON body on stdout and only the terse summary on stderr.
  const r = {
    stdout: '{"message":"Unprocessable Entity","documentation_url":"https://docs.github.com"}',
    stderr: "gh: Unprocessable Entity (HTTP 422)",
  };
  expect(ghErrorMessage(r)).toBe("Unprocessable Entity");
});

test("ghErrorMessage falls back to the raw text without the 'gh:' prefix", () => {
  expect(ghErrorMessage({ stdout: "", stderr: "gh: could not resolve host" })).toBe("could not resolve host");
});

test("pr view requests the json fields we need, with optional -R", () => {
  expect(ghPrViewArgs(12)).toEqual([
    "pr", "view", "12", "--json", "number,title,body,author,baseRefName,headRefName,url,headRefOid",
  ]);
  expect(ghPrViewArgs(12, "acme/web")).toContain("-R");
});

test("pr diff targets the number", () => {
  expect(ghPrDiffArgs(12)).toEqual(["pr", "diff", "12"]);
});

test("repo view returns nameWithOwner", () => {
  expect(ghRepoViewArgs()).toEqual(["repo", "view", "--json", "nameWithOwner"]);
});

test("submit review posts to the reviews endpoint reading json from stdin", () => {
  expect(ghSubmitReviewArgs("acme/web", 12)).toEqual([
    "api", "-X", "POST", "repos/acme/web/pulls/12/reviews", "--input", "-",
  ]);
});

test("git diff builds a range", () => {
  expect(gitDiffArgs("feature/x", "main")).toEqual(["diff", "--no-ext-diff", "--no-textconv", "main...feature/x", "--"]);
  expect(gitDiffArgs("main...HEAD")).toEqual(["diff", "--no-ext-diff", "--no-textconv", "main...HEAD", "--"]);
});

test("pr checks json requests the fields we need, with optional -R", () => {
  expect(ghPrChecksJsonArgs(12)).toEqual([
    "pr", "checks", "12", "--json", "name,state,bucket,link",
  ]);
  expect(ghPrChecksJsonArgs(12, "acme/web")).toEqual([
    "pr", "checks", "12", "--json", "name,state,bucket,link", "-R", "acme/web",
  ]);
});

test("pr head requests headRefOid and reviewDecision, with optional -R", () => {
  expect(ghPrHeadArgs(12)).toEqual([
    "pr", "view", "12", "--json", "headRefOid,reviewDecision,state",
  ]);
  expect(ghPrHeadArgs(12, "acme/web")).toEqual([
    "pr", "view", "12", "--json", "headRefOid,reviewDecision,state", "-R", "acme/web",
  ]);
});

test("review threads args build a graphql query with owner/repo as -f strings and number as -F int", () => {
  const args = ghReviewThreadsArgs("acme", "web", 12);
  expect(args[0]).toBe("api");
  expect(args[1]).toBe("graphql");
  expect(args[2]).toBe("-f");
  expect(args[3]).toContain("query=");
  expect(args[3]).toContain("reviewThreads");
  expect(args).toContain("-f");
  expect(args).toContain("-F");
  expect(args).toEqual(expect.arrayContaining(["owner=acme", "repo=web", "number=12"]));
  // owner/repo must ride on -f (raw string) so gh doesn't coerce numeric-looking
  // names to JSON numbers against the GraphQL String! vars; number stays -F (Int!).
  expect(args.indexOf("-f")).toBeLessThan(args.indexOf("owner=acme"));
  const ownerIdx = args.indexOf("owner=acme");
  const repoIdx = args.indexOf("repo=web");
  const numberIdx = args.indexOf("number=12");
  expect(args[ownerIdx - 1]).toBe("-f");
  expect(args[repoIdx - 1]).toBe("-f");
  expect(args[numberIdx - 1]).toBe("-F");
});

test("reply thread args post to the pr comment replies endpoint reading json from stdin", () => {
  expect(ghReplyThreadArgs("acme/web", 12, 999)).toEqual([
    "api", "-X", "POST", "repos/acme/web/pulls/12/comments/999/replies", "--input", "-",
  ]);
});

test("resolve thread args build a graphql mutation with the thread id as a raw -f string", () => {
  const args = ghResolveThreadArgs("THREAD_ID");
  expect(args[0]).toBe("api");
  expect(args[1]).toBe("graphql");
  expect(args[2]).toBe("-f");
  expect(args[3]).toContain("resolveReviewThread");
  expect(args).toContain("id=THREAD_ID");
  expect(args[args.indexOf("id=THREAD_ID") - 1]).toBe("-f");
});

test("unresolve thread args build a graphql mutation with the thread id as a raw -f string", () => {
  const args = ghUnresolveThreadArgs("THREAD_ID");
  expect(args[0]).toBe("api");
  expect(args[1]).toBe("graphql");
  expect(args[2]).toBe("-f");
  expect(args[3]).toContain("unresolveReviewThread");
  expect(args).toContain("id=THREAD_ID");
  expect(args[args.indexOf("id=THREAD_ID") - 1]).toBe("-f");
});

test("a hung command is killed after its timeout", async () => {
  const { runGit } = await import("./gh");
  const started = Date.now();
  const result = await runGit(["-c", "alias.wait=!sleep 5", "wait"], { timeoutMs: 200 });
  expect(result.code).toBe(124);
  expect(result.stderr).toMatch(/timed out/);
  expect(Date.now() - started).toBeLessThan(3000);
});
