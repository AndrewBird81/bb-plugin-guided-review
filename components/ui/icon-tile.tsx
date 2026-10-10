import { cn } from "../../lib/utils";
import type { Tone } from "./badge";
import { Icon, type IconName } from "./icon";

const TILE: Record<Tone, string> = {
  neutral: "bg-muted/60 text-muted-foreground ring-border",
  primary: "bg-primary/10 text-primary ring-primary/20",
  success: "bg-success/10 text-diff-added ring-success/20",
  warning: "bg-warning/10 text-warning-text ring-warning/20",
  danger: "bg-destructive/10 text-destructive-text ring-destructive/20",
  merged: "bg-pr-merged/12 text-pr-merged ring-pr-merged/25",
  agent: "bg-(--ansi-13)/10 text-(--ansi-13) ring-(--ansi-13)/25",
};

/** A rounded tile holding an icon, tinted by tone. */
export function IconTile({ tone, icon, className, iconClassName }: { tone: Tone; icon: IconName; className?: string; iconClassName?: string }) {
  return (
    <span aria-hidden className={cn("flex size-8 shrink-0 items-center justify-center rounded-lg ring-1 ring-inset", TILE[tone], className)}>
      <Icon name={icon} className={cn("size-4", iconClassName)} />
    </span>
  );
}

