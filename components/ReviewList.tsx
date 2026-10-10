import { memo, useCallback, useEffect, useId, useMemo, useState } from "react";
import { useRpc, useBbNavigate, useRealtime } from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "../src/rpc-contract";
import { reviewState, type ReviewItem } from "../lib/review-state";
import { cn } from "../lib/utils";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Icon } from "./ui/icon";
import { Skeleton } from "./ui/skeleton";
import { SetupReadiness } from "./ReleaseSettings";
import { AccountBar } from "./AccountBar";
import { ReviewActions } from "./ReviewActions";
import { Popover, PopoverContent, PopoverTrigger } from "./ui/popover";
import { Avatar } from "./ui/avatar";
import { StatusBadge, kindLook } from "./ReviewStatus";
import { Badge, TONE_TEXT } from "./ui/badge";
import type { Turn, TurnGroup } from "../lib/turn";
import { IconTile } from "./ui/icon-tile";
import { InlineCode } from "./ui/inline-code";
import { age, timeAgo } from "./time-ago";

/** Why it's your turn, with who asked when GitHub says. Null when the status badge says it all. */
function turnWhy(review: ReviewItem, turn: Turn): string | null {
  const s = review.signals ?? {};
  const by = (prefix: string, login?: string | null) => login ? `${prefix} @${login}` : null;
  const why = turn.reason === "re-requested" ? by("Re-requested by", s.requestedBy) ?? "Re-requested"
    : turn.reason === "requested" ? by("Requested by", s.requestedBy) ?? "Review requested"
    : turn.reason === "team-requested" ? by("Team request from", s.requestedBy) ?? "Team review requested"
    : turn.reason === "question" ? (turn.label === "Author replied" || (turn.at != null && turn.at !== s.questionAt && turn.at === s.replyAt) ? "Author replied" : "Question for you")
    : turn.reason === "mentioned" ? by("Mentioned by", s.mentionBy) ?? "Mentioned you"
    : turn.reason === "handled" ? "Feedback handled"
    : turn.reason === "looks-ready" ? "Looks ready"
    : turn.reason === "dismissed" ? "Review dismissed"
    : null;
  return why === turn.label ? null : why;
}

const CI_LOOK = {
  pass: { label: "Checks passing", tone: "success", icon: "Check" },
  fail: { label: "Checks failing", tone: "danger", icon: "X" },
  pending: { label: "Checks pending", tone: "warning", icon: "CircleDashed" },
} as const;

/** The row's second line: why, progress on your feedback, new commits, CI, and how long it's been your turn. */
function TurnMeta({ review, turn }: { review: ReviewItem; turn: Turn }) {
  const why = turnWhy(review, turn);
  const progress = review.progress;
  const commits = review.signals?.commitsSince ?? 0;
  const ci = review.signals?.ci && review.signals.ci !== "none" ? CI_LOOK[review.signals.ci] : null;
  const waited = turn.group === "needs" ? age(turn.at) : null;
  if (!why && !progress && commits <= 0 && !ci && !waited && !turn.blocking) return null;
  return (
    <span className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
      {turn.blocking && <Badge tone="warning" size="sm">Blocks merge</Badge>}
      {why && <span>{why}</span>}
      {progress && <span className="tabular-nums">{progress.done}/{progress.total} {progress.source === "assistant" ? "addressed" : "resolved"}</span>}
      {commits > 0 && <span className="inline-flex items-center gap-1 tabular-nums"><Icon name="GitCommit" className="size-3" aria-hidden />+{commits} {commits === 1 ? "commit" : "commits"}</span>}
      {ci && <span className="inline-flex items-center gap-1"><Icon name={ci.icon} className={cn("size-3", TONE_TEXT[ci.tone])} aria-hidden />{ci.label}</span>}
      {waited && <span className="text-subtle-foreground">your turn · {waited}</span>}
    </span>
  );
}

/** Needs review: blocking first, then direct requests before team requests, then longest waiting. */
function needsOrder(a: ReviewItem, b: ReviewItem): number {
  const ta = reviewState(a), tb = reviewState(b);
  return Number(tb.blocking) - Number(ta.blocking)
    || Number(ta.reason === "team-requested") - Number(tb.reason === "team-requested")
    || (ta.at ?? a.createdAt ?? 0) - (tb.at ?? b.createdAt ?? 0);
}

/** Waiting on author: most recent activity first. */
function waitingOrder(a: ReviewItem, b: ReviewItem): number {
  const activity = (review: ReviewItem) => Math.max(reviewState(review).at ?? 0, review.signals?.headSeenAt ?? 0) || (review.createdAt ?? 0);
  return activity(b) - activity(a);
}

function ReviewRow({ review, onOpen, onChanged }: { review: ReviewItem; onOpen: () => void; onChanged: () => void }) {
  const state = reviewState(review);
  const kind = kindLook(review);
  const titleId = useId();
  const when = timeAgo(review.submittedAt ?? review.createdAt);
  return (
    <div className="group/row relative flex min-w-0 items-center pr-1 hover:bg-state-hover sm:pr-2">
    <button type="button" onClick={onOpen} className="flex min-w-0 flex-1 items-center gap-3 py-3 pl-3 pr-1 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring sm:gap-3.5 sm:pl-4">
      <IconTile tone={kind.tone} icon={kind.icon} />
      <span className="min-w-0 flex-1">
        <span id={titleId} className="block text-sm font-medium leading-snug text-foreground"><InlineCode text={review.title ?? review.gitRef ?? review.targetKey} /></span>
        <span className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
          <span className="break-all font-mono text-[11px]">{review.repo ?? review.gitRef}{review.number ? <span className="text-subtle-foreground"> #{review.number}</span> : null}</span>
          {review.author && <span className="inline-flex items-center gap-1.5"><Avatar login={review.author} size={16} />@{review.author}</span>}
          {when && <span className="text-subtle-foreground">{when}</span>}
        </span>
        <TurnMeta review={review} turn={state} />
      </span>
      <span className="flex shrink-0 items-center gap-3">
        <span className="hidden items-center gap-0.5 text-xs text-muted-foreground opacity-0 transition-opacity duration-150 group-hover/row:text-foreground group-hover/row:opacity-100 group-focus-within/row:opacity-100 @min-[640px]/review-list:inline-flex">{state.action}<Icon name="ChevronRight" className="size-3.5" aria-hidden /></span>
        <StatusBadge review={review} />
      </span>
    </button>
    <ReviewActions review={review} onChanged={onChanged} onDeleted={onChanged} describedBy={titleId} />
    </div>
  );
}

/** Shown in an empty list: an icon in a soft disc, a heading, and a line of help. */
function EmptyState({ icon, tone, title, children }: { icon: Parameters<typeof Icon>[0]["name"]; tone: "success" | "neutral"; title: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col items-center px-6 py-14 text-center">
      <span aria-hidden className={cn("mb-3 flex size-11 items-center justify-center rounded-full ring-1 ring-inset", tone === "success" ? "bg-success/10 text-diff-added ring-success/20" : "bg-muted/50 text-muted-foreground ring-border")}>
        <Icon name={icon} className="size-5" />
      </span>
      <h2 className="text-sm font-medium text-foreground">{title}</h2>
      <p className="mt-1 max-w-sm text-sm leading-relaxed text-muted-foreground">{children}</p>
    </div>
  );
}

export const ReviewList = memo(function ReviewList() {
  const rpc = useRpc<typeof rpcContract>();
  const navigate = useBbNavigate();
  const [reviews, setReviews] = useState<ReviewItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [input, setInput] = useState("");
  const [starting, setStarting] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const [filter, setFilter] = useState<TurnGroup>("needs");
  const [refreshing, setRefreshing] = useState(false);
  const [syncError, setSyncError] = useState(false);
  const refresh = useCallback(async () => {
    setRefreshing(true); setSyncError(false);
    try { const result = await rpc.call("refreshReviews", null); setReviews(result.reviews); }
    catch { setSyncError(true); }
    finally { setRefreshing(false); }
  }, [rpc]);
  const relist = useCallback(() => {
    void rpc.call("listReviews", null).then((result) => setReviews(result.reviews)).catch(() => {});
  }, [rpc]);
  useRealtime("reviews", relist);
  useRealtime("gh-account", () => { void refresh(); });
  useEffect(() => {
    const onFocus = () => { void refresh(); };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [refresh]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setLoadError(false);
    rpc
      .call("listReviews", null)
      .then((r) => {
        if (!cancelled) setReviews(r.reviews as ReviewItem[]);
      })
      .catch(() => {
        if (!cancelled) setLoadError(true);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [rpc, reload]);

  const sorted = useMemo(
    () => [...reviews].sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0)),
    [reviews],
  );

  const visible = sorted.filter((review) => reviewState(review).group === filter);
  if (filter === "needs") visible.sort(needsOrder);
  if (filter === "waiting") visible.sort(waitingOrder);
  const teamStart = filter === "needs" ? visible.findIndex((review) => reviewState(review).reason === "team-requested") : -1;
  const row = (review: ReviewItem) => <ReviewRow key={review.targetKey} review={review} onOpen={() => open(review.targetKey)} onChanged={relist} />;

  function open(targetKey: string) {
    navigate.toPluginPanel("review", { subPath: targetKey });
  }

  async function startReview() {
    const value = input.trim();
    if (!value || starting) return;
    setStarting(true);
    setStartError(null);
    try {
      const res = await rpc.call("startReview", { input: value });
      if (res.ok && res.targetKey) {
        setInput("");
        open(res.targetKey);
      } else {
        setStartError(res.error ?? "Couldn't start review. Try again.");
      }
    } catch (err) {
      setStartError(err instanceof Error ? err.message : "Couldn't start review. Try again.");
    } finally {
      setStarting(false);
    }
  }

  const tabs = [
    { value: "needs", label: "Needs review", icon: "ListTodo" },
    { value: "waiting", label: "Waiting on author", icon: "TimeSchedule" },
    { value: "reviewed", label: "Reviewed", icon: "CircleCheck" },
    { value: "archive", label: "Archive", icon: "Archive" },
  ] as const;

  return (
    <div className="@container/review-list flex min-h-full w-full min-w-0 flex-col gap-6 p-4 sm:p-6" style={{ backgroundColor: "rgb(from var(--background) r g b / 1)" }}>
      <section aria-label="Start a review" className="mx-auto w-full max-w-6xl space-y-5">
        <header className="flex min-w-0 items-center justify-between gap-3">
          <div className="flex min-w-0 items-center gap-3">
            <span aria-hidden className="hidden size-10 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary ring-1 ring-inset ring-primary/20 @min-[420px]/review-list:flex">
              <Icon name="Route" className="size-5" />
            </span>
            <div className="min-w-0">
              <h1 className="text-lg font-semibold tracking-tight text-foreground sm:text-xl">Guided Review</h1>
              <p className="text-sm text-muted-foreground">A focused workspace for your pull requests.</p>
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            <AccountBar />
            <Button variant="ghost" size="sm" aria-label="Settings" onClick={() => navigate.toPluginPanel("review", { subPath: "settings" })}>
              <Icon name="Settings" className="size-4" aria-hidden /><span className="hidden @min-[520px]/review-list:inline">Settings</span>
            </Button>
          </div>
        </header>

          <form
            onSubmit={(e) => {
              e.preventDefault();
              void startReview();
            }}
          >
            <div className="flex items-center gap-2">
              <div className="relative min-w-0 flex-1">
                <Icon
                  name="GitPullRequest"
                  className="pointer-events-none absolute left-3.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
                  aria-hidden
                />
                <Input
                  value={input}
                  onChange={(e) => { setInput(e.target.value); setStartError(null); }}
                  aria-invalid={!!startError}
                  aria-describedby={startError ? "review-start-error" : "review-start-help"}
                  placeholder="Paste a GitHub PR URL to review…"
                  aria-label="GitHub PR URL"
                  className="h-11 rounded-lg border-border bg-surface-raised pl-10 text-sm shadow-xs hover:border-input focus-visible:border-primary/60 focus-visible:ring-[3px] focus-visible:ring-primary/20 aria-invalid:border-destructive/60"
                />
              </div>
              <Button
                type="submit"
                size="lg"
                disabled={starting || !input.trim()}
                className="h-11 shrink-0 gap-2 rounded-lg px-3 sm:px-5"
              >
                {starting ? (
                  <>
                    <Icon name="Loading" className="size-4 animate-spin motion-reduce:animate-none" aria-hidden />
                    Starting
                  </>
                ) : (
                  <>
                    <Icon name="Sparkles" className="size-4" aria-hidden />
                    Review
                  </>
                )}
              </Button>
            </div>
            {startError && <p id="review-start-error" role="alert" className="mt-3 flex items-start gap-1.5 break-words text-sm text-destructive-text"><Icon name="AlertCircle" className="mt-0.5 size-4 shrink-0" aria-hidden />{startError}</p>}
            <div className="mt-2 flex items-start justify-between gap-3">
              <p id="review-start-help" className="py-1 text-xs leading-6 text-muted-foreground">Or use <code className="rounded-md border border-border bg-muted/50 px-1.5 py-0.5 font-mono text-[11px] text-[var(--kanagawa-md-code,var(--foreground))]">bb review &lt;pr&gt;</code></p>
              <Popover>
                <PopoverTrigger asChild><Button type="button" variant="ghost" size="sm" className="shrink-0 text-muted-foreground"><Icon name="CircleQuestion" className="size-3.5" aria-hidden /> Review help</Button></PopoverTrigger>
                <PopoverContent align="end" className="w-96 max-w-[calc(100vw-24px)] space-y-3 p-4 text-sm leading-relaxed">
                  <p className="font-medium">Start your first review</p>
                  <p className="text-muted-foreground">Connect a coding-agent provider in BB, then authenticate GitHub CLI on the BB server with <code className="font-mono text-xs">gh auth login</code>.</p>
                  <p className="text-muted-foreground">Paste a pull request URL above. For a local change, run <code className="font-mono text-xs">bb review origin/main...HEAD</code> from its repository on that server.</p>
                  <p className="text-muted-foreground">Read the chapters and save draft comments. GitHub receives your review when you choose Submit to GitHub. Thread replies and resolve actions are posted when selected.</p>
                </PopoverContent>
              </Popover>
            </div>
          </form>
      </section>

      {!loading && !loadError && sorted.length === 0 && <div className="mx-auto w-full max-w-6xl"><SetupReadiness /></div>}
      <section aria-label="Saved reviews" className="mx-auto w-full min-w-0 max-w-6xl overflow-hidden rounded-xl border border-border bg-card shadow-xs">
        <div className="flex min-w-0 items-center justify-between gap-2 border-b border-border bg-muted/25 px-2 py-1.5">
          <div role="group" aria-label="Filter reviews" className="flex min-w-0 items-center gap-1 overflow-x-auto">
            {tabs.map(({ value, label, icon }) => (
              <Button key={value} variant="ghost" size="sm" aria-pressed={filter === value} onClick={() => setFilter(value)} className="group/tab shrink-0 gap-2 px-2 text-muted-foreground @min-[520px]/review-list:px-2.5">
                <Icon name={icon} className="hidden size-3.5 group-aria-pressed/tab:text-primary @min-[520px]/review-list:block" aria-hidden />
                {label}<span className="min-w-5 rounded-full bg-muted px-1.5 text-center text-[11px] leading-[18px] tabular-nums text-muted-foreground group-aria-pressed/tab:bg-primary/20 group-aria-pressed/tab:text-primary">{sorted.filter((r) => reviewState(r).group === value).length}</span>
              </Button>
            ))}
          </div>
          <Button variant="ghost" size="sm" aria-label={refreshing ? "Refreshing…" : "Refresh"} className="shrink-0 px-2 text-muted-foreground" disabled={refreshing} onClick={() => void refresh()}><Icon name="ArrowReloadHorizontal" className={cn("size-3.5", refreshing && "animate-spin motion-reduce:animate-none")} aria-hidden /><span className="hidden @min-[520px]/review-list:inline">{refreshing ? "Refreshing…" : "Refresh"}</span></Button>
        </div>
        {syncError && <p role="alert" className="flex items-center gap-2 border-b border-destructive/20 bg-destructive/10 px-4 py-2.5 text-sm text-destructive-text"><Icon name="AlertCircle" className="size-4 shrink-0" aria-hidden />Couldn’t refresh GitHub status. Saved reviews are still available; try Refresh again.</p>}
        {loading ? <div role="status" aria-busy="true" className="divide-y divide-border"><span className="sr-only">Loading reviews…</span>{Array.from({ length: 4 }).map((_, i) => <div key={i} className="flex items-center gap-3.5 px-4 py-3.5"><Skeleton className="size-8 shrink-0 rounded-lg" /><div className="flex-1 space-y-2"><Skeleton className="h-3.5" style={{ width: `${62 - i * 7}%` }} /><Skeleton className="h-3 w-48" /></div><Skeleton className="h-5 w-16 rounded-full" /></div>)}</div>
          : loadError ? <div role="alert" className="px-4 py-10 text-center"><h2 className="font-medium">Couldn’t load your reviews</h2><p className="mt-2 text-sm text-muted-foreground">Your saved reviews haven’t been removed. Check the connection and try again.</p><Button variant="outline" className="mt-4" onClick={() => setReload((n) => n + 1)}>Try again</Button></div>
          : visible.length === 0 ? (filter === "archive" ? <EmptyState icon="Archive" tone="neutral" title="No archived reviews">Merged and closed pull requests move here automatically, along with reviews you archive.</EmptyState>
            : filter === "waiting" ? <EmptyState icon="TimeSchedule" tone="neutral" title="Nothing waiting on authors">Reviews where you requested changes wait here until the author re-requests your review, answers your feedback, or asks you something.</EmptyState>
            : filter === "reviewed" ? <EmptyState icon="CircleCheck" tone="neutral" title="No submitted reviews yet">Your submitted verdicts appear here, ready to revisit.</EmptyState>
            : sorted.length ? <EmptyState icon="Check" tone="success" title="You’re all caught up">Paste a pull request URL above to start a review.</EmptyState>
            : <EmptyState icon="GitPullRequest" tone="neutral" title="No reviews yet">Paste a pull request URL above to start a review.</EmptyState>)
          : teamStart < 0 ? <div className="divide-y divide-border">{visible.map(row)}</div>
          : <>
            {teamStart > 0 && <div className="divide-y divide-border border-b border-border">{visible.slice(0, teamStart).map(row)}</div>}
            <h2 className="bg-muted/25 px-4 py-1.5 text-xs font-medium text-muted-foreground">Team requests</h2>
            <div className="divide-y divide-border border-t border-border">{visible.slice(teamStart).map(row)}</div>
          </>}
      </section>
    </div>
  );
});
ReviewList.displayName = "ReviewList";
