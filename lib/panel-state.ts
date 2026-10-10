// Per-review UI state persisted to localStorage so the Guided Review panel
// survives tab switches / remounts: which review you were on, the chapter, the
// scroll position, the sidebar width, and focus mode. The floating agent dock
// persists its own geometry separately (see AgentDock).

export interface ReviewUiState {
  activeId?: string;
  view?: "diff" | "feedback" | "threads";
  scrollTop?: number;
  sidebarWidth?: number;
  focus?: boolean;
  toolsOpen?: boolean;
  activeTool?: "draft" | "notes" | "agent";
}

interface PanelState {
  lastTargetKey?: string;
  perReview: Record<string, ReviewUiState>;
}

const KEY = "gr:panelstate";

function read(): PanelState {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { perReview: {} };
    const parsed = JSON.parse(raw) as PanelState;
    return { ...parsed, perReview: parsed.perReview ?? {} };
  } catch {
    return { perReview: {} };
  }
}

function write(state: PanelState) {
  try {
    localStorage.setItem(KEY, JSON.stringify(state));
  } catch {
    // storage unavailable — persistence is best-effort.
  }
}

/** The most recently opened review, for a "Resume" affordance on the list. */
export function getLastReview(): { targetKey: string } | null {
  const key = read().lastTargetKey;
  return key ? { targetKey: key } : null;
}

export function setLastReview(targetKey: string) {
  const s = read();
  s.lastTargetKey = targetKey;
  write(s);
}

export function getReviewState(targetKey: string): ReviewUiState {
  return read().perReview[targetKey] ?? {};
}

export function patchReviewState(targetKey: string, patch: Partial<ReviewUiState>) {
  const s = read();
  s.perReview[targetKey] = { ...s.perReview[targetKey], ...patch };
  write(s);
}
