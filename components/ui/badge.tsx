import type { HTMLAttributes, ReactNode } from "react";
import { cn } from "../../lib/utils";
import { Icon } from "./icon";

/**
 * Semantic tones on bb's theme tokens. Text uses the theme's AA-safe text
 * roles (diff-added, warning-text, destructive-text) and fills stay soft
 * tints, so the same tone reads in any light or dark theme. Agent work uses
 * the terminal's bright magenta, which every bb theme defines.
 */
export type Tone = "neutral" | "primary" | "success" | "warning" | "danger" | "merged" | "agent";

const SOFT: Record<Tone, string> = {
  neutral: "border-border bg-muted/50 text-muted-foreground",
  primary: "border-primary/25 bg-primary/10 text-primary",
  success: "border-success/25 bg-success/10 text-diff-added",
  warning: "border-warning/25 bg-warning/10 text-warning-text",
  danger: "border-destructive/25 bg-destructive/10 text-destructive-text",
  merged: "border-pr-merged/30 bg-pr-merged/10 text-pr-merged",
  agent: "border-(--ansi-13)/30 bg-(--ansi-13)/10 text-(--ansi-13)",
};

/** Text and icon color alone, for status text without a chip. */
export const TONE_TEXT: Record<Tone, string> = {
  neutral: "text-muted-foreground",
  primary: "text-primary",
  success: "text-diff-added",
  warning: "text-warning-text",
  danger: "text-destructive-text",
  merged: "text-pr-merged",
  agent: "text-(--ansi-13)",
};

export const TONE_FILL: Record<Tone, string> = {
  neutral: "bg-muted-foreground/50",
  primary: "bg-primary",
  success: "bg-success",
  warning: "bg-warning",
  danger: "bg-destructive",
  merged: "bg-pr-merged",
  agent: "bg-(--ansi-13)",
};

/** A small status dot. `pulse` adds a ping for work in progress, off under reduced motion. */
export function Dot({ tone = "neutral", pulse = false, className }: { tone?: Tone; pulse?: boolean; className?: string }) {
  return (
    <span aria-hidden className={cn("relative inline-flex size-1.5 shrink-0", className)}>
      {pulse && <span className={cn("absolute inset-0 rounded-full opacity-60 motion-safe:animate-ping", TONE_FILL[tone])} />}
      <span className={cn("relative size-1.5 rounded-full", TONE_FILL[tone])} />
    </span>
  );
}

export function Badge({ tone = "neutral", size = "md", icon, dot = false, pulse = false, className, children, ...props }: {
  tone?: Tone;
  /** sm sits in dense rows (chapter meta, comment headers, file tags). */
  size?: "sm" | "md";
  icon?: ReactNode;
  dot?: boolean;
  pulse?: boolean;
} & HTMLAttributes<HTMLSpanElement>) {
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-full border font-medium leading-none",
        size === "sm" ? "h-4 px-1.5 text-[10px] [&_[data-icon]]:size-2.5" : "h-5 px-2 text-[11px] [&_[data-icon]]:size-3",
        SOFT[tone],
        className,
      )}
      {...props}
    >
      {dot && <Dot tone={tone} pulse={pulse} />}
      {icon}
      {children}
    </span>
  );
}

/** The assistant's mark (or yours): a sparkle or person in a small tinted disc. */
export function SpeakerMark({ agent, className }: { agent: boolean; className?: string }) {
  return (
    <span aria-hidden className={cn("flex size-[18px] shrink-0 items-center justify-center rounded-full", agent ? "bg-(--ansi-13)/15 text-(--ansi-13)" : "bg-primary/15 text-primary", className)}>
      <Icon name={agent ? "Sparkles" : "UserRound"} className="size-3" />
    </span>
  );
}
