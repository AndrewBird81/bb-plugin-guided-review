import { createHash } from "node:crypto";

/**
 * Stable content hash of a single file's diff text, used to detect when a file
 * changed since the reviewer last marked it "Viewed" (GitHub-style
 * auto-uncheck on re-review). Computed server-side from the stored patch so the
 * browser never needs SubtleCrypto in its render path.
 */
export function hashFileDiff(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/**
 * A file diff's `index` line minus the base-side blob SHA: `index a1..b2 100644`
 * → `index b2 100644`. The post-image blob identifies the PR's version of the
 * file, so a rebase (new base blob) keeps it while a replaced binary changes it.
 */
export function withoutBaseBlob(text: string): string {
  return text.replace(/^index [0-9a-f]+\.\.([0-9a-f]+)/m, "index $1");
}

/**
 * Rebase-proof hash of a single file's diff: only its change lines (sign +
 * content), so shifted @@ numbers, new `index` SHAs and changed context lines
 * don't count as a change. Diffs without change lines (binary, mode-only, pure
 * rename) hash their text minus the base-side blob SHA.
 */
export function normalizedFileHash(text: string): string {
  const lines = text.split("\n");
  const start = lines.findIndex((l) => l.startsWith("@@"));
  const changes = start < 0 ? [] : lines.slice(start).filter((l) => l[0] === "+" || l[0] === "-");
  return hashFileDiff(changes.length ? changes.join("\n") : withoutBaseBlob(text));
}
