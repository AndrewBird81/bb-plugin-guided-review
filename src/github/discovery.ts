// Finds open PRs that ask for the viewer's review or that the viewer has reviewed.
import type { DiscoveredPr, RunGh } from "./types";

const QUERY = `query($q:String!){search(type:ISSUE,first:50,query:$q){nodes{
  ... on PullRequest{number title url isDraft updatedAt author{login} repository{nameWithOwner}}
}}}`;
const REQUESTED = "is:pr is:open archived:false review-requested:@me";
const REVIEWED = "is:pr is:open archived:false reviewed-by:@me -author:@me";

async function search(run: RunGh, q: string): Promise<any[]> {
  const out = await run(["api", "graphql", "-f", `query=${QUERY}`, "-f", `q=${q}`]);
  let json: any;
  try { json = JSON.parse(out.stdout); } catch { json = null; }
  if (out.code !== 0 || !json?.data?.search) throw new Error(`Could not search pull requests: ${out.stderr.trim() || `gh exited ${out.code}`}`);
  return json.data.search.nodes.filter((n: any) => n?.repository?.nameWithOwner && n.number);
}

/** Up to 50 PRs per search, merged by repo and number; a failed search rejects. */
export async function discoverPrs(run: RunGh, options: { reviewed: boolean }): Promise<DiscoveredPr[]> {
  const [requested, reviewed] = await Promise.all([search(run, REQUESTED), options.reviewed ? search(run, REVIEWED) : []]);
  const prs = new Map<string, DiscoveredPr>();
  const add = (n: any, flag: "requested" | "reviewed") => {
    const repo = String(n.repository.nameWithOwner).toLowerCase();
    const key = `${repo}#${n.number}`;
    const pr = prs.get(key) ?? {
      repo, number: n.number, title: n.title ?? "", url: n.url ?? "", author: n.author?.login ?? null,
      updatedAt: Date.parse(n.updatedAt), isDraft: !!n.isDraft, requested: false, reviewed: false,
    };
    pr[flag] = true;
    prs.set(key, pr);
  };
  for (const n of requested) add(n, "requested");
  for (const n of reviewed) add(n, "reviewed");
  return [...prs.values()];
}
