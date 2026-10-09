import type { AgentMessageContext } from "./store";
import { splitPatchByFile } from "./patch";

const MAX_QUOTE = 40_000;

/** A short label for a reviewer's file or selection, such as `api.ts:10–12`. */
export function contextLabel(context: AgentMessageContext): string {
  if (!context.file) return "whole change";
  const name = context.file.split("/").pop() ?? context.file;
  if (context.startLine == null) return name;
  return `${name}:${context.startLine}${context.endLine != null && context.endLine !== context.startLine ? `–${context.endLine}` : ""}`;
}

/**
 * Extract exactly the lines a reviewer selected (by 1-based line number on the
 * new or old side) from a file's unified diff, keeping the +/-/space prefixes.
 * Walks each hunk tracking old/new line counters. Returns "" if nothing matches.
 */
export function extractSelectedLines(
  patch: string,
  file: string,
  start: number,
  end: number,
  side: "additions" | "deletions" = "additions",
): string {
  const f = splitPatchByFile(patch).find((x) => x.path === file);
  if (!f) return "";
  const lo = Math.min(start, end);
  const hi = Math.max(start, end);
  const wantOld = side === "deletions";
  const out: string[] = [];
  let oldLine = 0;
  let newLine = 0;
  for (const line of f.text.split("\n")) {
    const h = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (h) {
      oldLine = Number(h[1]);
      newLine = Number(h[2]);
      continue;
    }
    if (/^(diff --git|index |--- |\+\+\+ )/.test(line)) continue;
    const c = line[0];
    if (c === "+") {
      if (!wantOld && newLine >= lo && newLine <= hi) out.push(line);
      newLine++;
    } else if (c === "-") {
      if (wantOld && oldLine >= lo && oldLine <= hi) out.push(line);
      oldLine++;
    } else if (c === " ") {
      const n = wantOld ? oldLine : newLine;
      if (n >= lo && n <= hi) out.push(line);
      newLine++;
      oldLine++;
    }
    // else: blank / "\ No newline" / artifact — skip without counting.
  }
  return out.join("\n");
}

/**
 * The reviewer's file or selection as a quote in their own message. A file
 * alone is named, not inlined; the assistant reads it with read_review_patch.
 */
export function contextQuote(context: AgentMessageContext, patch: string): string {
  if (!context.file) return "";
  const range = context.startLine == null ? ""
    : context.endLine != null && context.endLine !== context.startLine ? ` lines ${context.startLine}-${context.endLine}` : ` line ${context.startLine}`;
  if (context.code?.trim()) return `In \`${context.file}\`${range}:\n\`\`\`\n${context.code}\n\`\`\``;
  if (context.startLine != null) {
    const lines = extractSelectedLines(patch, context.file, context.startLine, context.endLine ?? context.startLine, context.side).slice(0, MAX_QUOTE);
    if (lines.trim()) return `In \`${context.file}\`${range}:\n\`\`\`diff\n${lines}\n\`\`\``;
  }
  return `About \`${context.file}\`${range}.`;
}
