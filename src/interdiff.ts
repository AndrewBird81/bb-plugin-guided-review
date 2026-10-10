import { splitPatchByFile } from "./patch";
import { withoutBaseBlob } from "./diff-hash";

export interface FileInterdiff {
  file: string;
  /** unchanged: the file's PR change is the same. changed: some hunks differ. added: in the PR now but not at your review. removed: in the PR at your review but not now. */
  status: "unchanged" | "changed" | "added" | "removed";
  /** New-file (RIGHT) line numbers, in the current diff, of added lines that weren't added at your review. */
  newLines: number[];
  /** Old-file (LEFT) line numbers, in the current diff, of deleted lines that weren't deleted at your review. */
  newDeletions: number[];
  /** A valid single-file unified diff (the file's current headers + only the current hunks that changed since your review). The whole current file diff for "added"; "" for "unchanged" and "removed". It must parse with splitPatchByFile/diffPositions like a gh diff. */
  patch: string;
  /** Hunks of the reviewed diff that no longer appear (reverted or rewritten), as diff text with that file's reviewed headers; "" when none. For "removed", the whole reviewed file diff. */
  dropped: string;
}

interface DiffLine { line: number; text: string }
interface Hunk {
  text: string;
  /** The hunk's change lines (sign + text): its identity across rebases. */
  key: string;
  adds: DiffLine[];
  dels: DiffLine[];
}
interface ParsedFile { path: string; text: string; headers: string; hunks: Hunk[] }

function parseHunk(lines: string[]): Hunk {
  const h = lines[0].match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
  let oldLine = h ? Number(h[1]) : 0;
  let newLine = h ? Number(h[2]) : 0;
  const adds: DiffLine[] = [];
  const dels: DiffLine[] = [];
  const changes: string[] = [];
  for (const line of lines.slice(1)) {
    const c = line[0];
    if (c === "+") adds.push({ line: newLine++, text: line.slice(1) });
    else if (c === "-") dels.push({ line: oldLine++, text: line.slice(1) });
    else if (c === " ") {
      newLine++;
      oldLine++;
    }
    if (c === "+" || c === "-") changes.push(line);
  }
  return { text: lines.join("\n") + "\n", key: changes.join("\n"), adds, dels };
}

function parseFiles(patch: string): Map<string, ParsedFile> {
  const files = new Map<string, ParsedFile>();
  for (const f of splitPatchByFile(patch)) {
    if (!f.path) continue;
    const lines = f.text.replace(/\n+$/, "").split("\n");
    const starts = lines.flatMap((l, i) => (l.startsWith("@@") ? [i] : []));
    const end = starts[0] ?? lines.length;
    const hunks = starts.map((s, i) => parseHunk(lines.slice(s, starts[i + 1] ?? lines.length)));
    files.set(f.path, { path: f.path, text: f.text, headers: lines.slice(0, end).join("\n") + "\n", hunks });
  }
  return files;
}

/** Indexes into `current` of items not in an order-preserving LCS with `reviewed`. */
function unmatched(reviewed: string[], current: string[]): number[] {
  let lo = 0;
  while (lo < reviewed.length && lo < current.length && reviewed[lo] === current[lo]) lo++;
  let rEnd = reviewed.length;
  let cEnd = current.length;
  while (rEnd > lo && cEnd > lo && reviewed[rEnd - 1] === current[cEnd - 1]) {
    rEnd--;
    cEnd--;
  }
  const r = reviewed.slice(lo, rEnd);
  const c = current.slice(lo, cEnd);
  const n = r.length;
  const m = c.length;
  if (!m) return [];
  if (n * m > 4e6) {
    // Too big for LCS: match by multiset instead.
    const counts = new Map<string, number>();
    for (const t of r) counts.set(t, (counts.get(t) ?? 0) + 1);
    return c.flatMap((t, j) => {
      const k = counts.get(t) ?? 0;
      if (k) counts.set(t, k - 1);
      return k ? [] : [lo + j];
    });
  }
  // dp[i*(m+1)+j] = LCS length of r[i..] and c[j..].
  const w = m + 1;
  const dp = new Uint32Array((n + 1) * w);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i * w + j] = r[i] === c[j] ? dp[(i + 1) * w + j + 1] + 1 : Math.max(dp[(i + 1) * w + j], dp[i * w + j + 1]);
    }
  }
  const out: number[] = [];
  let i = 0;
  let j = 0;
  while (j < m) {
    if (i < n && r[i] === c[j]) {
      i++;
      j++;
    } else if (i < n && dp[(i + 1) * w + j] >= dp[i * w + j + 1]) i++;
    else out.push(lo + j++);
  }
  return out;
}

function newOf(reviewed: DiffLine[], current: DiffLine[]): number[] {
  return unmatched(reviewed.map((l) => l.text), current.map((l) => l.text)).map((j) => current[j].line);
}

function compareFile(before: ParsedFile, now: ParsedFile): FileInterdiff {
  const file = now.path;
  if (!before.hunks.length || !now.hunks.length) {
    // Binary, mode-only or pure rename: no change lines to compare.
    const same = withoutBaseBlob(before.text) === withoutBaseBlob(now.text);
    return { file, status: same ? "unchanged" : "changed", newLines: [], newDeletions: [], patch: same ? "" : now.text, dropped: "" };
  }
  const left = [...before.hunks];
  const changed = now.hunks.filter((h) => {
    const i = left.findIndex((r) => r.key === h.key);
    if (i < 0) return true;
    left.splice(i, 1);
    return false;
  });
  if (!changed.length && !left.length) {
    return { file, status: "unchanged", newLines: [], newDeletions: [], patch: "", dropped: "" };
  }
  // Matched hunks are identical on both sides, so only unmatched ones can hold new lines.
  return {
    file,
    status: "changed",
    newLines: newOf(left.flatMap((h) => h.adds), changed.flatMap((h) => h.adds)),
    newDeletions: newOf(left.flatMap((h) => h.dels), changed.flatMap((h) => h.dels)),
    patch: changed.length ? now.headers + changed.map((h) => h.text).join("") : "",
    dropped: left.length ? before.headers + left.map((h) => h.text).join("") : "",
  };
}

/** One entry per file in either diff: the current diff's files in order, then files removed since. */
export function interdiff(reviewedPatch: string, currentPatch: string): FileInterdiff[] {
  const reviewed = parseFiles(reviewedPatch);
  const current = parseFiles(currentPatch);
  const out: FileInterdiff[] = [];
  for (const now of current.values()) {
    const before = reviewed.get(now.path);
    if (before) out.push(compareFile(before, now));
    else {
      const adds = now.hunks.flatMap((h) => h.adds.map((l) => l.line));
      const dels = now.hunks.flatMap((h) => h.dels.map((l) => l.line));
      out.push({ file: now.path, status: "added", newLines: adds, newDeletions: dels, patch: now.text, dropped: "" });
    }
  }
  for (const before of reviewed.values()) {
    if (!current.has(before.path)) {
      out.push({ file: before.path, status: "removed", newLines: [], newDeletions: [], patch: "", dropped: before.text });
    }
  }
  return out;
}

/** A plain-text report for an AI assistant: a summary line (counts of changed/added/removed/unchanged files), then for each changed/added/removed file (or only `file`): a header, its `patch`, and "Gone since your review:" + `dropped` when present. Truncated at maxChars (default 60_000) with a note saying how to ask for one file. "No changes since your review." when nothing changed. */
export function describeInterdiff(files: FileInterdiff[], options: { file?: string; maxChars?: number } = {}): string {
  const count = (s: FileInterdiff["status"]) => files.filter((f) => f.status === s).length;
  if (files.every((f) => f.status === "unchanged")) return "No changes since your review.";
  const shown = files.filter((f) => f.status !== "unchanged" && (options.file == null || f.file === options.file));
  if (options.file != null && !shown.length) return `No changes to ${options.file} since your review.`;
  const parts = [
    `Since your review: ${count("changed")} changed, ${count("added")} added, ${count("removed")} removed, ${count("unchanged")} unchanged files.`,
  ];
  for (const f of shown) {
    parts.push(`=== ${f.file} (${f.status}) ===`);
    if (f.patch) parts.push(f.patch.trimEnd());
    if (f.dropped) parts.push("Gone since your review:\n" + f.dropped.trimEnd());
  }
  const text = parts.join("\n\n");
  const maxChars = options.maxChars ?? 60_000;
  if (text.length <= maxChars) return text;
  const cut = text.slice(0, maxChars);
  const nl = cut.lastIndexOf("\n");
  return `${nl > 0 ? cut.slice(0, nl) : cut}\n\n[Truncated at ${maxChars} characters. Ask for one file's changes since your review by its path to see it in full.]`;
}
