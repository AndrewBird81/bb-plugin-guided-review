import { memo, useState } from "react";
import { cn } from "../lib/utils";
import { classifyFile } from "../src/classify";
import { Icon } from "./ui/icon";
import { Badge, type Tone } from "./ui/badge";
import { Progress } from "./ui/diff-stat";
import { FileTag } from "./FileTag";
import { InlineCode } from "./ui/inline-code";
import type { FileViewFlags } from "./DiffViewer";

interface Section {
  id: string;
  title: string;
  overview: string;
  diffs: { file: string; summary?: string }[];
  risk?: string;
}

const RISK_TONE: Record<string, Tone> = { high: "danger", medium: "warning", low: "neutral" };
const RISK_LABEL: Record<string, string> = { high: "High risk", medium: "Medium risk", low: "Low risk" };

/**
 * A chapter's step on the guide's path: its number inside a ring that fills
 * green as its files are viewed. The open chapter is solid blue; a finished
 * one shows a check.
 */
function StepMarker({ index, viewed, total, active }: { index: number; viewed: number; total: number; active: boolean }) {
  const done = total > 0 && viewed === total;
  const ratio = total ? viewed / total : 0;
  return (
    <span
      aria-hidden
      className="relative z-[1] mt-px flex size-[22px] shrink-0 items-center justify-center rounded-full"
      style={{ background: `conic-gradient(var(--success) ${ratio * 360}deg, var(--border) 0deg)` }}
    >
      <span
        className={cn(
          "flex size-[18px] items-center justify-center rounded-full text-[10px] font-semibold tabular-nums",
          active ? "bg-primary text-primary-foreground" : done ? "bg-success text-background" : "bg-background text-muted-foreground",
        )}
      >
        {done && !active ? <Icon name="Check" className="size-3" /> : index + 1}
      </span>
    </span>
  );
}

export const ChapterNav = memo(function ChapterNav({
  sections,
  activeId,
  onSelect,
  views,
  onSelectFile,
  currentFile,
  changedSince,
}: {
  sections: Section[];
  activeId: string;
  onSelect: (id: string) => void;
  views: Map<string, FileViewFlags>;
  onSelectFile: (chapterId: string, file: string) => void;
  /** The file nearest the top of the diff, marked in the open chapter's list. */
  currentFile?: string;
  /** Per chapter id, how many of its files changed since your review. */
  changedSince?: Record<string, number>;
}) {
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const isExpanded = (id: string) => expanded[id] ?? id === activeId;
  const allFiles = sections.flatMap((s) => s.diffs.map((d) => d.file));
  const viewedAll = allFiles.filter((f) => views.get(f)?.viewed).length;

  return (
    <nav aria-label="Chapters" className="space-y-3">
      <div className="space-y-1.5 px-2 pt-1">
        <div className="flex items-baseline justify-between gap-2 text-[11px]">
          <span className="font-semibold uppercase tracking-wider text-subtle-foreground">Chapters</span>
          <span className="tabular-nums text-muted-foreground">{viewedAll}/{allFiles.length} files viewed</span>
        </div>
        <Progress value={viewedAll} max={allFiles.length} label="Files viewed" />
      </div>
      <ol className="relative space-y-0.5">
        {sections.map((s, index) => {
          const active = s.id === activeId;
          const open = isExpanded(s.id);
          const skippable = s.diffs.filter((d) => classifyFile(d.file).skippable).length;
          const allSkippable = s.diffs.length > 0 && skippable === s.diffs.length;
          const viewed = s.diffs.filter((d) => views.get(d.file)?.viewed).length;
          const changed = changedSince?.[s.id] ?? 0;
          return (
            <li key={s.id} className="relative">
              {index < sections.length - 1 && <span aria-hidden className="absolute bottom-[-6px] left-[18px] top-7 w-px bg-border" />}
              <div
                className={cn(
                  "rounded-lg transition-colors duration-150",
                  active ? "bg-state-active/50 ring-1 ring-inset ring-primary/20" : "hover:bg-state-hover",
                )}
              >
                <div className="flex items-start gap-2.5 py-2 pl-[7px] pr-1.5">
                  <StepMarker index={index} viewed={viewed} total={s.diffs.length} active={active} />
                  <button onClick={() => onSelect(s.id)} aria-current={active ? "step" : undefined} className="min-w-0 flex-1 rounded-sm text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                    <div className={cn("text-sm font-medium leading-snug line-clamp-3", active ? "text-foreground" : "text-foreground/90")}>
                      <InlineCode text={s.title} />
                    </div>
                    {s.overview && (
                      <div className="mt-1 line-clamp-2 text-xs leading-snug text-muted-foreground"><InlineCode text={s.overview} /></div>
                    )}
                    <div className="mt-1.5 flex flex-wrap items-center gap-x-1.5 gap-y-1 text-[11px] text-subtle-foreground">
                      {s.risk && (
                        <Badge tone={RISK_TONE[s.risk] ?? "neutral"} size="sm" title={s.overview}>
                          {RISK_LABEL[s.risk] ?? s.risk}
                        </Badge>
                      )}
                      <span className="tabular-nums">
                        {viewed > 0 ? `${viewed}/` : ""}{s.diffs.length} file{s.diffs.length === 1 ? "" : "s"}{viewed > 0 ? " viewed" : ""}
                      </span>
                      {changed > 0 && (
                        <Badge tone="primary" size="sm" title={`${changed} file${changed === 1 ? "" : "s"} changed since your review`}>
                          {changed} changed
                        </Badge>
                      )}
                      {skippable > 0 && <span>· {skippable} skippable</span>}
                      {allSkippable && <span className="italic">· mostly tests — skim</span>}
                    </div>
                  </button>
                  <button
                    type="button"
                    aria-label={open ? "Collapse chapter" : "Expand chapter"}
                    aria-expanded={open}
                    className="mt-0.5 shrink-0 rounded-md p-0.5 text-subtle-foreground hover:bg-state-hover hover:text-foreground"
                    onClick={() => setExpanded((e) => ({ ...e, [s.id]: !open }))}
                  >
                    <Icon name="ChevronDown" className={cn("size-3.5 transition-transform duration-150", !open && "-rotate-90")} aria-hidden />
                  </button>
                </div>
                {open && s.diffs.length > 0 && (
                  <ul className="space-y-px pb-2 pl-8 pr-2">
                    {s.diffs.map((d) => {
                      const viewed = views.get(d.file)?.viewed ?? false;
                      const current = active && d.file === currentFile;
                      return (
                        <li key={d.file}>
                          <button
                            type="button"
                            onClick={() => onSelectFile(s.id, d.file)}
                            className={cn("flex w-full items-center gap-1.5 rounded-md px-1.5 py-1 text-left hover:bg-state-hover", current && "bg-state-hover")}
                            title={d.summary ? `${d.file} — ${d.summary}` : d.file}
                          >
                            <Icon
                              name={viewed ? "CircleCheck" : "File"}
                              className={cn("size-3.5 shrink-0", viewed ? "text-diff-added" : current ? "text-primary" : "text-subtle-foreground")}
                              aria-hidden
                            />
                            <span
                              className={cn(
                                "min-w-0 flex-1 truncate font-mono text-[11px]",
                                viewed ? "text-muted-foreground line-through decoration-muted-foreground/40" : current ? "text-primary" : "text-foreground/90",
                              )}
                            >
                              {d.file.split("/").pop()}
                            </span>
                            <FileTag file={d.file} />
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </div>
            </li>
          );
        })}
      </ol>
    </nav>
  );
});
ChapterNav.displayName = "ChapterNav";
