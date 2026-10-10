import { memo, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { parsePatchFiles } from "@pierre/diffs";
import { FileDiff } from "@pierre/diffs/react";
import type { AnnotationSide, DiffLineAnnotation, FileDiffMetadata, FileDiffOptions, SelectedLineRange } from "@pierre/diffs";
import { splitPatchByFile } from "../src/patch";
import type { FileInterdiff } from "../src/interdiff";
import { sameLocation, type CommentLocation } from "../src/draft";
import { cn } from "../lib/utils";
import { Icon } from "./ui/icon";
import { Badge } from "./ui/badge";
import { DiffStat } from "./ui/diff-stat";
import { FilePath } from "./ui/file-path";
import { FileTag } from "./FileTag";
import { useMediaQuery } from "./ui/hooks/use-media-query";
import { InlineDraftContext, InlineLocation, locationKey } from "./InlineDraft";

export interface FileViewFlags {
  viewed: boolean;
  stale: boolean;
}

/** A line pierre shows a draft comment, discussion, or comment box under. Its content comes from InlineDraftContext. */
type Annotation = CommentLocation;

// NOTE: @pierre/diffs@1.3.6 — `parsePatchFiles` returns `ParsedPatch[]`, each
// with a nested `.files`; `FileDiff`'s prop is `fileDiff` and the theme lives
// under `options: { theme }`. (See the original task-14 note.)
function useTheme() {
  const darkTheme = document.documentElement.dataset.bbCodeThemeDark;
  const lightTheme = document.documentElement.dataset.bbCodeThemeLight;
  return darkTheme && lightTheme ? { dark: darkTheme, light: lightTheme } : undefined;
}

function diffStats(text: string): { add: number; del: number } {
  let add = 0;
  let del = 0;
  for (const line of text.split("\n")) {
    if (line.startsWith("+") && !line.startsWith("+++")) add++;
    else if (line.startsWith("-") && !line.startsWith("---")) del++;
  }
  return { add, del };
}

const annotationSide = (side: "LEFT" | "RIGHT"): AnnotationSide => (side === "LEFT" ? "deletions" : "additions");

/** Below this width the diff shows one column, whatever the reading layout. */
const UNIFIED_BELOW = 720;

// Scrolls the review only vertically: scrollIntoView would also scroll the diff's code sideways.
function scrollToCenter(el: HTMLElement, behavior: ScrollBehavior) {
  let box = el.parentElement;
  while (box && !(box.scrollHeight > box.clientHeight && /auto|scroll/.test(getComputedStyle(box).overflowY))) box = box.parentElement;
  if (!box) return;
  const target = el.getBoundingClientRect();
  const view = box.getBoundingClientRect();
  box.scrollBy({ top: target.top - view.top - (view.height - target.height) / 2, behavior });
}

/**
 * Highlights lines new since your review. Pierre marks each rendered row with its
 * line type and number: code rows carry data-line, gutter rows data-column-number,
 * and deletion rows use old-file numbers in both layouts.
 */
export function sinceReviewCSS(newLines: number[], newDeletions: number[]): string {
  const rows = (type: string, lines: number[]) => lines.map((n) => `[data-line-type="${type}"]:is([data-line="${n}"],[data-column-number="${n}"])`);
  const selectors = [...rows("change-addition", newLines), ...rows("change-deletion", newDeletions)];
  if (!selectors.length) return "";
  const tint = "color-mix(in oklab, var(--primary) 14%, transparent)";
  return `${selectors.join(",\n")} { box-shadow: inset 2px 0 0 var(--primary); background-image: linear-gradient(${tint}, ${tint}); }`;
}

function parseFileDiff(text: string): FileDiffMetadata | null {
  return parsePatchFiles(text).flatMap((p) => p.files)[0] ?? null;
}

/** A diff to read, not comment on: a removed file or changes gone since your review. */
const StaticDiff = memo(function StaticDiff({ text, darkTheme, lightTheme, themeMode }: { text: string; darkTheme?: string; lightTheme?: string; themeMode?: "light" | "dark" }) {
  const fileDiff = useMemo(() => parseFileDiff(text), [text]);
  const options = useMemo<FileDiffOptions<undefined>>(() => ({
    ...(darkTheme && lightTheme ? { theme: { dark: darkTheme, light: lightTheme } } : {}),
    themeType: themeMode,
    diffStyle: "unified",
    disableFileHeader: true,
  }), [darkTheme, lightTheme, themeMode]);
  if (!fileDiff) return null;
  return <div className="overflow-x-auto"><FileDiff fileDiff={fileDiff} options={options} /></div>;
});

/** A collapsible diff that draws only while open. */
function DiffDetails({ summary, text, defaultOpen = false, className, theme, themeMode }: {
  summary: ReactNode; text: string; defaultOpen?: boolean; className?: string; theme?: { dark: string; light: string }; themeMode?: "light" | "dark";
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <details open={open} onToggle={(event) => setOpen(event.currentTarget.open)} className={className}>
      {summary}
      {open && <StaticDiff text={text} darkTheme={theme?.dark} lightTheme={theme?.light} themeMode={themeMode} />}
    </details>
  );
}

/** The code row pierre drew for a line with no comment under it. */
function lineRow(fileEl: HTMLElement, at: CommentLocation): HTMLElement | undefined {
  const shadow = fileEl.querySelector("diffs-container")?.shadowRoot;
  const [own, other, column] = at.side === "LEFT" ? ["change-deletion", "change-addition", "[data-deletions]"] : ["change-addition", "change-deletion", "[data-additions]"];
  return (shadow?.querySelector<HTMLElement>(`[data-line-type="${own}"][data-line="${at.line}"]`)
    ?? shadow?.querySelector<HTMLElement>(`:is(${column},[data-unified]) [data-line="${at.line}"]:not([data-line-type="${other}"])`)) ?? undefined;
}

function renderAnnotation({ metadata }: DiffLineAnnotation<Annotation>) {
  return <InlineLocation at={metadata} />;
}

// One file's diff. Pierre redraws a file whenever its options or annotations
// are new objects, which also takes focus from an open comment box, so both
// stay the same until something in them changes.
const FileBody = memo(function FileBody({ path, fileDiff, darkTheme, lightTheme, themeMode, diffStyle, annotations, onLineSelected, onComment, unsafeCSS }: {
  path: string;
  fileDiff: FileDiffMetadata;
  darkTheme?: string;
  lightTheme?: string;
  themeMode?: "light" | "dark";
  diffStyle: "split" | "unified";
  annotations: DiffLineAnnotation<Annotation>[];
  onLineSelected?: (file: string, range: SelectedLineRange | null) => void;
  onComment?: (at: CommentLocation) => void;
  /** Extra styles inside pierre's shadow root, such as lines new since your review. */
  unsafeCSS?: string;
}) {
  const fromGutter = useRef(false);
  const options = useMemo<FileDiffOptions<Annotation>>(() => ({
    ...(darkTheme && lightTheme ? { theme: { dark: darkTheme, light: lightTheme } } : {}),
    themeType: themeMode,
    diffStyle,
    // The card's own header names the file, counts its changes, and marks it viewed.
    disableFileHeader: true,
    ...(unsafeCSS ? { unsafeCSS } : {}),
    // GitHub-style line picking: drag to select a range to comment on or ask
    // about, or use the gutter "+" to open a comment box at a line.
    // Uncontrolled — pierre paints the highlight.
    enableLineSelection: true,
    enableGutterUtility: true,
    onLineSelected: (range) => { if (!fromGutter.current) onLineSelected?.(path, range); },
    onGutterUtilityClick: (range) => {
      if (!onComment) return onLineSelected?.(path, range);
      // Pierre reports the "+" as a line selection too, which would offer the selection's actions over the box.
      fromGutter.current = true;
      queueMicrotask(() => { fromGutter.current = false; });
      onComment({ file: path, line: range.end, side: (range.endSide ?? range.side) === "deletions" ? "LEFT" : "RIGHT" });
    },
  }), [darkTheme, lightTheme, themeMode, diffStyle, path, onLineSelected, onComment, unsafeCSS]);
  return (
    <div className="overflow-x-auto">
      <FileDiff fileDiff={fileDiff} options={options} lineAnnotations={annotations} renderAnnotation={renderAnnotation} />
    </div>
  );
});

export const DiffViewer = memo(function DiffViewer({
  patch,
  files,
  views,
  onToggleViewed,
  registerFileEl,
  onLineSelected,
  themeMode,
  diffLayout = "split",
  reveal,
  since,
  sinceOnly = false,
  showRemoved = true,
}: {
  diffLayout?: "split" | "unified";
  themeMode?: "light" | "dark";
  patch: string;
  files: string[];
  views: Map<string, FileViewFlags>;
  onToggleViewed: (file: string, viewed: boolean) => void;
  registerFileEl?: (file: string, el: HTMLElement | null) => void;
  onLineSelected?: (file: string, range: SelectedLineRange | null) => void;
  /** Scroll to a comment's line, opening its file if it's collapsed. */
  reveal?: { at: CommentLocation; nonce: number };
  /** Each file compared with the diff at your last review. */
  since?: Map<string, FileInterdiff> | null;
  /** Show only what changed since your review. */
  sinceOnly?: boolean;
  /** Show files removed since your review here; they belong to no chapter, so the workspace shows them in the last one. */
  showRemoved?: boolean;
}) {
  const theme = useTheme();
  const compact = useMediaQuery("(max-width: 767px)");
  const draft = useContext(InlineDraftContext);
  const root = useRef<HTMLDivElement>(null);
  const filtering = sinceOnly && !!since;
  // The chapter's files by value: a reload's new array with the same files mustn't re-parse every diff.
  const fileKey = files.join("\0");
  const { perFile, unchanged } = useMemo(() => {
    const wanted = new Set(fileKey.split("\0"));
    const chapter = splitPatchByFile(patch).filter((f) => wanted.has(f.path));
    const shown = filtering ? chapter.filter((f) => since!.get(f.path)?.status !== "unchanged") : chapter;
    const perFile = shown.flatMap((f) => {
      const change = since?.get(f.path);
      // Filtered, a changed file shows only the hunks that changed since your review.
      const text = filtering && change?.status === "changed" ? change.patch : f.text;
      const fileDiff = text ? parseFileDiff(text) : null;
      // A file whose only change since your review is removed hunks shows just those.
      if (!fileDiff && !(filtering && change?.dropped)) return [];
      return [{
        path: f.path,
        stats: diffStats(text),
        fileDiff,
        change,
        css: change?.status === "changed" ? sinceReviewCSS(change.newLines, change.newDeletions) : "",
      }];
    });
    return { perFile, unchanged: chapter.length - shown.length };
  }, [patch, fileKey, since, filtering]);
  const removed = useMemo(() => (filtering && showRemoved ? [...since!.values()].filter((f) => f.status === "removed") : []), [since, filtering, showRemoved]);

  // Side-by-side needs room: squeezed between the chapters and the review panel, each side would clip its code.
  const [narrow, setNarrow] = useState(false);
  const hasFiles = perFile.length > 0;
  useEffect(() => {
    const el = root.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(([entry]) => setNarrow(entry.contentRect.width < UNIFIED_BELOW));
    observer.observe(el);
    return () => observer.disconnect();
  }, [hasFiles]);

  // Explicit collapse overrides; when unset a file follows its "viewed" flag.
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const isCollapsed = (file: string) => collapsed[file] ?? (views.get(file)?.viewed ?? false);
  const toggleCollapsed = (file: string) => setCollapsed((c) => ({ ...c, [file]: !isCollapsed(file) }));

  function handleToggleViewed(file: string, next: boolean) {
    onToggleViewed(file, next);
    // Checking Viewed collapses the file; unchecking re-expands it.
    setCollapsed((c) => ({ ...c, [file]: next }));
  }

  // The lines in each file with a draft comment, discussion, or the comment box.
  // A file keeps its list until those lines change; their content comes from context.
  const previous = useRef(new Map<string, { key: string; list: DiffLineAnnotation<Annotation>[] }>());
  const annotations = useMemo(() => {
    const next = new Map<string, { key: string; list: DiffLineAnnotation<Annotation>[] }>();
    for (const path of files) {
      const composer = draft?.composer?.file === path ? draft.composer : null;
      const lines: CommentLocation[] = [];
      for (const { file, line, side } of [...(draft?.comments ?? []), ...(draft?.discussions ?? [])]) {
        const at = { file, line, side };
        if (file === path && !(composer && sameLocation(at, composer)) && !lines.some((seen) => sameLocation(seen, at))) lines.push(at);
      }
      // The box's line comes first: pierre keys annotations by position, so lines coming and going don't remount it.
      if (composer) lines.unshift({ file: path, line: composer.line, side: composer.side });
      const key = JSON.stringify(lines.map((at) => [at.line, at.side]));
      const cached = previous.current.get(path);
      next.set(path, cached?.key === key ? cached : { key, list: lines.map((at) => ({ side: annotationSide(at.side), lineNumber: at.line, metadata: at })) });
    }
    previous.current = next;
    return next;
  }, [files, draft?.comments, draft?.discussions, draft?.composer]);

  // Opens the file, then scrolls to the line once the chapter's diffs stop moving:
  // pierre draws each file once its highlighting loads, then sizes the rows beside comments.
  useEffect(() => {
    if (!reveal) return;
    const { at } = reveal;
    const behavior = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth";
    setCollapsed((c) => ({ ...c, [at.file]: false }));
    const drawn = () => Array.from(root.current?.querySelectorAll("diffs-container") ?? []).every((el) => el.shadowRoot?.querySelector("[data-line]"));
    let tries = 0;
    let lastHeight = -1;
    let frame = requestAnimationFrame(function attempt() {
      const fileEl = Array.from(root.current?.querySelectorAll<HTMLElement>("[data-file]") ?? []).find((el) => el.dataset.file === at.file);
      // No line: just the file.
      if (at.line < 1 && fileEl) return fileEl.scrollIntoView({ behavior, block: "start" });
      const target = Array.from(fileEl?.querySelectorAll<HTMLElement>("[data-draft-at]") ?? []).find((el) => el.dataset.draftAt === locationKey(at))
        ?? (fileEl ? lineRow(fileEl, at) : undefined);
      const shown = !!target?.getClientRects().length;
      const height = root.current?.offsetHeight ?? 0;
      const settled = height === lastHeight;
      lastHeight = height;
      if (shown && drawn() && settled) scrollToCenter(target!, behavior);
      else if (++tries < 90) frame = requestAnimationFrame(attempt);
      else if (shown) scrollToCenter(target!, behavior);
      else fileEl?.scrollIntoView({ behavior, block: "start" });
    });
    return () => cancelAnimationFrame(frame);
  }, [reveal]);

  const unchangedNote = unchanged > 0 && <p className="text-center text-xs text-muted-foreground">{unchanged} file{unchanged === 1 ? "" : "s"} unchanged since your review</p>;
  const removedCards = removed.map((file) => (
    <section key={file.file} aria-label={`${file.file} removed`} className="overflow-clip rounded-lg border border-dashed border-border bg-card">
      <DiffDetails text={file.dropped} theme={theme} themeMode={themeMode} summary={
        <summary className="flex min-h-10 cursor-pointer items-center gap-2 px-2 py-1.5 text-xs">
          <Icon name="FileX2" className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
          <FilePath path={file.file} className="min-w-0 flex-1 line-through decoration-muted-foreground/50" />
          <span className="shrink-0 text-muted-foreground">Removed from the PR since your review</span>
        </summary>
      } />
    </section>
  ));

  if (perFile.length === 0) {
    return (
      <div className="space-y-4">
        <p className="rounded-lg border border-dashed border-border px-4 py-8 text-center text-sm text-muted-foreground">{filtering ? "No changes in this chapter since your review." : "No changes in this chapter."}</p>
        {removedCards}
        {unchangedNote}
      </div>
    );
  }

  return (
    <div ref={root} className="space-y-4">
      {perFile.map(({ path, stats, fileDiff, change, css }) => {
        const flags = views.get(path);
        const viewed = flags?.viewed ?? false;
        const stale = flags?.stale ?? false;
        const folded = isCollapsed(path);
        const commentCount = draft?.comments.filter((c) => c.file === path).length ?? 0;
        const commentLabel = `${commentCount} draft comment${commentCount === 1 ? "" : "s"}`;
        return (
          <div
            key={path}
            ref={(el) => registerFileEl?.(path, el)}
            data-file={path}
            className={cn(
              // clip, not hidden: the header sticks to the scrolling review, not to this card.
              "overflow-clip rounded-lg border border-border bg-card shadow-xs transition-opacity duration-150",
              viewed && folded && "opacity-75 focus-within:opacity-100 hover:opacity-100",
            )}
          >
            <div className={cn("sticky top-0 z-10 flex min-h-10 items-center gap-2 bg-[color-mix(in_oklab,var(--muted)_30%,var(--background))] px-2 py-1.5", !folded && "border-b border-border")}>
              <button
                type="button"
                aria-label={folded ? "Expand file" : "Collapse file"}
                className="shrink-0 rounded-md p-1 text-muted-foreground hover:bg-state-hover hover:text-foreground"
                onClick={() => toggleCollapsed(path)}
              >
                <Icon name="ChevronDown" className={cn("size-3.5 transition-transform duration-150", folded && "-rotate-90")} aria-hidden />
              </button>
              <FilePath path={path} className="min-w-0 flex-1 text-xs" nameClassName="font-medium" />
              <FileTag file={path} />
              {commentCount > 0 && (
                <span className="flex shrink-0 items-center gap-1 rounded-full bg-primary/10 px-1.5 text-[11px] leading-5 text-primary" title={commentLabel}>
                  <Icon name="MessageSquare" className="size-3" aria-hidden />
                  <span aria-hidden>{commentCount}</span>
                  <span className="sr-only">{commentLabel}</span>
                </span>
              )}
              {stale && (
                <Badge tone="warning" size="sm" title="This file changed since you marked it viewed">changed</Badge>
              )}
              {(change?.status === "changed" || change?.status === "added") && (
                <Badge tone="primary" size="sm" icon={<Icon name="GitCommit" aria-hidden />} title={change.status === "added" ? "Added to the PR since your review" : "Changed since your review"}>Changed since your review</Badge>
              )}
              <DiffStat add={stats.add} del={stats.del} className="hidden @min-[700px]/review:inline-flex" />
              <label className={cn(
                "flex shrink-0 cursor-pointer items-center gap-1.5 rounded-md border px-2 py-0.5 text-[11px] transition-colors",
                viewed ? "border-success/30 bg-success/10 text-diff-added" : "border-border text-muted-foreground hover:border-input hover:text-foreground",
              )}>
                <input
                  type="checkbox"
                  className="size-3.5 accent-(--success)"
                  checked={viewed}
                  onChange={(e) => handleToggleViewed(path, e.target.checked)}
                />
                Viewed
              </label>
            </div>
            {!folded && fileDiff && (
              <FileBody
                path={path}
                fileDiff={fileDiff}
                darkTheme={theme?.dark}
                lightTheme={theme?.light}
                themeMode={themeMode}
                diffStyle={compact || narrow ? "unified" : diffLayout}
                annotations={annotations.get(path)?.list ?? []}
                onLineSelected={onLineSelected}
                onComment={draft?.editable ? draft.open : undefined}
                unsafeCSS={css}
              />
            )}
            {!folded && filtering && change?.dropped && (
              <DiffDetails text={change.dropped} defaultOpen={!fileDiff} theme={theme} themeMode={themeMode} className={cn(fileDiff && "border-t border-border")}
                summary={<summary className="cursor-pointer px-3 py-1.5 text-xs text-muted-foreground">Changes gone since your review</summary>} />
            )}
          </div>
        );
      })}
      {removedCards}
      {unchangedNote}
    </div>
  );
});
DiffViewer.displayName = "DiffViewer";
