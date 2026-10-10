// A cheap gate before a full sync: has anything the viewer participates in changed on GitHub?
// Read-only: a conditional GET that never marks notifications read.
import type { RunGh } from "./types";

export type GateResult =
  | { kind: "changed"; prs: Array<{ repo: string; number: number; reason: string; updatedAt: number }> }
  | { kind: "unchanged" }
  | { kind: "unsupported" };

export interface NotificationGate { poll(): Promise<GateResult> }

const ENDPOINT = "notifications?participating=true&per_page=50";
const UNSUPPORTED_MS = 60 * 60_000;
const PR_URL = /^https:\/\/api\.github\.com\/repos\/([^/]+)\/([^/]+)\/pulls\/(\d+)$/;

/** Splits `gh api -i` output into status, lowercase headers, and body. */
export function parseIncludeOutput(stdout: string): { status: number; headers: Map<string, string>; body: string } | null {
  const match = /^HTTP\/[\d.]+ (\d{3})[^\n]*\n([\s\S]*?)\r?\n\r?\n([\s\S]*)$/.exec(stdout) ?? /^HTTP\/[\d.]+ (\d{3})[^\n]*\n?([\s\S]*)$/.exec(stdout);
  if (!match) return null;
  const headers = new Map<string, string>();
  for (const line of match[2].split(/\r?\n/)) {
    const colon = line.indexOf(":");
    if (colon > 0) headers.set(line.slice(0, colon).trim().toLowerCase(), line.slice(colon + 1).trim());
  }
  return { status: Number(match[1]), headers, body: match[3] ?? "" };
}

function changedPrs(body: string): Extract<GateResult, { kind: "changed" }>["prs"] {
  const items: any[] = JSON.parse(body);
  return items.flatMap((n) => {
    const url = n?.subject?.type === "PullRequest" ? PR_URL.exec(n.subject.url ?? "") : null;
    return url ? [{ repo: `${url[1]}/${url[2]}`.toLowerCase(), number: Number(url[3]), reason: String(n.reason ?? ""), updatedAt: Date.parse(n.updated_at) }] : [];
  });
}

/**
 * GETs the viewer's participating notifications, conditionally after the first call. Honors
 * X-Poll-Interval; a token that can't read notifications reports unsupported for an hour.
 * Any other failure rejects.
 */
export function createNotificationGate(run: RunGh, now: () => number = Date.now): NotificationGate {
  let lastModified: string | null = null;
  let lastRequestAt: number | null = null;
  let intervalMs = 0;
  let unsupportedUntil = 0;
  return {
    async poll() {
      const t = now();
      if (t < unsupportedUntil) return { kind: "unsupported" };
      if (lastRequestAt !== null && t - lastRequestAt < intervalMs) return { kind: "unchanged" };
      lastRequestAt = t;
      const args = ["api", "-i", ...(lastModified ? ["-H", `If-Modified-Since: ${lastModified}`] : []), ENDPOINT];
      const out = await run(args);
      const response = parseIncludeOutput(out.stdout);
      const ok = response?.status === 200 || response?.status === 304;
      if (!ok && ([401, 403, 404].includes(response?.status ?? 0) || /scope/i.test(`${out.stderr}\n${response?.body ?? ""}`))) {
        unsupportedUntil = t + UNSUPPORTED_MS;
        return { kind: "unsupported" };
      }
      if (!response) throw new Error(`Could not read notifications: ${out.stderr.trim() || `gh exited ${out.code}`}`);
      const poll = Number(response.headers.get("x-poll-interval"));
      if (poll > 0) intervalMs = poll * 1000;
      // gh exits 1 on a 304, with the status line and headers still on stdout.
      if (response.status === 304) return { kind: "unchanged" };
      if (response.status !== 200) throw new Error(`Could not read notifications: HTTP ${response.status}`);
      const prs = changedPrs(response.body);
      lastModified = response.headers.get("last-modified") ?? lastModified;
      return { kind: "changed", prs };
    },
  };
}
