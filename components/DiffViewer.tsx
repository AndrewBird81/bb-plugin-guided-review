import { memo, useContext, useEffect, useMemo, useRef, useState } from "react";
import { parsePatchFiles } from "@pierre/diffs";
import { FileDiff } from "@pierre/diffs/react";
import type { AnnotationSide, DiffLineAnnotation, FileDiffMetadata, FileDiffOptions, SelectedLineRange } from "@pierre/diffs";
import { splitPatchByFile } from "../src/patch";
import { sameLocation, type CommentLocation } from "../src/draft";
import { cn } from "../lib/utils";
import { Icon } from "./ui/icon";
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

// Scrolls the review only vertically: scrollIntoView would also scroll the diff's code sideways.
function scrollToCenter(el: HTMLElement, behavior: ScrollBehavior) {
  let box = el.parentElement;
  while (box && !(box.scrollHeight > box.clientHeight && /auto|scroll/.test(getComputedStyle(box).overflowY))) box = box.parentElement;
  if (!box) return;
  const target = el.getBoundingClientRect();
  const view = box.getBoundingClientRect();
  box.scrollBy({ top: target.top - view.top - (view.height - target.height) / 2, behavior });
}

function renderAnnotation({ metadata }: DiffLineAnnotation<Annotation>) {
  return <InlineLocation at={metadata} />;
}

// One file's diff. Pierre redraws a file whenever its options or annotations
// are new objects, which also takes focus from an open comment box, so both
// stay the same until something in them changes.
const FileBody = memo(function FileBody({ path, fileDiff, darkTheme, lightTheme, themeMode, diffStyle, annotations, onLineSelected, onComment }: {
  path: string;
  fileDiff: FileDiffMetadata;
  darkTheme?: string;
  lightTheme?: string;
  themeMode?: "light" | "dark";
  diffStyle: "split" | "unified";
  annotations: DiffLineAnnotation<Annotation>[];
  onLineSelected?: (file: string, range: SelectedLineRange | null) => void;
  onComment?: (at: CommentLocation) => void;
}) {
  const fromGutter = useRef(false);
  const options = useMemo<FileDiffOptions<Annotation>>(() => ({
    ...(darkTheme && lightTheme ? { theme: { dark: darkTheme, light: lightTheme } } : {}),
    themeType: themeMode,
    diffStyle,
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
  }), [darkTheme, lightTheme, themeMode, diffStyle, path, onLineSelected, onComment]);
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
}) {
  const theme = useTheme();
  const compact = useMediaQuery("(max-width: 767px)");
  const draft = useContext(InlineDraftContext);
  const root = useRef<HTMLDivElement>(null);
  const perFile = useMemo(() => {
    return splitPatchByFile(patch)
      .filter((f) => files.includes(f.path))
      .map((f) => ({
        path: f.path,
        stats: diffStats(f.text),
        fileDiff: parsePatchFiles(f.text).flatMap((p) => p.files)[0] ?? null,
      }))
      .filter((f) => f.fileDiff);
  }, [patch, files]);

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
      const target = Array.from(fileEl?.querySelectorAll<HTMLElement>("[data-draft-at]") ?? []).find((el) => el.dataset.draftAt === locationKey(at));
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

  if (perFile.length === 0) {
    return <p className="text-sm text-muted-foreground">No changes in this chapter.</p>;
  }

  return (
    <div ref={root} className="space-y-3">
      {perFile.map(({ path, stats, fileDiff }) => {
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
              "overflow-hidden rounded-md border border-border",
              viewed && "border-border/60 opacity-70",
            )}
          >
            <div className="flex items-center gap-2 border-b border-border bg-muted/40 px-2 py-1.5">
              <button
                type="button"
                aria-label={folded ? "Expand file" : "Collapse file"}
                className="shrink-0 rounded p-0.5 text-muted-foreground hover:bg-state-hover hover:text-foreground"
                onClick={() => toggleCollapsed(path)}
              >
                <Icon name={folded ? "ArrowRight" : "ArrowDown"} className="size-3.5" aria-hidden />
              </button>
              <span className="min-w-0 flex-1 truncate font-mono text-xs text-foreground" title={path}>
                {path}
              </span>
              <FileTag file={path} />
              <span className="shrink-0 font-mono text-[10px] text-emerald-600 dark:text-emerald-400">
                +{stats.add}
              </span>
              <span className="shrink-0 font-mono text-[10px] text-rose-600 dark:text-rose-400">−{stats.del}</span>
              {commentCount > 0 && (
                <span className="flex shrink-0 items-center gap-0.5 text-[10px] text-muted-foreground" title={commentLabel}>
                  <Icon name="MessageSquare" className="size-3" aria-hidden />
                  <span aria-hidden>{commentCount}</span>
                  <span className="sr-only">{commentLabel}</span>
                </span>
              )}
              {stale && (
                <span
                  className="shrink-0 rounded-full border border-amber-500/40 px-1.5 py-0 text-[10px] leading-4 text-amber-600 dark:text-amber-400"
                  title="This file changed since you marked it viewed"
                >
                  changed
                </span>
              )}
              <label className="flex shrink-0 cursor-pointer items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground">
                <input
                  type="checkbox"
                  className="size-3.5 accent-foreground"
                  checked={viewed}
                  onChange={(e) => handleToggleViewed(path, e.target.checked)}
                />
                Viewed
              </label>
            </div>
            {!folded && (
              <FileBody
                path={path}
                fileDiff={fileDiff!}
                darkTheme={theme?.dark}
                lightTheme={theme?.light}
                themeMode={themeMode}
                diffStyle={compact ? "unified" : diffLayout}
                annotations={annotations.get(path)?.list ?? []}
                onLineSelected={onLineSelected}
                onComment={draft?.editable ? draft.open : undefined}
              />
            )}
          </div>
        );
      })}
    </div>
  );
});
DiffViewer.displayName = "DiffViewer";
