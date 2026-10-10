import * as Tooltip from "@radix-ui/react-tooltip";
import type { ReactElement, ReactNode } from "react";
import { usePortalScopeProps } from "../../lib/portal-scope";

/** A tooltip naming a control whose label hides when space is short. `container` keeps it inside a fullscreen root. */
export function Hint({ label, container, children }: { label: ReactNode; container?: HTMLElement | null; children: ReactElement }) {
  const scopeProps = usePortalScopeProps();
  return (
    <Tooltip.Provider delayDuration={350}>
      <Tooltip.Root>
        <Tooltip.Trigger asChild>{children}</Tooltip.Trigger>
        <Tooltip.Portal container={container ?? undefined}>
          <Tooltip.Content {...scopeProps} side="bottom" sideOffset={6} collisionPadding={8} className="z-[75] rounded-md border border-border bg-popover px-2.5 py-1.5 text-xs text-popover-foreground shadow-md">
            {label}
          </Tooltip.Content>
        </Tooltip.Portal>
      </Tooltip.Root>
    </Tooltip.Provider>
  );
}
