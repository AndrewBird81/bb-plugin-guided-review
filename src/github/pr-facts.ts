// Batched reads of the PR facts the turn rules need, one aliased GraphQL query per batch.
import type { MyReview, PrFacts, PrRef, ReviewRequestEvent, ReviewState, RunGh } from "./types";

export const BATCH_SIZE = 10;

const REVIEWER = "__typename ... on User{login} ... on Team{slug organization{login}}";
const FRAGMENT = `fragment F on PullRequest{
  number state isDraft updatedAt title url baseRefName headRefName headRefOid author{login}
  commits(last:100){nodes{commit{oid}}}
  head:commits(last:1){nodes{commit{statusCheckRollup{state}}}}
  latestOpinionatedReviews(first:50){nodes{state author{__typename login}}}
  reviewRequests(first:50){nodes{requestedReviewer{${REVIEWER}}}}
  reviews(last:30,author:$viewer){nodes{id state submittedAt body commit{oid} comments(first:20){totalCount nodes{replyTo{id}}}}}
  events:timelineItems(last:30,itemTypes:[REVIEW_REQUESTED_EVENT,REVIEW_REQUEST_REMOVED_EVENT]){nodes{__typename
    ... on ReviewRequestedEvent{createdAt actor{login} requestedReviewer{${REVIEWER}}}
    ... on ReviewRequestRemovedEvent{createdAt actor{login} requestedReviewer{${REVIEWER}}}}}
  conversation:timelineItems(last:15,itemTypes:[ISSUE_COMMENT]){nodes{... on IssueComment{author{__typename login} body createdAt}}}
}`;

export function prFactsQuery(refs: PrRef[]): { query: string; variables: Record<string, string | number> } {
  const variables: Record<string, string | number> = {};
  const params = ["$viewer:String!"];
  const fields = refs.map((ref, i) => {
    const [owner, name] = ref.repo.split("/");
    Object.assign(variables, { [`o${i}`]: owner, [`r${i}`]: name, [`n${i}`]: ref.number });
    params.push(`$o${i}:String!`, `$r${i}:String!`, `$n${i}:Int!`);
    return `p${i}:repository(owner:$o${i},name:$r${i}){pullRequest(number:$n${i}){...F}}`;
  });
  return { query: `query(${params.join(",")}){\n${fields.join("\n")}\n}\n${FRAGMENT}`, variables };
}

/**
 * Normalizes one batch's response. A PR GitHub reports NOT_FOUND (or returns null for) maps to null;
 * a PR whose alias failed for another reason (say, SSO or permissions) is left out of the map.
 */
export function parsePrFacts(json: unknown, refs: PrRef[], viewer: string, teams: ReadonlySet<string>): Map<string, PrFacts | null> {
  const root = json as { data?: Record<string, any> | null; errors?: Array<{ type?: string; path?: unknown[] }> } | null;
  if (!root || typeof root !== "object" || !root.data || typeof root.data !== "object") throw new Error("GitHub returned no PR data");
  const failed = new Set((root.errors ?? []).filter((e) => e.type !== "NOT_FOUND").map((e) => String(e.path?.[0] ?? "")));
  const result = new Map<string, PrFacts | null>();
  refs.forEach((ref, i) => {
    if (failed.has(`p${i}`)) return;
    const pr = root.data![`p${i}`]?.pullRequest;
    result.set(ref.targetKey, pr ? normalize(pr, ref, viewer, teams) : null);
  });
  return result;
}

/**
 * Batches by BATCH_SIZE through `gh api graphql`. A PR GitHub can't find maps to null; a batch that
 * fails leaves its PRs out of the map, and only when every batch fails does this reject.
 */
export async function fetchPrFacts(run: RunGh, refs: PrRef[], viewer: string, teams: ReadonlySet<string>): Promise<Map<string, PrFacts | null>> {
  const result = new Map<string, PrFacts | null>();
  let failure: Error | null = null;
  let read = 0;
  for (let i = 0; i < refs.length; i += BATCH_SIZE) {
    const batch = refs.slice(i, i + BATCH_SIZE);
    const { query, variables } = prFactsQuery(batch);
    const args = ["api", "graphql", "-f", `query=${query}`, "-f", `viewer=${viewer}`];
    for (const [key, value] of Object.entries(variables)) args.push(typeof value === "number" ? "-F" : "-f", `${key}=${value}`);
    try {
      // `gh` exits non-zero when GraphQL reports any error, even with partial data on stdout.
      const out = await run(args);
      let json: unknown;
      try { json = JSON.parse(out.stdout); } catch { throw new Error(`Could not read PR facts: ${out.stderr.trim() || `gh exited ${out.code}`}`); }
      for (const [key, facts] of parsePrFacts(json, batch, viewer, teams)) result.set(key, facts);
      read++;
    } catch (error) {
      failure = error instanceof Error ? error : new Error(String(error));
    }
  }
  if (failure && !read) throw failure;
  return result;
}

const same = (a: string | null | undefined, b: string) => !!a && a.toLowerCase() === b.toLowerCase();
const time = (iso: string | null | undefined) => (iso ? Date.parse(iso) : NaN);
const latest = (times: number[]) => (times.length ? Math.max(...times) : null);
const isBot = (author: { __typename?: string; login?: string } | null | undefined) =>
  author?.__typename === "Bot" || !!author?.login?.toLowerCase().endsWith("[bot]");

/** Whether `body` mentions `@viewer` as a whole handle, not inside an email or a longer handle. */
export function mentions(body: string, viewer: string): boolean {
  const handle = viewer.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?<![A-Za-z0-9_.+\\-/@])@${handle}(?![A-Za-z0-9_\\-]|/[A-Za-z0-9])`, "i").test(body);
}

/** How a requested reviewer reaches the viewer: directly, or through a team the viewer is on. */
function via(reviewer: any, viewer: string, teams: ReadonlySet<string>): { via: "user" | "team"; team?: string } | null {
  if (reviewer?.__typename === "User" && same(reviewer.login, viewer)) return { via: "user" };
  if (reviewer?.__typename === "Team") {
    const team = `${reviewer.organization?.login ?? ""}/${reviewer.slug ?? ""}`.toLowerCase();
    if (teams.has(team)) return { via: "team", team };
  }
  return null;
}

function realReview(r: any): boolean {
  if (r.state === "PENDING" || !r.submittedAt) return false;
  if (r.state !== "COMMENTED" || (r.body ?? "").trim()) return true;
  const comments = r.comments?.nodes ?? [];
  // A blank COMMENTED review with no comments, or only replies to existing threads, isn't a review round.
  return (r.comments?.totalCount ?? 0) > 0 && !comments.every((c: any) => c?.replyTo);
}

const CI: Record<string, PrFacts["ci"]> = { SUCCESS: "pass", FAILURE: "fail", ERROR: "fail", PENDING: "pending", EXPECTED: "pending" };

function normalize(pr: any, ref: PrRef, viewer: string, teams: ReadonlySet<string>): PrFacts {
  const events: any[] = (pr.events?.nodes ?? []).filter(Boolean);
  const at = (type: string, keep: (e: any) => boolean = () => true) =>
    latest(events.filter((e) => e.__typename === type && keep(e)).map((e) => time(e.createdAt)).filter(Number.isFinite));

  const myReviews: MyReview[] = (pr.reviews?.nodes ?? []).filter((r: any) => r && realReview(r))
    .map((r: any) => ({ id: r.id, state: r.state as ReviewState, submittedAt: time(r.submittedAt), sha: r.commit?.oid ?? null, body: r.body ?? "" }))
    .sort((a: MyReview, b: MyReview) => a.submittedAt - b.submittedAt);

  const requests: ReviewRequestEvent[] = [];
  for (const e of events) {
    if (e.__typename !== "ReviewRequestedEvent") continue;
    const match = via(e.requestedReviewer, viewer, teams);
    if (match) requests.push({ at: time(e.createdAt), by: e.actor?.login ?? null, ...match });
  }
  requests.sort((a, b) => a.at - b.at);

  const pending = (pr.reviewRequests?.nodes ?? []).map((n: any) => via(n?.requestedReviewer, viewer, teams)).filter(Boolean);
  const requestPending = pending.find((p: any) => p.via === "user") ?? pending[0] ?? null;

  const conversation: any[] = (pr.conversation?.nodes ?? []).filter((c: any) => c?.author);
  // Your own comment answers the mentions before it.
  const answered = latest(conversation.filter((c) => same(c.author.login, viewer)).map((c) => time(c.createdAt)).filter(Number.isFinite)) ?? 0;
  const mention = conversation
    .filter((c) => !same(c.author.login, viewer) && !isBot(c.author) && mentions(c.body ?? "", viewer) && time(c.createdAt) > answered)
    .map((c) => ({ at: time(c.createdAt), by: c.author.login as string }))
    .sort((a, b) => b.at - a.at)[0] ?? null;

  const otherOpinions = (pr.latestOpinionatedReviews?.nodes ?? [])
    .filter((r: any) => r?.author && !same(r.author.login, viewer) && !isBot(r.author) && (r.state === "APPROVED" || r.state === "CHANGES_REQUESTED"))
    .map((r: any) => ({ login: r.author.login as string, state: r.state as "APPROVED" | "CHANGES_REQUESTED" }));

  return {
    targetKey: ref.targetKey, repo: ref.repo, number: pr.number ?? ref.number,
    state: pr.state, isDraft: !!pr.isDraft, title: pr.title ?? "", url: pr.url ?? "", author: pr.author?.login ?? null,
    baseRefName: pr.baseRefName ?? "", headRefName: pr.headRefName ?? "", headSha: pr.headRefOid ?? "",
    updatedAt: time(pr.updatedAt),
    ci: CI[pr.head?.nodes?.[0]?.commit?.statusCheckRollup?.state] ?? "none",
    myReviews, otherOpinions, requests, requestPending,
    requestRemovedAt: at("ReviewRequestRemovedEvent", (e) => !!via(e.requestedReviewer, viewer, teams)),
    mention,
    commits: (pr.commits?.nodes ?? []).map((n: any) => n?.commit?.oid).filter(Boolean),
  };
}
