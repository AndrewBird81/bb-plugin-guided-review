import { memo } from "react";
import { cn } from "../lib/utils";
import { classifyFile, type FileCategory } from "../src/classify";
import { Badge, type Tone } from "./ui/badge";

const CATEGORY_TONE: Record<Exclude<FileCategory, "code">, Tone> = {
  test: "neutral",
  generated: "neutral",
  lockfile: "neutral",
  docs: "primary",
  config: "neutral",
};

/**
 * A small category pill for a changed file. Ordinary source code renders
 * nothing (no noise); tests / generated / lockfiles render a muted "skip"
 * hint so the reviewer can see what they don't need to read closely.
 */
export const FileTag = memo(function FileTag({ file, className }: { file: string; className?: string }) {
  const c = classifyFile(file);
  if (c.category === "code") return null;
  return (
    <Badge
      tone={CATEGORY_TONE[c.category]}
      size="sm"
      className={cn("font-normal", c.skippable && "border-dashed opacity-80", className)}
      title={c.skippable ? `${c.label} — low-value to review, safe to skim` : c.label}
    >
      {c.skippable ? `${c.label} · skip` : c.label}
    </Badge>
  );
});
FileTag.displayName = "FileTag";
