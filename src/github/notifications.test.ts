import { expect, test, vi } from "vitest";
import { createNotificationGate, parseIncludeOutput } from "./notifications";

const LAST_MODIFIED = "Tue, 25 Aug 2026 15:57:06 GMT";
// As `gh api -i` prints it: a bare status line, then CRLF headers and a blank line.
const headers = (status: string, extra: string[] = []) =>
  `HTTP/2.0 ${status}\n${["Content-Type: application/json; charset=utf-8", `Last-Modified: ${LAST_MODIFIED}`, "X-Poll-Interval: 60", ...extra].join("\r\n")}\r\n\r\n`;
const notification = (type: string, url: string, reason = "review_requested", updated_at = "2026-10-10T16:00:00Z") =>
  ({ id: "1", unread: true, reason, updated_at, subject: { title: "Fix scope handling", url, type }, repository: { full_name: "x/y" } });
const ok = (items: unknown[]) => ({ code: 0, stderr: "", stdout: headers("200 OK") + JSON.stringify(items) });
const notModified = { code: 1, stderr: "gh: HTTP 304\n", stdout: headers("304 Not Modified") };

function clock(start = 1_000_000) {
  let t = start;
  return { now: () => t, advance: (ms: number) => { t += ms; } };
}

test("parseIncludeOutput splits status, headers, and body", () => {
  const parsed = parseIncludeOutput(headers("200 OK") + "[]")!;
  expect(parsed.status).toBe(200);
  expect(parsed.headers.get("last-modified")).toBe(LAST_MODIFIED);
  expect(parsed.headers.get("x-poll-interval")).toBe("60");
  expect(parsed.body).toBe("[]");
  expect(parseIncludeOutput(notModified.stdout)).toMatchObject({ status: 304, body: "" });
  expect(parseIncludeOutput("")).toBeNull();
});

test("the first poll reports changed pull requests and later polls are conditional", async () => {
  const time = clock();
  const run = vi.fn(async (_args: string[]) => ok([
    notification("PullRequest", "https://api.github.com/repos/Cli/CLI/pulls/9083", "mention"),
    notification("Issue", "https://api.github.com/repos/cli/cli/issues/1"),
    notification("Release", "https://api.github.com/repos/cli/cli/releases/1"),
  ]));
  const gate = createNotificationGate(run, time.now);
  expect(await gate.poll()).toEqual({ kind: "changed", prs: [{ repo: "cli/cli", number: 9083, reason: "mention", updatedAt: Date.parse("2026-10-10T16:00:00Z") }] });
  expect(run.mock.calls[0][0]).toEqual(["api", "-i", "notifications?participating=true&per_page=50"]);

  run.mockResolvedValueOnce(notModified);
  time.advance(60_000);
  expect(await gate.poll()).toEqual({ kind: "unchanged" });
  expect(run.mock.calls[1][0]).toEqual(["api", "-i", "-H", `If-Modified-Since: ${LAST_MODIFIED}`, "notifications?participating=true&per_page=50"]);
});

test("a PR title mentioning scopes doesn't read as a scope error", async () => {
  const gate = createNotificationGate(vi.fn(async () => ok([notification("PullRequest", "https://api.github.com/repos/a/b/pulls/2")])));
  expect(await gate.poll()).toMatchObject({ kind: "changed", prs: [{ repo: "a/b", number: 2 }] });
});

test("polls inside X-Poll-Interval return unchanged without calling gh", async () => {
  const time = clock();
  const run = vi.fn(async () => ok([]));
  const gate = createNotificationGate(run, time.now);
  await gate.poll();
  time.advance(59_000);
  expect(await gate.poll()).toEqual({ kind: "unchanged" });
  expect(run).toHaveBeenCalledTimes(1);
  time.advance(1_000);
  expect(await gate.poll()).toEqual({ kind: "changed", prs: [] });
  expect(run).toHaveBeenCalledTimes(2);
});

test("a 403 or missing scope reports unsupported and waits an hour before trying again", async () => {
  const time = clock();
  const forbidden = { code: 1, stderr: "gh: Resource not accessible by personal access token (HTTP 403)", stdout: headers("403 Forbidden") + `{"message":"Resource not accessible by personal access token"}` };
  const run = vi.fn(async () => forbidden);
  const gate = createNotificationGate(run, time.now);
  expect(await gate.poll()).toEqual({ kind: "unsupported" });
  time.advance(59 * 60_000);
  expect(await gate.poll()).toEqual({ kind: "unsupported" });
  expect(run).toHaveBeenCalledTimes(1);
  time.advance(60_000);
  run.mockResolvedValueOnce({ code: 1, stdout: "", stderr: `gh: This API operation needs the "notifications" scope. To request it, run:  gh auth refresh -h github.com -s notifications` });
  expect(await gate.poll()).toEqual({ kind: "unsupported" });
  expect(run).toHaveBeenCalledTimes(2);
});

test("401 and 404 are unsupported too", async () => {
  for (const status of ["401 Unauthorized", "404 Not Found"]) {
    const gate = createNotificationGate(vi.fn(async () => ({ code: 1, stderr: "", stdout: headers(status) + `{"message":"x"}` })));
    expect(await gate.poll()).toEqual({ kind: "unsupported" });
  }
});

test("a transport failure or server error rejects", async () => {
  await expect(createNotificationGate(vi.fn(async () => ({ code: 1, stdout: "", stderr: "error connecting to api.github.com" }))).poll()).rejects.toThrow(/connecting/);
  await expect(createNotificationGate(vi.fn(async () => ({ code: 1, stdout: headers("502 Bad Gateway"), stderr: "gh: HTTP 502" }))).poll()).rejects.toThrow(/502/);
});

test("reset forgets Last-Modified, the poll interval, and an unsupported token", async () => {
  const { createNotificationGate } = await import("./notifications");
  const calls: string[][] = [];
  let status = 200;
  const run = async (args: string[]) => {
    calls.push(args);
    const body = status === 200 ? "[]" : "";
    return { code: status === 200 ? 0 : 1, stderr: "", stdout: `HTTP/2.0 ${status} X\r\nLast-Modified: Mon, 01 Jan 2026 00:00:00 GMT\r\nX-Poll-Interval: 60\r\n\r\n${body}` };
  };
  let t = 0;
  const gate = createNotificationGate(run as any, () => t);
  await gate.poll();
  t = 61_000;
  await gate.poll();
  expect(calls[1]).toContain("If-Modified-Since: Mon, 01 Jan 2026 00:00:00 GMT");
  gate.reset!();
  await gate.poll();
  expect(calls[2].join(" ")).not.toContain("If-Modified-Since");
  status = 403;
  t = 200_000;
  expect(await gate.poll()).toEqual({ kind: "unsupported" });
  gate.reset!();
  status = 200;
  expect((await gate.poll()).kind).toBe("changed");
});
