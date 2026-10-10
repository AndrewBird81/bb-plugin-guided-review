import { afterEach, expect, test, vi } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { createStore } from "./store";
import { createReviewSync, type GithubReads, type TurnActions } from "./review-lifecycle";
import { defaultPreferences } from "./preferences";
import type { FeedbackThread, PrFacts, PrRef } from "./github/types";

const HOUR = 3_600_000;
const T0 = Date.parse("2026-10-10T12:00:00Z");

function facts(ref: PrRef, extra: Partial<PrFacts> = {}): PrFacts {
  return {
    targetKey: ref.targetKey, repo: ref.repo, number: ref.number, state: "OPEN", isDraft: false, title: "Expire cache entries", url: "https://github.com/acme/web/pull/1",
    author: "alice", baseRefName: "main", headRefName: "cache", headSha: "sha1", updatedAt: 1, ci: "pass",
    myReviews: [], otherOpinions: [], requests: [], requestRemovedAt: null, requestPending: null, mention: null, commits: ["sha1"], ...extra,
  };
}
const review = (state: "APPROVED" | "CHANGES_REQUESTED" | "COMMENTED" | "DISMISSED", at: number, sha = "sha1", body = "") => ({ id: `r-${at}`, state, submittedAt: at, sha, body });
const thread = (id: string, status: FeedbackThread["status"], replyAt: number | null = null): FeedbackThread => ({
  id, commentId: 1, reviewId: null, path: "a.ts", line: 3, originalLine: 3, startLine: null, side: "RIGHT", subjectType: "LINE",
  body: "Please fix", createdAt: T0 - 5 * HOUR, isResolved: status === "resolved", resolvedBy: null, isOutdated: false, replies: [], status, replyAt,
});

// The store stamps some times with Date.now(); keep it on the test's clock.
afterEach(() => { vi.useRealTimers(); });

function setup(options: { pr?: Partial<PrFacts>; threads?: FeedbackThread[]; reviewed?: boolean; preferences?: Partial<typeof defaultPreferences> } = {}) {
  const published: any[] = [];
  const dismissed: any[] = [];
  const { bb, harness } = createFakePluginHost({ pluginId: "guided-review", sdk: {
    threads: { update: async () => ({}), stop: async () => ({}), archive: async () => ({}) },
    plugins: { callRpc: async ({ method, input }: any) => {
      if (method === "activityCapabilities") return { version: 1 };
      if (method === "dismissActivity") { dismissed.push(input); return { ok: true }; }
      published.push(input);
      return { accepted: true, id: "activity", duplicate: false };
    } },
  } as any });
  const store = createStore(bb);
  store.saveReview({ targetKey: "pr-1", kind: "pr", repo: "acme/web", number: 1, headSha: "sha1", createdAt: 1, status: "ready", projectId: "p1" });
  if (options.preferences) store.savePreferences({ ...defaultPreferences, ...options.preferences }, 0);
  // A legacy review-agent worker, from before conversations moved into bb threads.
  bb.storage.database().prepare(`INSERT INTO agent_threads (target_key,thread_id,created_at) VALUES ('pr-1','agent-1',1)`).run();
  store.setAssistantThread("pr-1", "assistant-1");
  let now = T0;
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(now);
  let pr: Partial<PrFacts> = { ...(options.reviewed ? { myReviews: [review("CHANGES_REQUESTED", T0 - 5 * HOUR)] } : {}), ...options.pr };
  let threads = options.threads ?? [];
  const github: GithubReads = {
    viewer: { login: async () => "me", teams: async () => new Set<string>(), reset() {} },
    gate: { poll: async () => ({ kind: "unchanged" }) },
    facts: vi.fn(async (refs: PrRef[]) => new Map(refs.map((ref) => [ref.targetKey, facts(ref, pr)]))),
    threads: vi.fn(async () => threads),
    discover: vi.fn(async () => []),
  };
  const actions: TurnActions = {
    prepare: vi.fn(async () => true), checkPushes: vi.fn(async () => true), autoStart: vi.fn(async () => true), projectId: async () => "p1",
  };
  const sync = createReviewSync(bb, store, vi.fn() as any, { github, actions, now: () => now });
  return {
    bb, harness, store, sync, github, actions, published, dismissed,
    at: (hoursAfter: number) => { now = T0 + hoursAfter * HOUR; vi.setSystemTime(now); },
    pr: (next: Partial<PrFacts>) => { pr = { ...pr, ...next }; },
    threads: (next: FeedbackThread[]) => { threads = next; },
  };
}

test("sync archives merged reviews and their legacy worker, but keeps the assistant chat writable", async () => {
  const { sync, store, harness } = setup({ pr: { state: "MERGED" } });
  await sync.all();
  expect(store.getReview("pr-1")).toMatchObject({ prState: "MERGED", archivedAt: expect.any(Number) });
  expect(harness.inspection.sdk.callsTo("threads.update")[0][0]).toEqual({ threadId: "agent-1", visibility: "hidden" });
  expect(harness.inspection.sdk.callsTo("threads.archive")).toEqual([[{ threadId: "agent-1" }]]);
  expect(store.getAssistantThread("pr-1")).toBe("assistant-1");
});

test("sync restores the viewer's approval and keeps a changes-requested verdict through later comments", async () => {
  const { sync, store, pr } = setup({ pr: { myReviews: [review("APPROVED", T0 - HOUR)] } });
  await sync.all();
  expect(store.getReview("pr-1")).toMatchObject({ submittedVerdict: "APPROVE", reviewer: "me", submittedHeadSha: "sha1" });
  pr({ myReviews: [review("CHANGES_REQUESTED", T0 - 2 * HOUR), review("COMMENTED", T0 - HOUR, "sha2", "Still waiting on the test")] });
  await sync.all(true);
  expect(store.getReview("pr-1")).toMatchObject({ submittedVerdict: "REQUEST_CHANGES", submittedHeadSha: "sha2", signals: { lastReviewSha: "sha2" } });
});

test("sync keeps a reviewer's archive on an open PR", async () => {
  const { sync, store } = setup();
  store.setLifecycle("pr-1", { userArchivedAt: 5 });
  await sync.all();
  expect(store.getReview("pr-1")).toMatchObject({ prState: "OPEN", archivedAt: null, userArchivedAt: 5 });
});

test("failed refresh preserves approval and does not archive a PR", async () => {
  const { sync, store, github } = setup();
  store.setLifecycle("pr-1", { submittedVerdict: "APPROVE", submittedAt: 1 });
  vi.mocked(github.facts).mockRejectedValue(new Error("offline"));
  await sync.all();
  expect(store.getReview("pr-1")).toMatchObject({ submittedVerdict: "APPROVE" });
  expect(store.getReview("pr-1")?.archivedAt).toBeFalsy();
});

test("an in-flight read cannot overwrite a newer local submission", async () => {
  const { sync, store, github } = setup();
  let finish!: () => void;
  vi.mocked(github.facts).mockImplementation((refs) => new Promise((resolve) => { finish = () => resolve(new Map(refs.map((ref) => [ref.targetKey, facts(ref)]))); }));
  const pending = sync.one("pr-1", true);
  await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
  store.setLifecycle("pr-1", { submittedVerdict: "APPROVE", submittedAt: Date.now() + 1 });
  finish();
  await pending;
  expect(store.getReview("pr-1")?.submittedVerdict).toBe("APPROVE");
});

test("deleted workers are detached without losing the review conversation", async () => {
  const { bb, sync, store, harness } = setup();
  bb.storage.database().prepare(`INSERT INTO agent_messages (target_key,role,text,context,created_at) VALUES ('pr-1','assistant','Keep this answer',NULL,1)`).run();
  harness.inspection.sdk.stub("threads.update", async () => { throw new Error("HTTP 404: Thread not found"); });
  await sync.all();
  expect(store.getAgentThread("pr-1")).toBeNull();
  expect(store.listAgentMessages("pr-1")[0].text).toBe("Keep this answer");
});

test("a dismissed approval returns to the review queue", async () => {
  const { sync, store } = setup({ pr: { myReviews: [review("DISMISSED", T0 - HOUR)] } });
  store.setLifecycle("pr-1", { submittedVerdict: "APPROVE", submittedAt: 1 });
  await sync.all();
  expect(store.getReview("pr-1")?.submittedVerdict).toBeNull();
  expect(sync.turnOf(store.getReview("pr-1")!)).toMatchObject({ group: "needs", reason: "dismissed" });
});

test("the first read of a review records today's turns without alerting", async () => {
  const { sync, published, actions } = setup({ reviewed: true, pr: { headSha: "sha2", commits: ["sha1", "sha2"], requests: [{ at: T0 - HOUR, by: "alice", via: "user" }] } });
  await sync.all();
  expect(published).toHaveLength(0);
  expect(actions.prepare).not.toHaveBeenCalled();
});

test("a push alone waits on the author; a re-request prepares the re-review, then alerts with its tally", async () => {
  const s = setup({ reviewed: true });
  await s.sync.all(); // baseline
  s.pr({ headSha: "sha2", commits: ["sha1", "sha2"] });
  s.at(0.1);
  await s.sync.all(true);
  expect(s.sync.turnOf(s.store.getReview("pr-1")!)).toMatchObject({ group: "waiting", updated: true });
  expect(s.published).toHaveLength(0);

  s.pr({ requests: [{ at: T0 + 0.2 * HOUR, by: "alice", via: "user" }] });
  s.at(0.3);
  await s.sync.all(true);
  expect(s.actions.prepare).toHaveBeenCalledWith("pr-1", "re-requested");
  // The alert waits for the re-review to be prepared.
  expect(s.published).toHaveLength(0);
  expect(s.store.getReview("pr-1")?.pendingAlert).toMatchObject({ signal: `re-requested:${T0 + 0.2 * HOUR}` });
  s.store.setLifecycle("pr-1", { preparedAt: T0 + 0.35 * HOUR, assessment: { headSha: "sha2", total: 3, addressed: 2, partial: 1, notAddressed: 0, disputed: 0, unclear: 0, assessedAt: T0 + 0.35 * HOUR } });
  await s.sync.evaluate("pr-1");
  await vi.waitFor(() => expect(s.published).toHaveLength(1));
  expect(s.published[0]).toMatchObject({ entityId: "pr-1", status: "ready", body: expect.stringContaining("@alice re-requested your review · 2/3 addressed · CI passing · 1 new commit") });
  // One event alerts once.
  await s.sync.all(true);
  expect(s.published).toHaveLength(1);
  expect(s.actions.prepare).toHaveBeenCalledTimes(1);
});

test("an alert goes out anyway when preparing takes too long", async () => {
  const s = setup({ reviewed: true });
  await s.sync.all();
  s.pr({ headSha: "sha2", commits: ["sha1", "sha2"], requests: [{ at: T0 + 0.1 * HOUR, by: "alice", via: "user" }] });
  s.at(0.2);
  await s.sync.all(true);
  expect(s.published).toHaveLength(0);
  s.at(0.5);
  await s.sync.all();
  await vi.waitFor(() => expect(s.published).toHaveLength(1));
});

test("Not yet clears the alert, and leaving Needs review dismisses it", async () => {
  const s = setup({ reviewed: true });
  await s.sync.all();
  s.pr({ headSha: "sha2", commits: ["sha1", "sha2"], requests: [{ at: T0 + 0.1 * HOUR, by: "alice", via: "user" }] });
  vi.mocked(s.actions.prepare).mockResolvedValue(false);
  s.at(0.2);
  await s.sync.all(true);
  await vi.waitFor(() => expect(s.published).toHaveLength(1));
  s.store.setLifecycle("pr-1", { snoozedAt: T0 + 0.3 * HOUR });
  s.at(0.4);
  await s.sync.evaluate("pr-1");
  await vi.waitFor(() => expect(s.dismissed).toHaveLength(1));
  expect(s.sync.turnOf(s.store.getReview("pr-1")!)).toMatchObject({ group: "waiting", reason: "snoozed" });
});

test("feedback handled: every thread resolved or answered alerts once the author has been quiet", async () => {
  const s = setup({ reviewed: true, threads: [thread("t1", "open"), thread("t2", "open")] });
  await s.sync.all();
  s.pr({ headSha: "sha2", commits: ["sha1", "sha2"], updatedAt: 2 });
  s.threads([thread("t1", "resolved"), thread("t2", "answered", T0 + 0.1 * HOUR)]);
  vi.mocked(s.actions.prepare).mockResolvedValue(false);
  s.at(0.15);
  await s.sync.all(true);
  expect(s.store.getReview("pr-1")?.signals).toMatchObject({ threads: { total: 2, resolved: 1, answered: 1, open: 0 }, handledAt: expect.any(Number) });
  expect(s.published).toHaveLength(0);
  s.at(0.5);
  await s.sync.all();
  await vi.waitFor(() => expect(s.published).toHaveLength(1));
  expect(s.published[0].body).toContain("Every thread of your feedback is resolved or answered");
});

test("a question on your thread alerts without preparing a re-review", async () => {
  const s = setup({ reviewed: true, threads: [thread("t1", "open")] });
  await s.sync.all();
  s.pr({ updatedAt: 2 });
  s.threads([thread("t1", "question", T0 + 0.1 * HOUR)]);
  s.at(0.2);
  await s.sync.all(true);
  await vi.waitFor(() => expect(s.published).toHaveLength(1));
  expect(s.published[0].body).toContain("asked you something");
  expect(s.actions.prepare).not.toHaveBeenCalled();
});

test("a re-request takes the review out of your archive", async () => {
  const s = setup({ reviewed: true });
  s.store.setLifecycle("pr-1", { userArchivedAt: T0 - HOUR });
  await s.sync.all();
  s.pr({ requests: [{ at: T0 + 0.1 * HOUR, by: "alice", via: "user" }] });
  s.at(0.2);
  await s.sync.all(true);
  expect(s.store.getReview("pr-1")?.userArchivedAt).toBeNull();
  expect(s.sync.turnOf(s.store.getReview("pr-1")!).group).toBe("needs");
});

test("with push checks on, the assistant checks settled pushes while you wait", async () => {
  const s = setup({ reviewed: true, preferences: { pushChecks: "progress" } });
  await s.sync.all();
  s.pr({ headSha: "sha2", commits: ["sha1", "sha2"] });
  s.at(0.1);
  await s.sync.all(true);
  expect(s.actions.checkPushes).not.toHaveBeenCalled();
  s.at(0.5);
  await s.sync.all();
  expect(s.actions.checkPushes).toHaveBeenCalledWith("pr-1");
  await s.sync.all(true);
  expect(s.actions.checkPushes).toHaveBeenCalledTimes(1);
});

test("discovery adds PRs you're asked to review, skips deleted ones, and auto-starts matching repos", async () => {
  const s = setup({ preferences: { autoStartRepos: ["acme/*"] } });
  await s.sync.all(); // baseline, no discoveries yet
  vi.mocked(s.github.discover).mockResolvedValue([
    { repo: "acme/api", number: 7, title: "Add tenant scoping", url: "https://github.com/acme/api/pull/7", author: "bob", updatedAt: 1, isDraft: false, requested: true, reviewed: false },
    { repo: "other/app", number: 9, title: "Fix login", url: "https://github.com/other/app/pull/9", author: "carol", updatedAt: 1, isDraft: false, requested: true, reviewed: false },
    { repo: "acme/web", number: 3, title: "Deleted", url: "https://github.com/acme/web/pull/3", author: "dan", updatedAt: 1, isDraft: false, requested: true, reviewed: false },
  ]);
  const { targetKey } = await import("./targets");
  s.store.ignoreDiscovery(targetKey({ kind: "pr", number: 3, repo: "acme/web" }));
  vi.mocked(s.github.facts).mockImplementation(async (refs) => new Map(refs.map((ref) => [ref.targetKey, ref.number === 1 ? facts(ref) : facts(ref, {
    title: ref.number === 7 ? "Add tenant scoping" : "Fix login", requestPending: { via: "user" }, requests: [{ at: T0 + 0.1 * HOUR, by: "bob", via: "user" }],
  })])));
  s.at(1);
  await s.sync.all(true);
  const tracked = s.store.listReviews().filter((r) => r.status === "tracked");
  expect(tracked.map((r) => r.repo).sort()).toEqual(["acme/api", "other/app"]);
  const api = tracked.find((r) => r.repo === "acme/api")!;
  expect(s.actions.autoStart).toHaveBeenCalledWith(api.targetKey);
  // The other request alerts now; the auto-started one waits for its guide.
  await vi.waitFor(() => expect(s.published).toHaveLength(1));
  expect(s.published[0]).toMatchObject({ title: "Fix login", body: expect.stringContaining("requested your review") });
});

test("evaluations of one review run one at a time, so a signal is prepared once", async () => {
  const s = setup({ reviewed: true });
  await s.sync.all();
  s.pr({ headSha: "sha2", commits: ["sha1", "sha2"], requests: [{ at: T0 + 0.1 * HOUR, by: "alice", via: "user" }] });
  s.at(0.2);
  await s.sync.all(true);
  vi.mocked(s.actions.prepare).mockClear();
  // A newer request at a new head, evaluated from two places at once.
  s.pr({ headSha: "sha3", commits: ["sha1", "sha2", "sha3"], requests: [{ at: T0 + 0.3 * HOUR, by: "alice", via: "user" }] });
  s.at(0.4);
  let release!: () => void;
  vi.mocked(s.actions.prepare).mockImplementation(() => new Promise((resolve) => { release = () => resolve(true); }));
  const pass = s.sync.all(true);
  await vi.waitFor(() => expect(release).toBeTypeOf("function"));
  const again = s.sync.evaluate("pr-1");
  release();
  await Promise.all([pass, again]);
  expect(s.actions.prepare).toHaveBeenCalledTimes(1);
});

test("threads resolved before bb first read them don't count as just handled", async () => {
  // Reviewed long ago; every thread was resolved before the upgrade; new commits and quiet since.
  const old = { ...thread("t1", "resolved"), replies: [{ author: "alice", bot: false, mine: false, body: "Done", createdAt: T0 - 4 * HOUR }] };
  const s = setup({ reviewed: true, threads: [old], pr: { headSha: "sha2", commits: ["sha1", "sha2"], updatedAt: 2 } });
  await s.sync.all();
  s.at(1);
  await s.sync.all();
  // It shows as your turn, but alerts and prepares nothing: it happened before bb was watching.
  expect(s.sync.turnOf(s.store.getReview("pr-1")!)).toMatchObject({ group: "needs", reason: "handled" });
  expect(s.published).toHaveLength(0);
  expect(s.actions.prepare).not.toHaveBeenCalled();
});

test("a failed automatic re-review still sends its alert", async () => {
  const s = setup({ reviewed: true });
  await s.sync.all();
  s.pr({ headSha: "sha2", commits: ["sha1", "sha2"], requests: [{ at: T0 + 0.1 * HOUR, by: "alice", via: "user" }] });
  vi.mocked(s.actions.prepare).mockImplementation(async () => { s.store.setStatus("pr-1", "generating"); return true; });
  s.at(0.2);
  await s.sync.all(true);
  expect(s.published).toHaveLength(0);
  // The rebuild fails.
  s.store.setStatus("pr-1", "error");
  await s.sync.evaluate("pr-1");
  await vi.waitFor(() => expect(s.published).toHaveLength(1));
  expect(s.published[0].body).toContain("re-requested your review");
});

test("feedback handled holds through another push, without alerting or preparing again", async () => {
  const s = setup({ reviewed: true, threads: [thread("t1", "open")] });
  vi.mocked(s.actions.prepare).mockResolvedValue(false);
  await s.sync.all();
  s.pr({ headSha: "sha2", commits: ["sha1", "sha2"], updatedAt: 2 });
  s.threads([thread("t1", "answered", T0 + 0.1 * HOUR)]);
  s.at(0.15);
  await s.sync.all(true);
  s.at(0.5);
  await s.sync.all();
  await vi.waitFor(() => expect(s.published).toHaveLength(1));
  const prepared = vi.mocked(s.actions.prepare).mock.calls.length;
  // Another push restarts the quiet period, but the turn already came to you.
  s.pr({ headSha: "sha3", commits: ["sha1", "sha2", "sha3"], updatedAt: 3 });
  s.at(0.55);
  await s.sync.all(true);
  s.at(1);
  await s.sync.all(true);
  expect(s.sync.turnOf(s.store.getReview("pr-1")!)).toMatchObject({ group: "needs", reason: "handled" });
  expect(s.published).toHaveLength(1);
  expect(s.dismissed).toHaveLength(0);
  expect(vi.mocked(s.actions.prepare).mock.calls.length).toBe(prepared);
});

test("discovery only fills the list the first time for an account", async () => {
  const s = setup();
  vi.mocked(s.github.discover).mockResolvedValue([
    { repo: "acme/api", number: 7, title: "Add tenant scoping", url: "u", author: "bob", updatedAt: 1, isDraft: false, requested: true, reviewed: false },
  ]);
  vi.mocked(s.github.facts).mockImplementation(async (refs) => new Map(refs.map((ref) => [ref.targetKey, facts(ref, ref.number === 7
    ? { requestPending: { via: "user" }, requests: [{ at: T0 - HOUR, by: "bob", via: "user" }] } : {})])));
  await s.sync.all();
  expect(s.store.listReviews().some((r) => r.repo === "acme/api")).toBe(true);
  expect(s.published).toHaveLength(0);
});

test("re-reviews of PRs found on GitHub start guides only in auto-start repositories", async () => {
  const s = setup({ reviewed: true });
  s.store.setStatus("pr-1", "tracked");
  await s.sync.all();
  s.pr({ headSha: "sha2", commits: ["sha1", "sha2"], requests: [{ at: T0 + 0.1 * HOUR, by: "alice", via: "user" }] });
  s.at(0.2);
  await s.sync.all(true);
  expect(s.actions.prepare).not.toHaveBeenCalled();
  await vi.waitFor(() => expect(s.published).toHaveLength(1));
  // With the repository listed, the next request prepares it.
  s.store.savePreferences({ ...defaultPreferences, autoStartRepos: ["acme/*"] }, 0);
  s.pr({ headSha: "sha3", commits: ["sha1", "sha2", "sha3"], requests: [{ at: T0 + 0.3 * HOUR, by: "alice", via: "user" }] });
  s.at(0.4);
  await s.sync.all(true);
  expect(s.actions.prepare).toHaveBeenCalledWith("pr-1", "re-requested");
});

test("team requests auto-start in listed repositories", async () => {
  const s = setup({ preferences: { autoStartRepos: ["acme/web"] } });
  s.store.setStatus("pr-1", "tracked");
  s.store.setLifecycle("pr-1", { newRequest: true });
  s.pr({ requestPending: { via: "team", team: "acme/web-core" }, requests: [{ at: T0 - HOUR, by: "dan", via: "team", team: "acme/web-core" }] });
  await s.sync.all();
  expect(s.actions.autoStart).toHaveBeenCalledWith("pr-1");
});

test("switching GitHub accounts reads threads and notifications again", async () => {
  const s = setup({ reviewed: true, threads: [thread("t1", "open")] });
  const reset = vi.fn();
  (s.github.gate as any).reset = reset;
  await s.sync.all();
  expect(s.store.feedbackFetched("pr-1")).not.toBeNull();
  s.sync.resetViewer();
  expect(reset).toHaveBeenCalled();
  expect(s.store.feedbackFetched("pr-1")).toBeNull();
});
