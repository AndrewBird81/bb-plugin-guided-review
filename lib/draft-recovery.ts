import type { Verdict } from "../src/draft";

export type DraftRecovery = {
  summary?: { verdict: Verdict; body: string; revision?: string; editId?: string };
  /** `inline` when the comment was being written in the diff rather than the panel. */
  composer?: { file: string; line: string; side: "LEFT" | "RIGHT"; body: string; revision?: string; inline?: boolean };
};
const key = (targetKey: string) => `guided-review:draft-recovery:${targetKey}`;

/** Per-tab storage avoids mixing unsaved text from two review windows. */
export function readDraftRecovery(targetKey: string): DraftRecovery {
  try {
    const value = JSON.parse(sessionStorage.getItem(key(targetKey)) ?? "{}");
    const result: DraftRecovery = {};
    const revisionValid = (item: any) => item.revision === undefined || typeof item.revision === "string";
    if (value.summary && revisionValid(value.summary) && typeof value.summary.body === "string" && ["COMMENT", "APPROVE", "REQUEST_CHANGES"].includes(value.summary.verdict)) result.summary = value.summary;
    if (value.composer && revisionValid(value.composer) && ["file", "line", "body"].every(k => typeof value.composer[k] === "string") && ["LEFT", "RIGHT"].includes(value.composer.side) && [undefined, true, false].includes(value.composer.inline)) result.composer = value.composer;
    return result;
  } catch { return {}; }
}

export function updateDraftRecovery(targetKey: string, update: Partial<DraftRecovery>) {
  try {
    const next = { ...readDraftRecovery(targetKey), ...update };
    if (!next.summary && !next.composer) sessionStorage.removeItem(key(targetKey));
    else sessionStorage.setItem(key(targetKey), JSON.stringify(next));
  } catch { /* Keep in-memory text and beforeunload protection if storage is full. */ }
}
