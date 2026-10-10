import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { Store, ReviewMeta } from "./store";
import { isMissingThread } from "./thread-errors";
import type { runGh } from "./gh";
import { computeTurn, type Turn, type TurnReason } from "../lib/turn";
import { alertBody, factsUpdate, threadSignals, turnOptions } from "./turn-signals";
import { completionNotifications } from "./completion-notifications";
import { matchesRepo } from "./preferences";
import { targetKey as keyFor } from "./targets";
import { fetchPrFacts } from "./github/pr-facts";
import { fetchMyThreads } from "./github/threads";
import { createNotificationGate, type NotificationGate } from "./github/notifications";
import { discoverPrs } from "./github/discovery";
import { createViewer, type Viewer } from "./github/viewer";
import type { DiscoveredPr, FeedbackThread, PrFacts, PrRef } from "./github/types";

/** Everything the sync reads from GitHub. */
export interface GithubReads {
  viewer: Viewer;
  gate: NotificationGate;
  facts(refs: PrRef[], viewer: string, teams: ReadonlySet<string>): Promise<Map<string, PrFacts | null>>;
  threads(repo: string, number: number, viewer: string): Promise<FeedbackThread[]>;
  discover(options: { reviewed: boolean }): Promise<DiscoveredPr[]>;
}

export function githubReads(run: typeof runGh): GithubReads {
  return {
    viewer: createViewer(run), gate: createNotificationGate(run),
    facts: (refs, viewer, teams) => fetchPrFacts(run, refs, viewer, teams),
    threads: (repo, number, viewer) => fetchMyThreads(run, repo, number, viewer),
    discover: (options) => discoverPrs(run, options),
  };
}

/** What the plugin does when a review's turn changes. Each returns whether work started. */
export interface TurnActions {
  /** A re-review came back to you: regenerate an out-of-date guide, then check your feedback. */
  prepare(targetKey: string, reason: TurnReason): Promise<boolean>;
  /** The author's pushes settled while you wait: check your feedback against them. */
  checkPushes(targetKey: string): Promise<boolean>;
  /** Your review was requested in an auto-start repository: generate the guide. */
  autoStart(targetKey: string): Promise<boolean>;
  /** The project reviews found on GitHub run in. */
  projectId(): Promise<string | null>;
}

const MINUTE = 60_000;
/** How often each group is read from GitHub without a notification saying it changed. */
const INTERVAL: Record<Turn["group"], number> = { needs: 2 * MINUTE, waiting: 2 * MINUTE, reviewed: 10 * MINUTE, archive: 30 * MINUTE };
/** How long an alert waits for its re-review to be prepared. */
const ALERT_WAIT = 10 * MINUTE;
/** How long pushes must settle before the assistant checks them. */
const PUSH_QUIET = 15 * MINUTE;
const DISCOVER_EVERY = 5 * MINUTE;
/** The account discovery last ran for; its first run only fills the list. */
const DISCOVERED = "discovery:account";
/** Threads are re-read when the PR changes, and at least this often while it's active. */
const THREADS_EVERY = 10 * MINUTE;
/** Turns that prepare their re-review ahead of time. */
const PREPARE = new Set<TurnReason>(["re-requested", "handled", "looks-ready", "dismissed"]);

/** Reconcile durable review state with GitHub, and act when a review becomes your turn. Never writes to GitHub. */
export function createReviewSync(bb: BbPluginApi, store: Store, run: typeof runGh, options: { github?: GithubReads; actions?: TurnActions; now?: () => number } = {}) {
  const github = options.github ?? githubReads(run);
  const actions = options.actions;
  const clock = options.now ?? Date.now;
  const notifications = completionNotifications(bb, store);
  const inflight = new Map<string, Promise<void>>();
  const checked = new Map<string, number>();
  const hidden = new Set<string>();
  const archived = new Set<string>();
  let lastDiscovery = 0;
  let discovering: Promise<void> | null = null;
  let disposed = false;
  bb.onDispose(() => { disposed = true; });

  const turnOf = (review: ReviewMeta, now = clock()) => computeTurn(review, turnOptions(store.getPreferences().preferences), now);
  // Stale alerts drop when the review is no longer your turn for the same reason.
  notifications.useTurns((key) => {
    const review = store.getReview(key);
    const turn = review && turnOf(review);
    return turn?.group === "needs" ? turn.signal : null;
  });
  const publish = (key: string) => {
    bb.realtime.publish(`review:${key}`, { ts: clock() });
    bb.realtime.publish("reviews", { ts: clock() });
  };

  // Tidies a legacy review-agent worker. Assistant threads in bb stay
  // unarchived, because an archived thread cannot take messages.
  async function maintainThread(targetKey: string) {
    const threadId = store.getAgentThread(targetKey);
    if (!threadId || disposed) return;
    try {
      if (!hidden.has(threadId)) {
        await bb.sdk.threads.update({ threadId, visibility: "hidden" });
        hidden.add(threadId);
      }
      if (store.getReview(targetKey)?.archivedAt && !archived.has(threadId) && !disposed) {
        try { await bb.sdk.threads.stop({ threadId }); }
        finally { if (!disposed) await bb.sdk.threads.archive({ threadId }); }
        archived.add(threadId);
      }
    } catch (error) {
      if (disposed) return;
      if (isMissingThread(error)) {
        // Retain the transcript, and never detach a different replacement worker.
        if (store.getAgentThread(targetKey) === threadId) store.clearAgentThread(targetKey);
      } else bb.log.warn(`Could not tidy review thread ${threadId}: ${String(error)}`);
    }
  }

  const readable = (review: ReviewMeta | null): review is ReviewMeta & { repo: string; number: number } =>
    !!review && review.kind === "pr" && !!review.repo && !!review.number && review.prState !== "MERGED";

  /** Read these reviews' PRs in batches and apply what changed. */
  async function read(keys: string[]): Promise<void> {
    const waiting = keys.filter((key) => inflight.has(key)).map((key) => inflight.get(key)!);
    const fresh = keys.filter((key) => !inflight.has(key));
    if (!fresh.length) { await Promise.allSettled(waiting); return; }
    const task = (async () => {
      const login = await github.viewer.login();
      if (!login || disposed) return;
      const teams = await github.viewer.teams();
      const reviews = fresh.map((key) => store.getReview(key)).filter(readable);
      const startedAt = clock();
      let facts: Map<string, PrFacts | null>;
      try {
        facts = await github.facts(reviews.map((r) => ({ targetKey: r.targetKey, repo: r.repo, number: r.number })), login, teams);
      } catch (error) {
        // A failed read preserves saved state.
        if (!disposed) bb.log.warn(`Could not refresh reviews: ${String(error)}`);
        return;
      }
      for (const review of reviews) {
        if (disposed) return;
        checked.set(review.targetKey, clock());
        const fact = facts.get(review.targetKey);
        // Missing: GitHub couldn't be read for it. Null: the PR is gone or out of reach. Keep what's saved.
        if (fact) await apply(review.targetKey, fact, login, startedAt).catch((error) => bb.log.warn(`Could not refresh ${review.targetKey}: ${String(error)}`));
        await maintainThread(review.targetKey);
      }
    })().finally(() => { for (const key of fresh) if (inflight.get(key) === task) inflight.delete(key); });
    for (const key of fresh) inflight.set(key, task);
    await Promise.allSettled([task, ...waiting]);
  }

  async function apply(key: string, facts: PrFacts, login: string, startedAt: number) {
    const before = store.getReview(key);
    if (!before || before.prState === "MERGED" && facts.state !== "MERGED") return;
    // What happened before bb first read the PR is history: it shows, but doesn't alert or start work.
    if (before.watchingSince == null) store.setLifecycle(key, { watchingSince: clock() });
    // Keep what the list shows current; a review found on GitHub learns its PR here.
    const meta = { title: facts.title || before.title, url: facts.url || before.url, author: facts.author ?? before.author, base: before.base ?? facts.baseRefName, head: before.head ?? facts.headRefName };
    if (meta.title !== before.title || meta.url !== before.url || meta.author !== before.author || meta.base !== before.base || meta.head !== before.head) {
      store.saveReview({ ...before, ...meta });
    }
    store.setLifecycle(key, factsUpdate(before, facts, login, startedAt, clock()));
    const updated = store.getReview(key)!;
    if (updated.signals?.lastReviewAt) {
      const fetched = store.feedbackFetched(key);
      const active = turnOf(updated).group === "needs" || turnOf(updated).group === "waiting";
      if (!fetched || fetched.prUpdatedAt !== facts.updatedAt || active && clock() - fetched.fetchedAt >= THREADS_EVERY) {
        try {
          const threads = await github.threads(facts.repo, facts.number, login);
          // The review may have been deleted while GitHub answered.
          if (!store.getReview(key)) return;
          store.saveFeedbackThreads(key, threads, facts.updatedAt);
          bb.realtime.publish(`feedback:${key}`, { ts: clock() });
        } catch (error) { bb.log.warn(`Could not read your threads on ${key}: ${String(error)}`); }
      }
      store.setLifecycle(key, { signals: { ...store.getReview(key)!.signals, ...threadSignals(store.listFeedbackThreads(key)) } });
    }
    await evaluate(key);
    if (JSON.stringify(before) !== JSON.stringify(store.getReview(key))) publish(key);
  }

  /** Whether an automatic re-review finished since `since`, or can't run. */
  function prepared(review: ReviewMeta, since: number): boolean {
    if (review.status === "error") return true;
    return review.status !== "generating" && (review.preparedAt ?? 0) >= since;
  }

  async function alert(key: string, turn: Turn) {
    const review = store.getReview(key)!;
    store.setLifecycle(key, { notifiedSignal: turn.signal, pendingAlert: null });
    await notifications.queueTurn({ targetKey: key, signal: turn.signal!, projectId: review.projectId ?? "", body: alertBody(review, turn) }).catch(() => {});
  }

  // One evaluation per review at a time: two could both see a new signal and prepare it twice.
  const evaluating = new Map<string, Promise<void>>();
  function evaluate(key: string): Promise<void> {
    const next = (evaluating.get(key) ?? Promise.resolve()).catch(() => {}).then(() => evaluateNow(key));
    evaluating.set(key, next);
    void next.catch(() => {}).finally(() => { if (evaluating.get(key) === next) evaluating.delete(key); });
    return next;
  }

  /**
   * Act on the review's turn: alert once per signal (after its re-review is prepared, up to
   * ALERT_WAIT), prepare re-reviews, check settled pushes, and clear the alert when it leaves Needs review.
   * Events from before bb watched the review are recorded without acting, except a new request found on GitHub.
   */
  async function evaluateNow(key: string): Promise<void> {
    let review = store.getReview(key);
    if (!review || disposed) return;
    const now = clock();
    const preferences = store.getPreferences().preferences;
    const turn = turnOf(review, now);
    const head = review.latestHeadSha ?? review.headSha ?? null;
    // A person asking again takes the review out of your archive for good.
    if (review.userArchivedAt && turn.reason === "re-requested") store.setLifecycle(key, { userArchivedAt: null });
    if (turn.group === "needs" && turn.signal && turn.signal !== review.notifiedSignal && turn.signal !== review.pendingAlert?.signal) {
      const watching = review.watchingSince ?? null;
      const request = turn.reason === "requested" || turn.reason === "team-requested";
      const act = watching !== null && (turn.eventAt === null || turn.eventAt >= watching) || request && !!review.newRequest;
      // Handled and looks-ready come from passing states; once they're your turn, they hold until you act.
      const held = turn.reason === "handled" || turn.reason === "looks-ready" ? { heldTurn: { reason: turn.reason, label: turn.label, signal: turn.signal, at: now } } : {};
      if (!act) store.setLifecycle(key, { notifiedSignal: turn.signal, autoRunHead: head, newRequest: null, ...held });
      else {
        store.setLifecycle(key, { newRequest: null, ...held });
        // Guides for PRs found on GitHub cost a run each; they start only in your auto-start repositories.
        const allowed = review.status !== "tracked" || matchesRepo(preferences.autoStartRepos, review.repo);
        let preparing = false;
        if (actions && head && allowed && review.autoRunHead !== head && review.status !== "generating" && (PREPARE.has(turn.reason) || request && review.status === "tracked")) {
          const previous = review.autoRunHead ?? null;
          store.setLifecycle(key, { autoRunHead: head });
          preparing = await (request ? actions.autoStart(key) : actions.prepare(key, turn.reason)).catch(() => false);
          if (!store.getReview(key)) return;
          if (!preparing) store.setLifecycle(key, { autoRunHead: previous });
        }
        if (!turn.notify) store.setLifecycle(key, { notifiedSignal: turn.signal });
        else if (preparing) store.setLifecycle(key, { pendingAlert: { signal: turn.signal, since: now } });
        else await alert(key, turn);
      }
    }
    review = store.getReview(key);
    if (!review) return;
    const waiting = review.pendingAlert;
    if (waiting) {
      const current = turnOf(review, now);
      if (current.group !== "needs" || current.signal !== waiting.signal) store.setLifecycle(key, { pendingAlert: null });
      else if (now - waiting.since >= ALERT_WAIT || prepared(review, waiting.since)) await alert(key, current);
    }
    // While you wait, the assistant checks the author's pushes once they settle.
    const s = review.signals ?? {};
    if (actions && preferences.pushChecks !== "off" && turn.group === "waiting" && turn.updated && head && review.status === "ready"
      && review.autoRunHead !== head && review.assessment?.headSha !== head && s.ci !== "pending" && now - (s.headSeenAt ?? now) >= PUSH_QUIET) {
      store.setLifecycle(key, { autoRunHead: head });
      if (!await actions.checkPushes(key).catch(() => false) && store.getReview(key)) store.setLifecycle(key, { autoRunHead: review.autoRunHead ?? null });
    }
    if (review.turnGroup === "needs" && turn.group !== "needs") void notifications.dismiss(key);
    if (review.turnGroup !== turn.group && store.getReview(key)) store.setLifecycle(key, { turnGroup: turn.group });
  }

  /**
   * Add PRs you're asked to review, or have reviewed, on GitHub. The first look for each account
   * (and after tracking is turned back on) only fills the list; later requests alert.
   */
  async function discover(): Promise<void> {
    if (!actions) return;
    if (!store.getPreferences().preferences.trackGithubReviews) {
      await bb.storage.kv.delete(DISCOVERED);
      return;
    }
    const login = await github.viewer.login();
    if (!login) return;
    const found = await github.discover({ reviewed: true });
    const projectId = await actions.projectId();
    if (!projectId || disposed) return;
    const first = (await bb.storage.kv.get<{ login: string }>(DISCOVERED))?.login !== login;
    const added: string[] = [];
    for (const pr of found) {
      const key = keyFor({ kind: "pr", number: pr.number, repo: pr.repo });
      if (store.getReview(key) || store.isDiscoveryIgnored(key)) continue;
      store.saveReview({ targetKey: key, kind: "pr", number: pr.number, repo: pr.repo, title: pr.title, author: pr.author ?? undefined, url: pr.url, status: "tracked", createdAt: clock(), projectId });
      if (!first && pr.requested && !pr.reviewed) store.setLifecycle(key, { newRequest: true });
      added.push(key);
    }
    await bb.storage.kv.set(DISCOVERED, { login, at: clock() });
    if (!added.length) return;
    await read(added);
    bb.realtime.publish("reviews", { ts: clock() });
  }

  function one(targetKey: string, force = false): Promise<void> {
    if (disposed) return Promise.resolve();
    const review = store.getReview(targetKey);
    if (!readable(review)) return maintainThread(targetKey);
    if (!force && clock() - (checked.get(targetKey) ?? 0) < MINUTE) return inflight.get(targetKey) ?? Promise.resolve();
    return read([targetKey]);
  }

  async function all(force = false): Promise<void> {
    if (disposed) return;
    // A failed check of notifications is no reason to read everything more often.
    const gate = await github.gate.poll().catch(() => ({ kind: "unchanged" as const }));
    const changed = new Set(gate.kind === "changed" ? gate.prs.map((pr) => `${pr.repo}#${pr.number}`) : []);
    const now = clock();
    // Without notifications, reviews in progress are read every minute instead.
    const interval = (group: Turn["group"]) => gate.kind === "unsupported" && (group === "needs" || group === "waiting") ? MINUTE : INTERVAL[group];
    const reviews = store.listReviews();
    const due = reviews.filter(readable).filter((r) => force || changed.has(`${r.repo.toLowerCase()}#${r.number}`)
      || now - (checked.get(r.targetKey) ?? 0) >= interval(turnOf(r, now).group));
    await read(due.map((r) => r.targetKey));
    for (const review of reviews) if (!disposed) await maintainThread(review.targetKey);
    if (force || now - lastDiscovery >= DISCOVER_EVERY) {
      lastDiscovery = now;
      discovering ??= discover().catch((error) => bb.log.warn(`Could not look for reviews on GitHub: ${String(error)}`)).finally(() => { discovering = null; });
      await discovering;
    }
    // Turns also change with time, such as a quiet period ending, and waiting alerts may be ready.
    const readKeys = new Set(due.map((r) => r.targetKey));
    for (const review of store.listReviews()) if (!disposed && !readKeys.has(review.targetKey)) await evaluate(review.targetKey).catch(() => {});
  }

  /** The active GitHub account changed: read who you are, your teams, your notifications, and your threads again. */
  function resetViewer() {
    github.viewer.reset();
    github.gate.reset?.();
    checked.clear();
    store.clearFeedbackFetches();
  }

  return { one, all, evaluate, turnOf, resetViewer };
}
