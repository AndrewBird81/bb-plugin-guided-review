import { expect, test, vi } from "vitest";
import { BATCH_SIZE, fetchPrFacts, mentions, parsePrFacts, prFactsQuery } from "./pr-facts";
import type { PrRef } from "./types";
import cli9083 from "./fixtures/pr-facts-cli-9083.json";

const ref = (number: number, repo = "cli/cli"): PrRef => ({ targetKey: `pr-${number}`, repo, number });
const noTeams = new Set<string>();
const user = (login: string) => ({ __typename: "User", login });
const team = (org: string, slug: string) => ({ __typename: "Team", slug, organization: { login: org } });

/** A pull request node shaped like the fragment's response. */
function pr(overrides: Record<string, unknown> = {}) {
  return {
    number: 1, state: "OPEN", isDraft: false, updatedAt: "2026-10-01T00:00:00Z", title: "Fix", url: "https://github.com/acme/web/pull/1",
    baseRefName: "main", headRefName: "fix", headRefOid: "c3", author: { login: "alice" }, reviewDecision: "REVIEW_REQUIRED",
    commits: { nodes: [{ commit: { oid: "c1" } }, { commit: { oid: "c2" } }, { commit: { oid: "c3" } }] },
    head: { nodes: [{ commit: { statusCheckRollup: { state: "SUCCESS" } } }] },
    latestOpinionatedReviews: { nodes: [] }, reviewRequests: { nodes: [] }, reviews: { nodes: [] },
    events: { nodes: [] }, conversation: { nodes: [] },
    ...overrides,
  };
}
const one = (node: unknown, viewer = "me", teams: ReadonlySet<string> = noTeams) =>
  parsePrFacts({ data: { p0: { pullRequest: node } } }, [ref(1, "acme/web")], viewer, teams).get("pr-1")!;

test("prFactsQuery aliases each PR and passes owner, name, and number as variables", () => {
  const { query, variables } = prFactsQuery([ref(1, "cli/cli"), ref(2, "acme/web")]);
  expect(query).toContain("query($viewer:String!,$o0:String!,$r0:String!,$n0:Int!,$o1:String!,$r1:String!,$n1:Int!)");
  expect(query).toContain("p1:repository(owner:$o1,name:$r1){pullRequest(number:$n1){...F}}");
  expect(query).toContain("reviews(last:30,author:$viewer)");
  expect(query).not.toMatch(/mutation/i);
  expect(variables).toEqual({ o0: "cli", r0: "cli", n0: 1, o1: "acme", r1: "web", n1: 2 });
});

test("parsePrFacts normalizes a captured cli/cli response, dropping reply-only reviews", () => {
  const facts = parsePrFacts(cli9083, [ref(9083)], "andyfeller", noTeams).get("pr-9083")!;
  expect(facts).toMatchObject({
    repo: "cli/cli", number: 9083, state: "CLOSED", author: "wingleung", ci: "none", reviewDecision: "CHANGES_REQUESTED",
    headSha: "97b10370e1dec2f7be3665646d9a7b088edb180e", requestPending: { via: "user" },
    readyAt: Date.parse("2024-06-02T10:28:20Z"), draftAt: null, dismissedAt: null, forcePushedAt: null,
    mention: { at: Date.parse("2024-08-25T07:01:13Z"), by: "wingleung" },
    otherOpinions: [{ login: "williammartin", state: "CHANGES_REQUESTED" }],
  });
  // Ten reviews on GitHub; six are only replies to existing threads.
  expect(facts.myReviews.map((r) => r.state)).toEqual(["COMMENTED", "COMMENTED", "COMMENTED", "APPROVED"]);
  expect(facts.myReviews.map((r) => r.submittedAt)).toEqual([...facts.myReviews.map((r) => r.submittedAt)].sort((a, b) => a - b));
  expect(facts.myReviews[3]).toMatchObject({ sha: "97b10370e1dec2f7be3665646d9a7b088edb180e", submittedAt: Date.parse("2024-08-23T21:51:20Z") });
  // A request whose reviewer GitHub hides (null) doesn't count.
  expect(facts.requests).toEqual([
    { at: Date.parse("2024-06-02T10:28:21Z"), by: "wingleung", via: "user" },
    { at: Date.parse("2024-09-18T12:27:01Z"), by: "andyfeller", via: "user" },
  ]);
  expect(facts.commits).toHaveLength(3);
  expect(facts.commits.at(-1)).toBe(facts.headSha);
});

test("parsePrFacts finds the latest mention of another viewer in the captured response", () => {
  const facts = parsePrFacts(cli9083, [ref(9083)], "williammartin", noTeams).get("pr-9083")!;
  expect(facts.mention).toEqual({ at: Date.parse("2025-02-10T13:54:32Z"), by: "wingleung" });
});

test("myReviews drops pending and blank comment-only reviews, keeps blank reviews with new comments, oldest first", () => {
  const review = (id: string, state: string, submittedAt: string | null, body = "", comments: unknown[] = [], totalCount = comments.length) =>
    ({ id, state, submittedAt, body, commit: { oid: "c1" }, comments: { totalCount, nodes: comments } });
  const facts = one(pr({ reviews: { nodes: [
    review("late", "CHANGES_REQUESTED", "2026-10-03T00:00:00Z", "Please fix"),
    review("pending", "PENDING", null, "draft"),
    review("empty", "COMMENTED", "2026-10-02T00:00:00Z", "  "),
    review("replies", "COMMENTED", "2026-10-02T01:00:00Z", "", [{ replyTo: { id: "x" } }, { replyTo: { id: "y" } }]),
    review("new-thread", "COMMENTED", "2026-10-01T00:00:00Z", "", [{ replyTo: { id: "x" } }, { replyTo: null }]),
    review("dismissed", "DISMISSED", "2026-09-30T00:00:00Z", ""),
  ] } }));
  expect(facts.myReviews.map((r) => r.id)).toEqual(["dismissed", "new-thread", "late"]);
  expect(facts.myReviews[2]).toEqual({ id: "late", state: "CHANGES_REQUESTED", submittedAt: Date.parse("2026-10-03T00:00:00Z"), sha: "c1", body: "Please fix" });
});

test("requests match the viewer case-insensitively and teams the viewer is on", () => {
  const requested = (createdAt: string, actor: string, requestedReviewer: unknown) =>
    ({ __typename: "ReviewRequestedEvent", createdAt, actor: { login: actor }, requestedReviewer });
  const facts = one(pr({ events: { nodes: [
    requested("2026-10-01T00:00:00Z", "alice", user("ME")),
    requested("2026-10-02T00:00:00Z", "alice", team("Acme", "Web-Core")),
    requested("2026-10-03T00:00:00Z", "alice", team("acme", "infra")),
    requested("2026-10-04T00:00:00Z", "alice", user("someone")),
    { __typename: "ReviewRequestRemovedEvent", createdAt: "2026-10-05T00:00:00Z", actor: { login: "alice" }, requestedReviewer: user("me") },
  ] } }), "me", new Set(["acme/web-core"]));
  expect(facts.requests).toEqual([
    { at: Date.parse("2026-10-01T00:00:00Z"), by: "alice", via: "user" },
    { at: Date.parse("2026-10-02T00:00:00Z"), by: "alice", via: "team", team: "acme/web-core" },
  ]);
  expect(facts.requestRemovedAt).toBe(Date.parse("2026-10-05T00:00:00Z"));
});

test("requestPending prefers a direct request over a team one", () => {
  const pending = (...reviewers: unknown[]) => pr({ reviewRequests: { nodes: reviewers.map((requestedReviewer) => ({ requestedReviewer })) } });
  const teams = new Set(["acme/web-core"]);
  expect(one(pending(team("acme", "web-core"), user("Me")), "me", teams).requestPending).toEqual({ via: "user" });
  expect(one(pending(user("bob"), team("acme", "web-core")), "me", teams).requestPending).toEqual({ via: "team", team: "acme/web-core" });
  expect(one(pending(team("acme", "infra"), null), "me", teams).requestPending).toBeNull();
});

test("event times take the latest of each kind; dismissals count only for the viewer's reviews", () => {
  const ev = (__typename: string, createdAt: string, extra = {}) => ({ __typename, createdAt, ...extra });
  const facts = one(pr({ events: { nodes: [
    ev("ConvertToDraftEvent", "2026-10-01T00:00:00Z"), ev("ReadyForReviewEvent", "2026-10-02T00:00:00Z"),
    ev("ConvertToDraftEvent", "2026-10-03T00:00:00Z"), ev("HeadRefForcePushedEvent", "2026-10-04T00:00:00Z"),
    ev("ReviewDismissedEvent", "2026-10-05T00:00:00Z", { review: { author: { login: "Me" } } }),
    ev("ReviewDismissedEvent", "2026-10-06T00:00:00Z", { review: { author: { login: "bob" } } }),
  ] } }));
  expect(facts).toMatchObject({
    draftAt: Date.parse("2026-10-03T00:00:00Z"), readyAt: Date.parse("2026-10-02T00:00:00Z"),
    forcePushedAt: Date.parse("2026-10-04T00:00:00Z"), dismissedAt: Date.parse("2026-10-05T00:00:00Z"),
  });
});

test("otherOpinions leaves out the viewer, bots, and plain comments", () => {
  const opinion = (state: string, author: unknown) => ({ state, author });
  const facts = one(pr({ latestOpinionatedReviews: { nodes: [
    opinion("APPROVED", user("bob")), opinion("CHANGES_REQUESTED", user("carol")), opinion("APPROVED", user("ME")),
    opinion("CHANGES_REQUESTED", { __typename: "Bot", login: "copilot-pull-request-reviewer" }),
    opinion("APPROVED", { __typename: "User", login: "renovate[bot]" }), opinion("COMMENTED", user("dave")), opinion("APPROVED", null),
  ] } }));
  expect(facts.otherOpinions).toEqual([{ login: "bob", state: "APPROVED" }, { login: "carol", state: "CHANGES_REQUESTED" }]);
});

test("mention is the latest conversation comment by another person that mentions the viewer", () => {
  const comment = (author: unknown, body: string, createdAt: string) => ({ author, body, createdAt });
  const facts = one(pr({ conversation: { nodes: [
    comment(user("bob"), "cc @me", "2026-10-01T00:00:00Z"),
    comment(user("carol"), "@Me can you look?", "2026-10-02T00:00:00Z"),
    comment(user("me"), "@me note to self", "2026-10-03T00:00:00Z"),
    comment({ __typename: "Bot", login: "github-actions" }, "@me deploy ready", "2026-10-04T00:00:00Z"),
    comment(user("dependabot[bot]"), "@me bump", "2026-10-05T00:00:00Z"),
    comment(user("dave"), "mail me@me.dev", "2026-10-06T00:00:00Z"),
    comment(null, "@me ghost", "2026-10-07T00:00:00Z"),
  ] } }));
  expect(facts.mention).toEqual({ at: Date.parse("2026-10-02T00:00:00Z"), by: "carol" });
});

test("mentions matches a whole handle only", () => {
  for (const body of ["@me", "hey @me.", "(@ME)", "@me, thoughts?", "line\n@me: see", "**@me**"]) expect(mentions(body, "me"), body).toBe(true);
  for (const body of ["me@me.com", "@meow", "@me-two", "@me_x", "email@me", "@@me", "@me/reviewers", "@org/me", "me"]) expect(mentions(body, "me"), body).toBe(false);
  expect(mentions("thanks @octo-cat!", "octo-cat")).toBe(true);
});

test("ci maps the head commit's rollup state", () => {
  const ci = (state: string | null) => one(pr({ head: { nodes: [{ commit: { statusCheckRollup: state ? { state } : null } }] } })).ci;
  expect([ci("SUCCESS"), ci("FAILURE"), ci("ERROR"), ci("PENDING"), ci("EXPECTED"), ci(null)]).toEqual(["pass", "fail", "fail", "pending", "pending", "none"]);
  expect(one(pr({ head: { nodes: [] } })).ci).toBe("none");
});

test("a PR or repository GitHub can't find maps to null and the rest of the batch is kept", () => {
  const refs = [ref(1), ref(99999999), ref(3, "ghost/none")];
  const json = {
    data: { p0: { pullRequest: pr() }, p1: { pullRequest: null }, p2: null },
    errors: [
      { type: "NOT_FOUND", path: ["p1", "pullRequest"], message: "Could not resolve to a PullRequest with the number of 99999999." },
      { type: "NOT_FOUND", path: ["p2"], message: "Could not resolve to a Repository with the name 'ghost/none'." },
    ],
  };
  const facts = parsePrFacts(json, refs, "me", noTeams);
  expect(facts.get("pr-1")).toMatchObject({ headSha: "c3", commits: ["c1", "c2", "c3"], ci: "pass" });
  expect(facts.get("pr-99999999")).toBeNull();
  expect(facts.get("pr-3")).toBeNull();
});

test("a PR that failed for another reason is left out rather than reported missing", () => {
  const json = { data: { p0: null, p1: { pullRequest: pr() } }, errors: [{ type: "FORBIDDEN", path: ["p0"], message: "SAML enforcement" }] };
  const facts = parsePrFacts(json, [ref(1, "sso/repo"), ref(2)], "me", noTeams);
  expect(facts.has("pr-1")).toBe(false);
  expect(facts.get("pr-2")).not.toBeNull();
});

test("parsePrFacts rejects a response without data", () => {
  expect(() => parsePrFacts({ errors: [{ message: "API rate limit exceeded" }] }, [ref(1)], "me", noTeams)).toThrow();
  expect(() => parsePrFacts(null, [ref(1)], "me", noTeams)).toThrow();
});

test("fetchPrFacts sends one query per batch of ten", async () => {
  const refs = Array.from({ length: 23 }, (_, i) => ref(i + 1));
  const run = vi.fn(async (args: string[]) => {
    const count = args.filter((a) => /^n\d+=/.test(a)).length;
    const data = Object.fromEntries(Array.from({ length: count }, (_, i) => [`p${i}`, { pullRequest: pr() }]));
    return { code: 0, stderr: "", stdout: JSON.stringify({ data }) };
  });
  const facts = await fetchPrFacts(run, refs, "me", noTeams);
  expect(BATCH_SIZE).toBe(10);
  expect(run).toHaveBeenCalledTimes(3);
  expect(facts.size).toBe(23);
  const [args] = run.mock.calls[2];
  expect(args.slice(0, 2)).toEqual(["api", "graphql"]);
  expect(args).toContain("viewer=me");
  expect(args[args.indexOf("n2=23") - 1]).toBe("-F");
  expect(args[args.indexOf("o2=cli") - 1]).toBe("-f");
  expect(args.filter((a) => /^n\d+=/.test(a))).toEqual(["n0=21", "n1=22", "n2=23"]);
});

test("fetchPrFacts reads partial data from a non-zero gh exit", async () => {
  const run = vi.fn(async () => ({ code: 1, stderr: "gh: Could not resolve to a PullRequest with the number of 2.", stdout: JSON.stringify({
    data: { p0: { pullRequest: pr() }, p1: { pullRequest: null } },
    errors: [{ type: "NOT_FOUND", path: ["p1", "pullRequest"] }],
  }) }));
  const facts = await fetchPrFacts(run, [ref(1), ref(2)], "me", noTeams);
  expect(facts.get("pr-1")).toMatchObject({ number: 1 });
  expect(facts.get("pr-2")).toBeNull();
});

test("fetchPrFacts rejects on a transport failure", async () => {
  const run = vi.fn(async () => ({ code: 1, stderr: "error connecting to api.github.com", stdout: "" }));
  await expect(fetchPrFacts(run, [ref(1)], "me", noTeams)).rejects.toThrow(/error connecting/);
});
