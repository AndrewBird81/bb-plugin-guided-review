import { expect, test, vi } from "vitest";
import { fetchMyThreads, isQuestion, parseMyThreads } from "./threads";
import cli9083 from "./fixtures/threads-cli-9083.json";

const user = (login: string) => ({ __typename: "User", login });
const bot = (login: string) => ({ __typename: "Bot", login });
const at = (minute: number) => `2026-10-01T10:${String(minute).padStart(2, "0")}:00Z`;

/** A review thread node shaped like the query's response; the first comment is "c0". */
function thread(firstAuthor: string, later: Array<[author: unknown, body: string, minute: number]>, overrides: Record<string, unknown> = {}) {
  const first = { id: "c0", databaseId: 100, author: { login: firstAuthor }, body: "Rename this?", createdAt: at(0), pullRequestReview: { id: "PRR_1" } };
  const recent = [{ ...first, author: user(firstAuthor) }, ...later.map(([author, body, minute], i) => ({ id: `c${i + 1}`, author, body, createdAt: at(minute) }))];
  return {
    id: "PRRT_1", isResolved: false, isOutdated: false, path: "src/a.ts", line: 12, originalLine: 10, startLine: null,
    diffSide: "RIGHT", subjectType: "LINE", resolvedBy: null,
    first: { nodes: [first] }, recent: { nodes: recent }, ...overrides,
  };
}
const page = (nodes: unknown[], pageInfo = { hasNextPage: false, endCursor: null as string | null }) =>
  ({ data: { repository: { pullRequest: { reviewThreads: { pageInfo, nodes } } } } });
const parseOne = (node: unknown, viewer = "me") => parseMyThreads(page([node]), viewer)[0];

test("parseMyThreads reads a captured cli/cli response", () => {
  const threads = parseMyThreads(cli9083, "andyfeller");
  // Four threads on the PR; three were started by the viewer.
  expect(threads.map((t) => [t.path, t.status])).toEqual([
    ["pkg/cmdutil/errors.go", "resolved"], ["pkg/cmdutil/repo_override.go", "resolved"], ["pkg/cmd/variable/set/set.go", "answered"],
  ]);
  expect(threads[2]).toMatchObject({
    id: "PRRT_kwDODKw3uc5BicAG", commentId: 1720145004, reviewId: "PRR_kwDODKw3uc6FrwJ4", line: null, originalLine: 197, startLine: 178,
    side: "RIGHT", subjectType: "LINE", isOutdated: true, isResolved: false, resolvedBy: null,
    createdAt: Date.parse("2024-08-16T17:55:07Z"), replyAt: Date.parse("2024-08-21T16:20:05Z"),
  });
  expect(threads[2].replies.map((r) => [r.author, r.mine])).toEqual([["andyfeller", true], ["wingleung", false], ["wingleung", false]]);
  expect(threads[0]).toMatchObject({ resolvedBy: "andyfeller", replyAt: null });
});

test("only threads the viewer started are kept, matching the login case-insensitively", () => {
  const threads = parseMyThreads(page([thread("Me", []), thread("bob", [[user("me"), "agreed", 1]])]), "me");
  expect(threads).toHaveLength(1);
  expect(threads[0]).toMatchObject({ body: "Rename this?", commentId: 100, reviewId: "PRR_1", status: "open", replyAt: null, replies: [] });
});

test("replies leave out the first comment, are oldest first, and flag bots and the viewer", () => {
  const t = parseOne(thread("me", [[user("alice"), "b", 3], [bot("github-actions"), "ci", 2], [user("ME"), "a", 1], [user("dependabot[bot]"), "d", 4], [null, "ghost", 5]]));
  expect(t.replies.map((r) => [r.author, r.bot, r.mine])).toEqual([
    ["ME", false, true], ["github-actions", true, false], ["alice", false, false], ["dependabot[bot]", true, false], ["ghost", false, false],
  ]);
});

test("the latest reply from someone else after the viewer's last comment sets the status", () => {
  expect(parseOne(thread("me", [[user("alice"), "Done, renamed.", 1]]))).toMatchObject({ status: "answered", replyAt: Date.parse(at(1)) });
  expect(parseOne(thread("me", [[user("alice"), "Done.", 1], [user("bob"), "Which name do you prefer?", 2]]))).toMatchObject({ status: "question", replyAt: Date.parse(at(2)) });
  expect(parseOne(thread("me", [[user("alice"), "Why?", 1], [user("bob"), "Fixed.", 2]]))).toMatchObject({ status: "answered", replyAt: Date.parse(at(2)) });
});

test("the viewer replying last leaves the thread open", () => {
  expect(parseOne(thread("me", [[user("alice"), "Why?", 1], [user("me"), "Because of X.", 2]]))).toMatchObject({ status: "open", replyAt: null });
});

test("bot replies don't count as answers", () => {
  expect(parseOne(thread("me", [[bot("coderabbitai"), "Is this right?", 1], [user("renovate[bot]"), "Updated", 2]]))).toMatchObject({ status: "open", replyAt: null });
  expect(parseOne(thread("me", [[user("alice"), "Done", 1], [bot("copilot"), "Summary?", 2]]))).toMatchObject({ status: "answered", replyAt: Date.parse(at(1)) });
});

test("resolved wins over any reply", () => {
  const t = parseOne(thread("me", [[user("alice"), "Can you check again?", 1]], { isResolved: true, resolvedBy: { login: "alice" } }));
  expect(t).toMatchObject({ status: "resolved", replyAt: null, isResolved: true, resolvedBy: "alice" });
});

test("file-level threads have no line", () => {
  const t = parseOne(thread("me", [], { subjectType: "FILE", line: null, originalLine: null, diffSide: null }));
  expect(t).toMatchObject({ subjectType: "FILE", line: null, originalLine: null, side: null });
});

test("isQuestion looks for a question mark in prose, or a mention", () => {
  expect(isQuestion("Should this be async?", "me")).toBe(true);
  expect(isQuestion("Done. @Me take another look", "me")).toBe(true);
  expect(isQuestion("Done, thanks!", "me")).toBe(false);
  expect(isQuestion("Changed to `a?.b`", "me")).toBe(false);
  expect(isQuestion("Changed:\n```ts\nconst x = a ?? b;\nif (x?.y) {}\n```\nDone.", "me")).toBe(false);
  expect(isQuestion("~~~\nwhat?\n~~~", "me")).toBe(false);
  expect(isQuestion("```\nunclosed?", "me")).toBe(false);
  expect(isQuestion("> Should this be async?\n\nYes, done.", "me")).toBe(false);
  expect(isQuestion("See https://example.com/a?b=1", "me")).toBe(false);
  expect(isQuestion("Mail me@me.dev", "me")).toBe(false);
  expect(isQuestion("`@me` is the handle", "me")).toBe(false);
  expect(isQuestion("```\ncode\n```\nWhat about the other call?", "me")).toBe(true);
});

test("fetchMyThreads pages with the end cursor, up to 300 threads", async () => {
  const run = vi.fn(async (args: string[]) => {
    const n = run.mock.calls.length;
    return { code: 0, stderr: "", stdout: JSON.stringify(page([thread("me", [])], { hasNextPage: true, endCursor: `cursor${n}` })) };
  });
  const threads = await fetchMyThreads(run, "cli/cli", 9083, "me");
  expect(run).toHaveBeenCalledTimes(3);
  expect(threads).toHaveLength(3);
  const [first] = run.mock.calls[0];
  expect(first).toEqual(expect.arrayContaining(["api", "graphql", "owner=cli", "repo=cli", "number=9083"]));
  expect(first.some((a) => a.startsWith("after="))).toBe(false);
  expect(run.mock.calls[2][0].slice(-2)).toEqual(["-f", "after=cursor2"]);
  expect(run.mock.calls[0][0].join(" ")).not.toMatch(/mutation/i);
});

test("fetchMyThreads stops at the last page", async () => {
  const run = vi.fn(async () => ({ code: 0, stderr: "", stdout: JSON.stringify(page([thread("me", [])])) }));
  await fetchMyThreads(run, "cli/cli", 1, "me");
  expect(run).toHaveBeenCalledTimes(1);
});

test("fetchMyThreads rejects on a failed or unreadable response", async () => {
  await expect(fetchMyThreads(vi.fn(async () => ({ code: 1, stderr: "HTTP 502", stdout: "" })), "cli/cli", 1, "me")).rejects.toThrow(/502/);
  await expect(fetchMyThreads(vi.fn(async () => ({ code: 0, stderr: "", stdout: "<html>" })), "cli/cli", 1, "me")).rejects.toThrow();
});
