import type { ReviewMeta } from "../src/store";
import { computeTurn, type Turn, type feedbackProgress } from "./turn";
/** A review as the server returns it, with its `turn` and `progress` attached. */
export type ReviewItem = Pick<ReviewMeta, "targetKey"> & Partial<ReviewMeta> & { turn?: Turn; progress?: ReturnType<typeof feedbackProgress> };
/** The server's turn when it sent one; otherwise computed with the default options. */
export function reviewState(review: ReviewItem): Turn {
  return review.turn ?? computeTurn(review);
}
