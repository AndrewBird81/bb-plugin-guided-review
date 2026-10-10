import { expect, test } from "vitest";
import { isRealReview, verdictOf, type ReviewNode } from "./review-verdict";

const review = (state: string, at: string, extra: Partial<ReviewNode> = {}): ReviewNode =>
  ({ state, submittedAt: `2026-10-0${at}T10:00:00Z`, body: "", commit: { oid: `sha${at}` }, comments: { totalCount: 0, nodes: [] }, ...extra });
const reply = (at: string) => review("COMMENTED", at, { comments: { totalCount: 1, nodes: [{ replyTo: { id: "c" } }] } });

test("reply-only and pending reviews aren't real", () => {
  expect(isRealReview(reply("2"))).toBe(false);
  expect(isRealReview(review("PENDING", "2", { body: "draft" }))).toBe(false);
  expect(isRealReview(review("COMMENTED", "2"))).toBe(false);
  expect(isRealReview(review("COMMENTED", "2", { body: "Looks odd" }))).toBe(true);
  // A single new line comment is feedback even without a summary.
  expect(isRealReview(review("COMMENTED", "2", { comments: { totalCount: 1, nodes: [{ replyTo: null }] } }))).toBe(true);
  expect(isRealReview(review("APPROVED", "2"))).toBe(true);
});

test("your standing verdict survives later comments and replies", () => {
  expect(verdictOf([review("CHANGES_REQUESTED", "1"), reply("2")])).toEqual({ verdict: "REQUEST_CHANGES", at: Date.parse("2026-10-01T10:00:00Z"), sha: "sha1" });
  // A later comment review is your latest look, but the verdict stands.
  expect(verdictOf([review("CHANGES_REQUESTED", "1"), review("COMMENTED", "3", { body: "Still waiting on the test" })]))
    .toEqual({ verdict: "REQUEST_CHANGES", at: Date.parse("2026-10-03T10:00:00Z"), sha: "sha3" });
  expect(verdictOf([review("CHANGES_REQUESTED", "1"), review("APPROVED", "4")])?.verdict).toBe("APPROVE");
  expect(verdictOf([reply("1")])).toBeNull();
});

test("a dismissed review leaves no verdict until you comment again", () => {
  expect(verdictOf([review("DISMISSED", "1")])?.verdict).toBeNull();
  expect(verdictOf([review("DISMISSED", "1"), review("COMMENTED", "2", { body: "Re-checked" })])?.verdict).toBe("COMMENT");
});
