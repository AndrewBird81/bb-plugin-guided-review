import type { BbPluginApi } from "@get-bb/plugin-sdk";

interface ReviewWork {
  turn: boolean;
  maintenance: Promise<void> | null;
}

const work = new WeakMap<BbPluginApi, Map<string, ReviewWork>>();

function stateFor(bb: BbPluginApi, targetKey: string) {
  let reviews = work.get(bb);
  if (!reviews) { reviews = new Map(); work.set(bb, reviews); }
  let state = reviews.get(targetKey);
  if (!state) { state = { turn: false, maintenance: null }; reviews.set(targetKey, state); }
  return { reviews, state };
}

export function isReviewAgentTurnActive(bb: BbPluginApi, targetKey: string) {
  return work.get(bb)?.get(targetKey)?.turn === true;
}

/** Reserve the turn before waiting, so another question cannot queue behind it. */
export async function withReviewAgentTurn<T>(bb: BbPluginApi, targetKey: string, run: () => Promise<T>): Promise<T> {
  const { reviews, state } = stateFor(bb, targetKey);
  if (state.turn) throw new Error("An answer is already in progress for this review.");
  state.turn = true;
  try {
    if (state.maintenance) await state.maintenance;
    return await run();
  } finally {
    state.turn = false;
    if (!state.maintenance) reviews.delete(targetKey);
  }
}

/** Maintenance yields to turns, while an already-started cleanup completes first. */
export async function withReviewAgentMaintenance(bb: BbPluginApi, targetKey: string, run: () => Promise<void>): Promise<void> {
  const { reviews, state } = stateFor(bb, targetKey);
  if (state.turn || state.maintenance) return;
  let release!: () => void;
  state.maintenance = new Promise<void>((resolve) => { release = resolve; });
  try { await run(); }
  finally {
    state.maintenance = null;
    release();
    if (!state.turn) reviews.delete(targetKey);
  }
}
