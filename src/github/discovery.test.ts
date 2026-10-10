import { expect, test, vi } from "vitest";
import { discoverPrs } from "./discovery";

const node = (repo: string, number: number, extra: Record<string, unknown> = {}) => ({
  number, title: `PR ${number}`, url: `https://github.com/${repo}/pull/${number}`, isDraft: false,
  updatedAt: "2026-10-10T12:00:00Z", author: { login: "alice" }, repository: { nameWithOwner: repo }, ...extra,
});
const results = (nodes: unknown[]) => ({ code: 0, stderr: "", stdout: JSON.stringify({ data: { search: { nodes } } }) });
const searched = (run: ReturnType<typeof vi.fn>) => run.mock.calls.map(([args]) => (args as string[]).find((a) => a.startsWith("q="))!.slice(2));

function fakeSearch(requested: unknown[], reviewed: unknown[]) {
  return vi.fn(async (args: string[]) => (args.some((a) => a.includes("reviewed-by:@me")) ? results(reviewed) : results(requested)));
}

test("discoverPrs searches review requests only, unless asked for reviewed PRs too", async () => {
  const run = fakeSearch([node("cli/cli", 1)], [node("cli/cli", 2)]);
  const prs = await discoverPrs(run, { reviewed: false });
  expect(searched(run)).toEqual(["is:pr is:open archived:false review-requested:@me sort:updated-desc"]);
  expect(prs).toEqual([{
    repo: "cli/cli", number: 1, title: "PR 1", url: "https://github.com/cli/cli/pull/1", author: "alice",
    updatedAt: Date.parse("2026-10-10T12:00:00Z"), isDraft: false, requested: true, reviewed: false,
  }]);
  expect(run.mock.calls[0][0].slice(0, 2)).toEqual(["api", "graphql"]);
  expect(run.mock.calls[0][0].join(" ")).not.toMatch(/mutation/i);
});

test("discoverPrs merges a PR found by both searches, by lowercased repo and number", async () => {
  const run = fakeSearch(
    [node("Acme/Web", 7, { isDraft: true }), node("cli/cli", 1)],
    [node("acme/web", 7), node("cli/cli", 2, { author: null }), {}],
  );
  const prs = await discoverPrs(run, { reviewed: true, now: Date.parse("2026-10-10T12:00:00Z") });
  expect(searched(run)).toEqual([
    "is:pr is:open archived:false review-requested:@me sort:updated-desc",
    "is:pr is:open archived:false reviewed-by:@me -author:@me updated:>=2026-08-11 sort:updated-desc",
  ]);
  expect(prs.map((p) => [p.repo, p.number, p.requested, p.reviewed])).toEqual([
    ["acme/web", 7, true, true], ["cli/cli", 1, true, false], ["cli/cli", 2, false, true],
  ]);
  expect(prs[0].isDraft).toBe(true);
  expect(prs[2].author).toBeNull();
});

test("discoverPrs rejects when a search fails", async () => {
  const run = vi.fn(async () => ({ code: 1, stderr: "gh: API rate limit exceeded", stdout: "" }));
  await expect(discoverPrs(run, { reviewed: false })).rejects.toThrow(/rate limit/);
});
