/** Compact elapsed time, such as "2h", or "now". Null for absent or implausible stamps. */
export function age(ts?: number | null, now = Date.now()): string | null {
  if (typeof ts !== "number" || !Number.isFinite(ts) || ts < 1_000_000_000_000) return null;
  const s = Math.max(0, Math.floor((now - ts) / 1000));
  if (s < 45) return "now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d}d`;
  const w = Math.floor(d / 7);
  if (w < 5) return `${w}w`;
  const mo = Math.floor(d / 30);
  if (mo < 12) return `${mo}mo`;
  return `${Math.floor(d / 365)}y`;
}

/** Compact "2h ago" relative time. Null for absent or implausible stamps. */
export function timeAgo(ts?: number | null, now = Date.now()): string | null {
  const elapsed = age(ts, now);
  return elapsed === "now" ? "just now" : elapsed && `${elapsed} ago`;
}
