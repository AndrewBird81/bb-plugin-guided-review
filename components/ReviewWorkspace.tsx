import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRpc, useRealtime, useBbNavigate } from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import type { SelectedLineRange } from "@pierre/diffs";
import type { rpcContract } from "../src/rpc-contract";
import type { CommentLocation } from "../src/draft";
import { cn } from "../lib/utils";
import { experimental_useCodeTheme } from "@get-bb/plugin-sdk/app";
import { useMediaQuery } from "./ui/hooks/use-media-query";
import { getReviewState, patchReviewState, setLastReview } from "../lib/panel-state";
import { Button } from "./ui/button";
import { Icon } from "./ui/icon";
import { ReviewHeader, ReviewTitleLink } from "./ReviewHeader";
import { ChapterNav } from "./ChapterNav";
import { DiffViewer, type FileViewFlags } from "./DiffViewer";
import { DraftTray, type CommentPrefill } from "./DraftTray";
import { RereviewBanner } from "./RereviewBanner";
import { ThreadsPanel } from "./ThreadsPanel";
import type { DockInjection } from "./AgentDock";
import { ReviewSkeleton, ReviewError } from "./ReviewSkeleton";
import { kindLook } from "./ReviewStatus";
import { IconTile } from "./ui/icon-tile";
import { Hint } from "./ui/hint";
import { ReviewActions } from "./ReviewActions";
import { defaultPreferences } from "../lib/review-preferences";

const SIDEBAR_MIN = 200;
const SIDEBAR_MAX = 560;

export const ReviewWorkspace = memo(function ReviewWorkspace({ targetKey }: { targetKey: string }) {
  const rpc = useRpc<typeof rpcContract>();
  const navigate = useBbNavigate();
  const codeTheme = experimental_useCodeTheme();
  const compact = useMediaQuery("(max-width: 767px)");
  const [mobileChapters, setMobileChapters] = useState(false);
  const [diffLayout, setDiffLayout] = useState(defaultPreferences.diffLayout);
  const [loading, setLoading] = useState(true);
  const [generatingReplacement, setGeneratingReplacement] = useState(false);
  const hasDisplayedGuide = useRef(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [rebuilding, setRebuilding] = useState(false);
  const request = useRef(0);
  const resizeCleanup = useRef<(() => void) | null>(null);
  const persisted = useMemo(() => getReviewState(targetKey), [targetKey]);

  const [review, setReview] = useState<any>(null);
  const [guide, setGuide] = useState<any>(null);
  const [patch, setPatch] = useState("");
  const [checks, setChecks] = useState<{ bucket: string; checks: any[] } | null>(null);
  const [activeId, setActiveId] = useState("");
  const [view, setView] = useState<"diff" | "threads">(persisted.view ?? "diff");
  const [revision, setRevision] = useState("");
  const [repoAccess, setRepoAccess] = useState<{ accessible: boolean; repo: string | null; account: string | null } | null>(null);
  const [views, setViews] = useState<Map<string, FileViewFlags>>(new Map());
  const [injection, setInjection] = useState<DockInjection | undefined>();
  const [currentFile, setCurrentFile] = useState<string | undefined>();
  const [sel, setSel] = useState<{ x: number; y: number; file: string; code: string } | null>(null);
  const [lineSel, setLineSel] = useState<{ file: string; range: SelectedLineRange } | null>(null);
  const [draftPrefill, setDraftPrefill] = useState<CommentPrefill | undefined>();
  const [reveal, setReveal] = useState<{ at: CommentLocation; nonce: number }>();

  // Screen utilization: resizable/collapsible sidebar, focus mode, fullscreen.
  const [sidebarWidth, setSidebarWidth] = useState(persisted.sidebarWidth ?? 288);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [focus, setFocus] = useState(persisted.focus ?? false);
  const [isFullscreen, setIsFullscreen] = useState(false);

  const fileEls = useRef<Map<string, HTMLElement>>(new Map());
  const pendingScroll = useRef<string | null>(null);
  const scrollBox = useRef<HTMLDivElement>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const [rootEl, setRootEl] = useState<HTMLDivElement | null>(null);
  const didRestoreScroll = useRef(false);
  const reducedMotion =
    typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

  useEffect(() => setLastReview(targetKey), [targetKey]);
  const loadPreferences = useCallback(() => {
    void rpc.call("getPreferences", null).then(({ preferences }) => setDiffLayout(preferences.diffLayout)).catch(() => {});
  }, [rpc]);
  useEffect(loadPreferences, [loadPreferences]);
  useRealtime("preferences", loadPreferences);
  useEffect(() => patchReviewState(targetKey, { activeId, view, sidebarWidth, focus }), [targetKey, activeId, view, sidebarWidth, focus]);

  const loadViews = useCallback(async () => {
    try {
      const { views } = await rpc.call("getFileViews", { targetKey });
      setViews(new Map(views.map((v: any) => [v.file, { viewed: v.viewed, stale: v.stale }])));
    } catch {
      // Non-fatal — the diff just won't show viewed state.
    }
  }, [rpc, targetKey]);

  const load = useCallback(async () => {
    const id = ++request.current;
    setLoadError(null);
    try {
      const [{ review, guide, patch, revision }, checksRes] = await Promise.all([
        rpc.call("getReviewBundle", { targetKey }),
        rpc.call("getChecks", { targetKey }).catch(() => null),
      ]);
      if (id !== request.current) return;
      // A deleted review shows "Review not found" rather than a pending regeneration.
      if (!review) hasDisplayedGuide.current = false;
      if (!guide && hasDisplayedGuide.current) {
        setGeneratingReplacement(true);
        if (review?.status === "error") setLoadError("Couldn’t regenerate the guide. Your previous view and unsaved edits are still here.");
        return;
      }
      hasDisplayedGuide.current = !!guide;
      setGeneratingReplacement(false);
      setRevision(revision);
      setReview(review);
      setGuide(guide);
      setPatch(patch);
      setChecks(checksRes);
      if (guide?.sections?.length) {
        const saved = getReviewState(targetKey).activeId;
        setActiveId((prev) => guide.sections.some((section: any) => section.id === prev)
          ? prev : guide.sections.some((section: any) => section.id === saved) ? saved! : guide.sections[0].id);
      }
      void loadViews();
    } catch (err) {
      if (id === request.current) setLoadError(err instanceof Error ? err.message : "Check the connection and try again.");
    } finally {
      if (id === request.current) setLoading(false);
    }
  }, [rpc, targetKey, loadViews]);

  useEffect(() => {
    void load();
    return () => { request.current++; resizeCleanup.current?.(); };
  }, [load]);
  useRealtime(`review:${targetKey}`, () => { void load(); });

  async function rebuild() {
    if (rebuilding) return;
    setRebuilding(true);
    setLoadError(null);
    try {
      const result = await rpc.call("rereview", { targetKey });
      if (!result.ok) setLoadError(result.error ?? "Couldn’t rebuild the guide.");
      else await load();
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : "Couldn’t rebuild the guide.");
    } finally { setRebuilding(false); }
  }

  const checkAccess = useMemo(
    () => async () => {
      try {
        const r = await rpc.call("checkRepoAccess", { targetKey });
        setRepoAccess(r);
      } catch {
        // Non-fatal: access banner just won't show.
      }
    },
    [rpc, targetKey],
  );

  useEffect(() => {
    if (guide) void checkAccess();
  }, [guide, checkAccess]);
  useRealtime("gh-account", () => {
    void checkAccess();
  });

  // Track browser fullscreen state so the toggle icon/label stays correct.
  useEffect(() => {
    const onChange = () => setIsFullscreen(document.fullscreenElement === rootRef.current);
    document.addEventListener("fullscreenchange", onChange);
    return () => document.removeEventListener("fullscreenchange", onChange);
  }, []);

  const toggleFullscreen = useCallback(() => {
    if (document.fullscreenElement) void document.exitFullscreen().catch(() => {});
    else if (rootRef.current?.requestFullscreen) void rootRef.current.requestFullscreen().catch(() => {});
  }, []);

  const activeFiles: string[] = useMemo(() => {
    const s = guide?.sections?.find((x: any) => x.id === activeId);
    return s ? s.diffs.map((d: any) => d.file) : [];
  }, [guide, activeId]);

  useEffect(() => {
    setCurrentFile(activeFiles[0]);
  }, [activeFiles]);

  // Restore the saved scroll position once the diff has content to scroll.
  useEffect(() => {
    if (didRestoreScroll.current || !patch || view !== "diff" || !scrollBox.current) return;
    const top = getReviewState(targetKey).scrollTop;
    if (top) scrollBox.current.scrollTop = top;
    didRestoreScroll.current = true;
  }, [patch, view, targetKey]);

  const toggleViewed = useCallback(
    (file: string, viewed: boolean) => {
      setViews((prev) => {
        const next = new Map(prev);
        next.set(file, { viewed, stale: false });
        return next;
      });
      rpc
        .call("setFileViewed", { targetKey, file, viewed })
        .then(() => loadViews())
        .catch(() => loadViews());
    },
    [rpc, targetKey, loadViews],
  );

  const markAllViewed = useCallback(() => {
    const todo = activeFiles.filter((f) => !views.get(f)?.viewed);
    for (const f of todo) toggleViewed(f, true);
  }, [activeFiles, views, toggleViewed]);

  const registerFileEl = useCallback((file: string, el: HTMLElement | null) => {
    if (el) fileEls.current.set(file, el);
    else fileEls.current.delete(file);
  }, []);

  const scrollToFile = useCallback(
    (file: string) => {
      const el = fileEls.current.get(file);
      if (el) el.scrollIntoView({ behavior: reducedMotion ? "auto" : "smooth", block: "start" });
    },
    [reducedMotion],
  );

  const onSelectFile = useCallback(
    (chapterId: string, file: string) => {
      if (chapterId !== activeId) {
        pendingScroll.current = file;
        setActiveId(chapterId);
      } else {
        scrollToFile(file);
      }
      setCurrentFile(file);
      setMobileChapters(false);
    },
    [activeId, scrollToFile],
  );

  // A comment chosen in the draft panel: show its line in the diff.
  const showComment = useCallback((at: CommentLocation) => {
    const chapter = guide?.sections.find((section: any) => section.diffs.some((diff: any) => diff.file === at.file));
    if (!chapter) return;
    setView("diff");
    setActiveId(chapter.id);
    setMobileChapters(false);
    setReveal({ at, nonce: Date.now() });
  }, [guide]);
  // The diff remounts after Threads; it shouldn't jump back to an old comment.
  useEffect(() => { if (view !== "diff") setReveal(undefined); }, [view]);

  useEffect(() => {
    if (pendingScroll.current && activeFiles.includes(pendingScroll.current)) {
      const f = pendingScroll.current;
      pendingScroll.current = null;
      requestAnimationFrame(() => scrollToFile(f));
    }
  }, [activeFiles, scrollToFile]);

  // Persist scroll (debounced) and track the file nearest the viewport top.
  const scrollSaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (scrollSaveTimer.current) clearTimeout(scrollSaveTimer.current); }, []);
  const onScroll = useCallback(() => {
    const box = scrollBox.current;
    if (!box) return;
    const top = box.getBoundingClientRect().top;
    let best: string | undefined;
    let bestTop = -Infinity;
    for (const [file, el] of fileEls.current) {
      const t = el.getBoundingClientRect().top - top;
      if (t <= 80 && t > bestTop) {
        bestTop = t;
        best = file;
      }
    }
    if (best) setCurrentFile(best);
    if (scrollSaveTimer.current) clearTimeout(scrollSaveTimer.current);
    const value = box.scrollTop;
    scrollSaveTimer.current = setTimeout(() => patchReviewState(targetKey, { scrollTop: value }), 200);
  }, [targetKey]);

  const onMouseUp = useCallback(() => {
    const s = window.getSelection();
    const text = s?.toString() ?? "";
    if (!text.trim() || !s || s.rangeCount === 0) {
      setSel(null);
      return;
    }
    const range = s.getRangeAt(0);
    const node = range.commonAncestorContainer;
    const el = node.nodeType === 3 ? node.parentElement : (node as HTMLElement);
    const fileEl = el?.closest("[data-file]") as HTMLElement | null;
    // Text in a draft comment or the comment box isn't code to ask about.
    if (!fileEl || el?.closest("[data-draft-at]")) {
      setSel(null);
      return;
    }
    const r = range.getBoundingClientRect();
    setSel({ x: r.left + r.width / 2, y: r.top, file: fileEl.dataset.file!, code: text.slice(0, 4000) });
  }, []);

  function askAboutSelection() {
    if (!sel) return;
    setInjection({ context: { file: sel.file, code: sel.code, chapterId: activeId }, nonce: Date.now() });
    setSel(null);
    window.getSelection()?.removeAllRanges();
  }

  // GitHub-style line selection in the diff (via pierre) → comment / ask agent.
  const onLineSelected = useCallback((file: string, range: SelectedLineRange | null) => {
    setLineSel(range ? { file, range } : null);
  }, []);

  function commentOnLines(ask = false) {
    if (!lineSel) return;
    const { file, range } = lineSel;
    const side = (range.endSide ?? range.side) === "deletions" ? "LEFT" : "RIGHT";
    setDraftPrefill({ file, line: range.end, side, startLine: range.start, ask, nonce: Date.now() });
    setLineSel(null);
  }

  // Asking opens a box at the lines, and the agent answers there. An archived
  // review's draft can't change, so its lines are quoted into the chat instead.
  function askAboutLines() {
    if (!lineSel) return;
    if (review?.prState !== "MERGED" && review?.prState !== "CLOSED") return commentOnLines(true);
    const { file, range } = lineSel;
    const side = (range.endSide ?? range.side) === "deletions" ? "deletions" : "additions";
    setInjection({
      context: { file, startLine: range.start, endLine: range.end, side, chapterId: activeId },
      nonce: Date.now(),
    });
    setLineSel(null);
  }

  // Sidebar resize drag.
  function startSidebarResize(e: React.PointerEvent) {
    e.preventDefault();
    resizeCleanup.current?.();
    const startX = e.clientX;
    const startW = sidebarWidth;
    function onMove(ev: PointerEvent) {
      const w = Math.min(Math.max(startW + (ev.clientX - startX), SIDEBAR_MIN), SIDEBAR_MAX);
      setSidebarWidth(w);
    }
    function onUp() {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
      resizeCleanup.current = null;
    }
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
    resizeCleanup.current = onUp;
  }

  if (!guide) {
    const back = () => navigate.toPluginPanel("review");
    if (loadError) return <ReviewError title="Couldn’t load this review" message={loadError} onRetry={() => void load()} onBack={back} />;
    if (loading) return <ReviewSkeleton />;
    if (!review) return <ReviewError title="Review not found" message="This review may have been removed. Return to your reviews or refresh the connection." onRetry={() => void load()} onBack={back} />;
    if (review.status === "error") return <ReviewError onRetry={() => void rebuild()} onBack={back} busy={rebuilding} />;
    return <ReviewSkeleton />;
  }

  const viewedCount = activeFiles.filter((f) => views.get(f)?.viewed).length;

  return (
    <div
      ref={(el) => {
        rootRef.current = el;
        setRootEl(el);
      }}
      className="@container/review flex h-full min-h-0 min-w-0 flex-col bg-background"
      style={{ backgroundColor: "rgb(from var(--background) r g b / 1)" }}
    >
      {loadError && <div role="alert" className="flex flex-wrap items-center gap-3 border-b border-destructive/20 bg-destructive/10 px-3 py-2 text-sm text-destructive-text"><Icon name="AlertCircle" className="size-4 shrink-0" aria-hidden /><span className="min-w-0 flex-1">{loadError}</span><Button variant="outline" size="sm" onClick={() => void load()}>Try again</Button></div>}
      <div className="flex flex-wrap items-center gap-2 border-b border-border px-2 py-1"><Button variant="ghost" size="sm" className="gap-1.5 px-2 text-muted-foreground" onClick={() => navigate.toPluginPanel("review")}><Icon name="ChevronLeft" className="size-4" aria-hidden /> All reviews</Button><div className="ml-auto flex flex-wrap items-center gap-1"><Button variant="ghost" size="sm" aria-label="Ask the review agent" className="text-muted-foreground" onClick={() => setInjection({ context: { file: currentFile, chapterId: activeId }, nonce: Date.now() })}><Icon name="Sparkles" className="size-4 text-(--ansi-13)" aria-hidden /> Ask assistant</Button><Button variant="ghost" size="sm" className="text-muted-foreground" onClick={async () => { if (document.fullscreenElement) await document.exitFullscreen(); navigate.toPluginPanel("review", { subPath: `settings/${targetKey}` }); }}><Icon name="Settings" className="size-4" aria-hidden /> Settings</Button><ReviewActions review={review} className="size-8" onChanged={() => void load()} onDeleted={() => { if (document.fullscreenElement) void document.exitFullscreen().catch(() => {}); navigate.toPluginPanel("review"); }} /></div></div>
      {/* Header — full when reviewing normally, slim in focus mode. */}
      {focus ? (
        <div className="flex flex-wrap items-center gap-2.5 border-b border-border px-3 py-2">
          <IconTile {...kindLook(review ?? { targetKey })} className="size-6 rounded-md" iconClassName="size-3.5" />
          <span className="flex min-w-0 flex-1 text-sm font-medium text-foreground">
            <ReviewTitleLink url={review?.url}>{review?.title ?? guide.title ?? targetKey}</ReviewTitleLink>
          </span>
          {generatingReplacement && <p role="status" className="flex items-center gap-1.5 text-xs text-warning-text"><Icon name="Loading" className="size-3.5 animate-spin motion-reduce:animate-none" aria-hidden />Regenerating the guide. Your previous diff and unsaved edits remain visible.</p>}
          {!review?.archivedAt && <RereviewBanner targetKey={targetKey} />}
        </div>
      ) : (
        <div className="border-b border-border">
          <div className="px-4 pb-3.5 pt-3">
            <ReviewHeader review={review} checks={checks} intent={guide.intent} trailing={!review?.archivedAt && <RereviewBanner targetKey={targetKey} />} />
          </div>
          {generatingReplacement && <p role="status" className="flex items-center gap-2 border-t border-warning/20 bg-warning/10 px-4 py-2 text-xs text-warning-text"><Icon name="Loading" className="size-3.5 animate-spin motion-reduce:animate-none" aria-hidden />Regenerating the guide. Your previous diff and unsaved edits remain visible.</p>}
        </div>
      )}
      {repoAccess && !repoAccess.accessible && (
        <p className="flex items-center gap-2 border-b border-destructive/20 bg-destructive/10 px-4 py-1.5 text-xs text-destructive-text">
          <Icon name="Lock" className="size-3.5 shrink-0" aria-hidden />
          <span>Active GitHub account {repoAccess.account ? `@${repoAccess.account}` : ""} can't access{" "}
          {repoAccess.repo ?? "this repo"} — switch account in the review list.</span>
        </p>
      )}
      {review?.status === "error" && (
        <p className="flex items-center gap-2 border-b border-destructive/20 bg-destructive/10 px-4 py-1.5 text-xs text-destructive-text">
          <Icon name="AlertTriangle" className="size-3.5 shrink-0" aria-hidden />
          Re-review failed — showing the previous guide. Try again.
        </p>
      )}
      <div className="flex min-h-0 flex-1 flex-col @min-[1024px]/review:flex-row">
      {/* The draft panel owns the draft and shares it with the diff, which shows each comment under its line. */}
      <DraftTray reviewRevision={revision} account={repoAccess?.account ?? undefined} agent={{ patch, injection, container: rootEl }} review={review} onSubmitted={() => { void load(); }} onShowComment={showComment} isLocal={review?.kind === "ref"} targetKey={targetKey} activeChapterId={activeId} activeFiles={activeFiles} prefill={draftPrefill}>
      <div className="flex min-h-0 min-w-0 flex-1 flex-col md:flex-row">
        {(compact ? mobileChapters : !sidebarCollapsed) && (
          <>
            <aside
              className="max-h-[40vh] shrink-0 overflow-y-auto border-b border-border bg-surface-raised p-2 md:max-h-none md:border-b-0"
              style={{ width: compact ? "100%" : sidebarWidth }}
            >
              <ChapterNav
                sections={guide.sections}
                activeId={activeId}
                onSelect={(id) => { setActiveId(id); setMobileChapters(false); }}
                views={views}
                onSelectFile={onSelectFile}
                currentFile={currentFile}
              />
            </aside>
            {!compact && <div
              tabIndex={0}
              aria-valuemin={SIDEBAR_MIN}
              aria-valuemax={SIDEBAR_MAX}
              aria-valuenow={sidebarWidth}
              onKeyDown={(event) => {
                if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
                event.preventDefault();
                setSidebarWidth((width) => event.key === "Home" ? SIDEBAR_MIN : event.key === "End" ? SIDEBAR_MAX : Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, width + (event.key === "ArrowRight" ? 20 : -20))));
              }}
              role="separator"
              aria-orientation="vertical"
              aria-label="Resize sidebar"
              onPointerDown={startSidebarResize}
              className="group/sep relative w-px shrink-0 cursor-col-resize bg-border before:absolute before:inset-y-0 before:-left-1 before:-right-1 before:content-[''] after:absolute after:inset-y-0 after:left-1/2 after:w-0.5 after:-translate-x-1/2 after:bg-primary/70 after:opacity-0 after:transition-opacity after:content-[''] hover:after:opacity-100 focus-visible:outline-none focus-visible:after:w-1 focus-visible:after:bg-primary focus-visible:after:opacity-100"
            />}
          </>
        )}
        <main className="flex min-w-0 flex-1 flex-col overflow-y-auto">
          <div className="flex flex-wrap items-center gap-2 border-b border-border px-3 py-1.5">
            <Button
              variant="ghost"
              size="sm"
              aria-label={(compact ? !mobileChapters : sidebarCollapsed) ? "Show chapters" : "Hide chapters"}
              aria-pressed={compact ? mobileChapters : !sidebarCollapsed}
              className="h-9 px-1.5 text-muted-foreground aria-pressed:text-primary md:h-7"
              onClick={() => compact ? setMobileChapters((value) => !value) : setSidebarCollapsed((value) => !value)}
            >
              <Icon name="PanelLeft" className="size-4" aria-hidden />
              {compact && "Chapters"}
            </Button>
            <div className="inline-flex items-center gap-0.5 rounded-lg bg-muted/40 p-0.5 ring-1 ring-inset ring-border">
              {(["diff", "threads"] as const).map((value) => (
                <Button
                  key={value}
                  variant="ghost"
                  size="sm"
                  aria-pressed={view === value}
                  className="h-9 gap-1.5 rounded-md px-2.5 text-xs text-muted-foreground aria-pressed:shadow-xs md:h-7"
                  onClick={() => setView(value)}
                >
                  <Icon name={value === "diff" ? "FileDiff" : "MessageSquare"} className="size-3.5" aria-hidden />
                  {value === "diff" ? "Diff" : "Threads"}
                </Button>
              ))}
            </div>
            <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground md:ml-auto">
              {view === "diff" && activeFiles.length > 0 && (
                <>
                  <span className={cn("tabular-nums", viewedCount === activeFiles.length && "text-diff-added")}>{viewedCount} / {activeFiles.length} viewed</span>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-9 px-2 text-xs md:h-7"
                    disabled={viewedCount === activeFiles.length}
                    onClick={markAllViewed}
                  >
                    <Icon name="CircleCheck" className="size-3.5" aria-hidden />
                    Mark all
                  </Button>
                  <span className="h-4 w-px bg-border" />
                </>
              )}
              <Hint label="Focus mode" container={rootEl}>
                <Button
                  variant="ghost"
                  size="sm"
                  aria-label="Focus mode"
                  aria-pressed={focus}
                  className="h-9 px-2 text-xs aria-pressed:text-primary md:h-7"
                  onClick={() => setFocus((f) => !f)}
                >
                  <Icon name="Minimize2" className="size-3.5" aria-hidden />
                  <span className="hidden @min-[1280px]/review:inline">Focus</span>
                </Button>
              </Hint>
              <Hint label={isFullscreen ? "Exit full screen" : "Full screen"} container={rootEl}>
                <Button
                  variant="ghost"
                  size="sm"
                  aria-label={isFullscreen ? "Exit full screen" : "Full screen"}
                  aria-pressed={isFullscreen}
                  className="h-9 px-2 text-xs aria-pressed:text-primary md:h-7"
                  onClick={toggleFullscreen}
                >
                  <Icon name={isFullscreen ? "Minimize2" : "Maximize2"} className="size-3.5" aria-hidden />
                  <span className="hidden @min-[1280px]/review:inline">{isFullscreen ? "Exit" : "Full screen"}</span>
                </Button>
              </Hint>
            </div>
          </div>
          <div ref={scrollBox} onScroll={onScroll} onMouseUp={onMouseUp} className="min-h-0 flex-1 overflow-y-auto px-4 pb-6 pt-4">
            {view === "diff" ? (
              <DiffViewer
                diffLayout={diffLayout}
                themeMode={codeTheme.mode}
                patch={patch}
                files={activeFiles}
                views={views}
                onToggleViewed={toggleViewed}
                registerFileEl={registerFileEl}
                onLineSelected={onLineSelected}
                reveal={reveal}
              />
            ) : (
              <ThreadsPanel targetKey={targetKey} />
            )}
          </div>
        </main>
      </div>
      </DraftTray>
      </div>

      {/* Line-selection action bar — GitHub-style: pick lines, then act. */}
      {lineSel && (
        <div className="fixed bottom-24 left-1/2 z-[62] flex w-max max-w-[calc(100vw-24px)] -translate-x-1/2 flex-wrap items-center gap-1.5 rounded-xl border border-border bg-popover px-2 py-1.5 text-xs shadow-2xl ring-1 ring-primary/10">
          <span className="flex items-center gap-1.5 px-1 font-mono text-[11px] text-muted-foreground">
            <Icon name="File" className="size-3.5" aria-hidden />
            {lineSel.file.split("/").pop()}
            <span className="rounded bg-primary/10 px-1 text-primary">
              L{lineSel.range.start}
              {lineSel.range.end !== lineSel.range.start ? `–${lineSel.range.end}` : ""}
            </span>
          </span>
          <span className="h-4 w-px bg-border" />
          <Button size="sm" variant="ghost" className="h-9 gap-1.5 px-2 text-xs md:h-7" onClick={() => commentOnLines()}>
            <Icon name="MessageSquarePlus" className="size-3.5 text-primary" aria-hidden />
            Add comment
          </Button>
          <Button size="sm" variant="ghost" className="h-9 gap-1.5 px-2 text-xs md:h-7" onClick={askAboutLines}>
            <Icon name="Sparkles" className="size-3.5 text-(--ansi-13)" aria-hidden />
            Ask agent
          </Button>
          <button
            type="button"
            aria-label="Clear selection"
            onClick={() => setLineSel(null)}
            className="rounded-md p-1 text-muted-foreground hover:bg-state-hover hover:text-foreground"
          >
            <Icon name="X" className="size-3.5" aria-hidden />
          </button>
        </div>
      )}

      {sel && (
        <button
          type="button"
          onClick={askAboutSelection}
          className="fixed z-[62] flex -translate-x-1/2 -translate-y-full items-center gap-1.5 rounded-lg bg-(--ansi-13) px-2.5 py-1 text-xs font-semibold text-background shadow-lg hover:brightness-110"
          style={{ left: sel.x, top: sel.y - 6 }}
        >
          <Icon name="Sparkles" className="size-3.5" aria-hidden />
          Ask agent about this
        </button>
      )}

    </div>
  );
});
ReviewWorkspace.displayName = "ReviewWorkspace";
