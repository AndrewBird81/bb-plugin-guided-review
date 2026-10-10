import { useState } from "react";
import { cn } from "../../lib/utils";

// Terminal palette slots that read as soft color fields in every bb theme.
const SLOTS = [1, 2, 3, 4, 5, 6, 9, 10, 11, 12, 13, 14];

function slotFor(login: string): number {
  let hash = 0;
  for (const char of login.toLowerCase()) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return SLOTS[hash % SLOTS.length];
}

/**
 * A GitHub user's avatar. Initials on a theme color show while the image
 * loads, and stay when it can't.
 */
export function Avatar({ login, size = 20, className }: { login: string; size?: number; className?: string }) {
  const [failed, setFailed] = useState(false);
  const slot = slotFor(login);
  const initials = login.replace(/[^a-z0-9]/gi, "").slice(0, size >= 24 ? 2 : 1).toUpperCase();
  return (
    <span
      aria-hidden
      className={cn("relative inline-flex shrink-0 select-none items-center justify-center overflow-hidden rounded-full font-semibold ring-1 ring-border", className)}
      style={{ width: size, height: size, fontSize: Math.round(size * 0.45), backgroundColor: `var(--ansi-${slot})`, color: `var(--ansi-bg-fg-${slot})` }}
    >
      {initials}
      {!failed && (
        <img
          src={`https://github.com/${encodeURIComponent(login)}.png?size=${size * 2}`}
          alt=""
          loading="lazy"
          draggable={false}
          onError={() => setFailed(true)}
          className="absolute inset-0 size-full object-cover"
        />
      )}
    </span>
  );
}
