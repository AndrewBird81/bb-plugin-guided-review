import type { Store } from "./store";
import { parseTarget, targetKey } from "./targets";
import { addComment, deleteComment, describeComments, editComment, listComments, type DraftResult } from "./draft-comments";

export const COMMENT_USAGE = [
  "usage: bb review comment list   <review> [--json]",
  "       bb review comment add    <review> <file>:<line> --code <text> --body <text> [--side LEFT|RIGHT]",
  "       bb review comment edit   <review> <file>:<line> --body <text> [--side LEFT|RIGHT]",
  "       bb review comment delete <review> <file>:<line> [--side LEFT|RIGHT]",
  "",
  "Changes a review's local draft in this bb. Nothing is posted to GitHub; the reviewer submits the draft from Guided Review.",
  "  <review>       a GitHub PR URL, or a review key (pr-…, ref-…)",
  "  <file>:<line>  the line's number in the new file, or with --side LEFT, in the old file",
  "  --code         the line's text, without the diff's +, -, or space; add refuses a line that doesn't match",
  "  --body         the comment, in GitHub Markdown; quote it for your shell",
].join("\n");

const ACTIONS = {
  list: { location: false, options: ["json"] },
  add: { location: true, options: ["side", "code", "body"] },
  edit: { location: true, options: ["side", "body"] },
  delete: { location: true, options: ["side"] },
} as const;

type CliResult = { exitCode: number; stdout?: string; stderr?: string };
const usage = (problem: string): CliResult => ({ exitCode: 2, stderr: `${problem}\n${COMMENT_USAGE}` });

/** `bb review comment …`: list and change a review's draft comments. `changed` runs after a successful change. */
export function runCommentCommand(store: Store, argv: string[], changed: (targetKey: string) => void): CliResult {
  const [action, ...rest] = argv;
  if (action === "--help" || action === "-h") return { exitCode: 0, stdout: COMMENT_USAGE };
  if (!action || !(action in ACTIONS)) return usage(action ? `Unknown action: ${action}` : "Choose list, add, edit, or delete.");
  const spec = ACTIONS[action as keyof typeof ACTIONS];
  const positional: string[] = [];
  const values: { side?: string; code?: string; body?: string; json?: string } = {};
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (arg === "--help" || arg === "-h") return { exitCode: 0, stdout: COMMENT_USAGE };
    if (!arg.startsWith("--")) { positional.push(arg); continue; }
    const name = arg.slice(2) as keyof typeof values;
    if (!(spec.options as readonly string[]).includes(name)) return usage(`${action} doesn't take ${arg}.`);
    if (values[name] !== undefined) return usage(`${arg} is given twice.`);
    if (name === "json") { values.json = ""; continue; }
    if (i + 1 >= rest.length) return usage(`${arg} needs a value.`);
    values[name] = rest[++i];
  }
  if (positional.length !== (spec.location ? 2 : 1)) return usage(spec.location ? "Give the review and the comment's <file>:<line>." : "Give the review.");

  const target = parseTarget(positional[0]);
  const key = target.kind === "pr" && target.repo ? targetKey(target) : positional[0].trim();
  if (!store.getReview(key)) return { exitCode: 1, stderr: `No saved review for ${positional[0]}. Pass the PR's URL or the review's key.` };
  if (action === "list") {
    return { exitCode: 0, stdout: values.json === undefined ? describeComments(store, key) : JSON.stringify({ review: key, comments: listComments(store, key) }, null, 2) };
  }

  const at = positional[1].match(/^(.+):([1-9]\d*)$/);
  if (!at) return usage(`${positional[1]} isn't a <file>:<line>.`);
  const side = values.side?.toUpperCase();
  if (side !== undefined && side !== "LEFT" && side !== "RIGHT") return usage("--side is LEFT or RIGHT.");
  const location = { file: at[1], line: Number(at[2]), ...(side ? { side: side as "LEFT" | "RIGHT" } : {}) };
  if (action === "add" && values.code === undefined) return usage("add needs --code with the line's text.");
  if (action !== "delete" && !values.body?.trim()) return usage(`${action} needs --body with the comment's text.`);
  const result: DraftResult = action === "add" ? addComment(store, key, { ...location, code: values.code!, body: values.body! })
    : action === "edit" ? editComment(store, key, { ...location, body: values.body! })
    : deleteComment(store, key, location);
  if (!result.ok) return { exitCode: 1, stderr: result.error };
  changed(key);
  return { exitCode: 0, stdout: result.text };
}
