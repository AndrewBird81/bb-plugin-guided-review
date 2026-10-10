// Who the gh account is and which teams it's on, cached.
import type { RunGh } from "./types";

export interface Viewer { login(): Promise<string | null>; teams(): Promise<ReadonlySet<string>>;  reset(): void }

/** Caches each read for ttlMs; after a failure returns null / an empty set until retryMs passes. */
export function createViewer(run: RunGh, options: { ttlMs?: number; retryMs?: number; now?: () => number } = {}): Viewer {
  const { ttlMs = 60 * 60_000, retryMs = 5 * 60_000, now = Date.now } = options;
  let generation = 0;

  function cached<T>(read: () => Promise<T | null>, fallback: T): () => Promise<T> {
    let entry: { value: T; until: number } | null = null;
    let pending: Promise<T> | null = null;
    let seen = generation;
    return () => {
      if (seen !== generation) { entry = null; pending = null; seen = generation; }
      if (entry && now() < entry.until) return Promise.resolve(entry.value);
      if (pending) return pending;
      const started = generation;
      const task = read().catch(() => null).then((value) => {
        // An account switch mid-read must not cache the old account.
        if (started !== generation) return value ?? fallback;
        entry = value === null ? { value: fallback, until: now() + retryMs } : { value, until: now() + ttlMs };
        pending = null;
        return entry.value;
      });
      pending = task;
      return task;
    };
  }

  const login = cached(async () => {
    const out = await run(["api", "user", "--jq", ".login"]);
    const value = out.stdout.trim();
    return out.code === 0 && value ? value : null;
  }, null as string | null);

  const teams = cached(async () => {
    const out = await run(["api", "--paginate", "user/teams", "--jq", '.[] | "\\(.organization.login)/\\(.slug)"']);
    if (out.code !== 0) return null;
    return new Set(out.stdout.split("\n").map((line) => line.trim().toLowerCase()).filter(Boolean)) as ReadonlySet<string>;
  }, new Set<string>() as ReadonlySet<string>);

  return { login, teams, reset: () => { generation++; } };
}
