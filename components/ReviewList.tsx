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

/** Compact "2h ago" relative time. Returns null for absent/implausible stamps. */
function timeAgo(ts?: number): string | null {
  if (typeof ts !== "number" || !Number.isFinite(ts) || ts < 1_000_000_000_000) return null;
  const s = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (s < 45) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d}d ago`;
  const w = Math.floor(d / 7);
  if (w < 5) return `${w}w ago`;
  const mo = Math.floor(d / 30);
  if (mo < 12) return `${mo}mo ago`;
  return `${Math.floor(d / 365)}y ago`;
}

function isPrReview(r: ReviewItem): boolean {
  return r.kind === "pr" || r.number != null;
}

function ReviewRow({ review, onOpen, onChanged }: { review: ReviewItem; onOpen: () => void; onChanged: () => void }) {
  const state = reviewState(review);
  const titleId = useId();
  return (
    <div className="group flex min-w-0 items-center border-b border-border pr-1 last:border-b-0 hover:bg-state-hover sm:pr-2">
    <button type="button" onClick={onOpen} className="flex min-w-0 flex-1 items-center gap-3 px-2 py-4 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring sm:gap-4 sm:px-3">
      <Icon name={review.prState === "MERGED" ? "GitMerge" : isPrReview(review) ? "GitPullRequest" : "GitBranch"} className="size-4 shrink-0 text-muted-foreground" aria-hidden />
      <span className="min-w-0 flex-1 space-y-1">
        <span id={titleId} className="block text-sm font-medium leading-snug text-foreground">{review.title ?? review.gitRef ?? review.targetKey}</span>
        <span className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
          <span className="break-all">{review.repo ?? review.gitRef}{review.number ? ` #${review.number}` : ""}</span>
          {review.author && <span>@{review.author}</span>}
          <span>{timeAgo(review.submittedAt ?? review.createdAt)}</span>
        </span>
      </span>
      <span className="flex shrink-0 flex-col items-end gap-1.5">
        <span className={cn("inline-flex items-center gap-1.5 text-xs font-medium", state.label === "Approved" ? "text-emerald-700 dark:text-emerald-400" : state.label === "Failed" ? "text-destructive" : "text-muted-foreground")}>
          {state.label === "Approved" && <Icon name="Check" className="size-3.5" aria-hidden />}
          {state.label === "Generating" && <Icon name="Loading" className="size-3.5 animate-spin motion-reduce:animate-none" aria-hidden />}
          {state.label}
        </span>
        <span className="hidden items-center gap-1 text-xs text-muted-foreground group-hover:text-foreground sm:inline-flex">{state.action}<Icon name="ChevronRight" className="size-3.5" aria-hidden /></span>
      </span>
    </button>
    <ReviewActions review={review} onChanged={onChanged} onDeleted={onChanged} describedBy={titleId} />
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
  const [filter, setFilter] = useState<"active" | "reviewed" | "archive">("active");
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

  return (
    <div className="@container/review-list flex min-h-full w-full min-w-0 flex-col gap-6 p-4 sm:p-6" style={{ backgroundColor: "rgb(from var(--background) r g b / 1)" }}>
      <section aria-label="Start a review" className="space-y-5">
        <header className="space-y-1.5">
          <div className="flex min-w-0 items-center justify-between gap-2">
            <h1 className="min-w-0 text-lg font-semibold tracking-tight text-foreground sm:text-xl">Guided Review</h1>
            <div className="flex shrink-0 items-center gap-1">
              <AccountBar />
              <Button variant="ghost" size="sm" aria-label="Settings" onClick={() => navigate.toPluginPanel("review", { subPath: "settings" })}>
                <Icon name="Settings" className="size-4" aria-hidden /><span className="hidden @min-[520px]/review-list:inline">Settings</span>
              </Button>
            </div>
          </div>
          <p className="text-sm text-muted-foreground">A focused workspace for your pull requests.</p>
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
                  className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
                  aria-hidden
                />
                <Input
                  value={input}
                  onChange={(e) => { setInput(e.target.value); setStartError(null); }}
                  aria-invalid={!!startError}
                  aria-describedby={startError ? "review-start-error" : "review-start-help"}
                  placeholder="Paste a GitHub PR URL to review…"
                  aria-label="GitHub PR URL"
                  className="h-11 pl-9 text-sm"
                />
              </div>
              <Button
                type="submit"
                size="lg"
                disabled={starting || !input.trim()}
                className="h-11 shrink-0 gap-2 px-3 sm:px-5"
              >
                {starting ? (
                  <>
                    <Icon name="Loading" className="size-4 animate-spin motion-reduce:animate-none" aria-hidden />
                    Starting
                  </>
                ) : (
                  <>
                    <Icon name="AiContentGenerator01" className="size-4" aria-hidden />
                    Review
                  </>
                )}
              </Button>
            </div>
            {startError && <p id="review-start-error" role="alert" className="mt-3 break-words text-sm text-destructive">{startError}</p>}
            <div className="mt-2 flex items-start justify-between gap-3">
              <p id="review-start-help" className="py-1 text-xs leading-6 text-muted-foreground">Or use <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-[11px] text-foreground">bb review &lt;pr&gt;</code></p>
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

      {!loading && !loadError && sorted.length === 0 && <SetupReadiness />}
      <section aria-label="Saved reviews" className="min-w-0">
        <div className="flex min-w-0 items-center justify-between gap-2 border-b border-border pb-2">
          <div role="group" aria-label="Filter reviews" className="flex min-w-0 items-center gap-1 overflow-x-auto">
            {([['active', 'Needs review'], ['reviewed', 'Reviewed'], ['archive', 'Archive']] as const).map(([value, label]) => (
              <Button key={value} variant="ghost" size="sm" aria-pressed={filter === value} onClick={() => setFilter(value)} className={cn("shrink-0 gap-2 px-2 @min-[520px]/review-list:px-3", filter === value && "bg-state-active text-foreground")}>
                {label}<span className="text-xs tabular-nums text-muted-foreground">{sorted.filter((r) => reviewState(r).group === value).length}</span>
              </Button>
            ))}
          </div>
          <Button variant="ghost" size="sm" aria-label={refreshing ? "Refreshing…" : "Refresh"} className="shrink-0 px-2" disabled={refreshing} onClick={() => void refresh()}><Icon name="ArrowReloadHorizontal" className={cn("size-3.5", refreshing && "animate-spin motion-reduce:animate-none")} aria-hidden /><span className="hidden @min-[520px]/review-list:inline">{refreshing ? "Refreshing…" : "Refresh"}</span></Button>
        </div>
        {syncError && <p role="alert" className="py-3 text-sm text-destructive">Couldn’t refresh GitHub status. Saved reviews are still available; try Refresh again.</p>}
        {loading ? <div role="status" aria-busy="true" className="space-y-4 py-4"><span className="sr-only">Loading reviews…</span>{Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-12 w-full" />)}</div>
          : loadError ? <div role="alert" className="py-8"><h2 className="font-medium">Couldn’t load your reviews</h2><p className="mt-2 text-sm text-muted-foreground">Your saved reviews haven’t been removed. Check the connection and try again.</p><Button variant="outline" className="mt-4" onClick={() => setReload((n) => n + 1)}>Try again</Button></div>
          : visible.length === 0 ? <div className="py-12 text-center"><h2 className="text-sm font-medium">{filter === "archive" ? "No archived reviews" : filter === "reviewed" ? "No submitted reviews yet" : sorted.length ? "You’re all caught up" : "No reviews yet"}</h2><p className="mt-2 text-sm text-muted-foreground">{filter === "archive" ? "Merged and closed pull requests move here automatically, along with reviews you archive." : filter === "reviewed" ? "Your submitted verdicts appear here, ready to revisit." : "Paste a pull request URL above to start a review."}</p></div>
          : <div>{visible.map((review) => <ReviewRow key={review.targetKey} review={review} onOpen={() => open(review.targetKey)} onChanged={relist} />)}</div>}
      </section>
    </div>
  );
});
ReviewList.displayName = "ReviewList";
