import { test, expect } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { createStore } from "./store";

function store() {
  const { bb } = createFakePluginHost({ pluginId: "guided-review" });
  return createStore(bb);
}

test("review round-trips and lists newest first", () => {
  const s = store();
  s.saveReview({ targetKey: "pr-1", kind: "pr", number: 1, status: "generating", createdAt: 1 });
  s.saveReview({ targetKey: "pr-2", kind: "pr", number: 2, status: "generating", createdAt: 2 });
  expect(s.getReview("pr-1")?.number).toBe(1);
  expect(s.listReviews().map((r) => r.targetKey)).toEqual(["pr-2", "pr-1"]);
});

test("patch paginates", () => {
  const s = store();
  s.saveReview({ targetKey: "pr-1", kind: "pr", number: 1, status: "generating", createdAt: 1 });
  s.savePatch("pr-1", "abcdef");
  expect(s.readPatch("pr-1", 0, 3)).toEqual({ text: "abc", total: 6 });
  expect(s.readPatch("pr-1", 3, 10)).toEqual({ text: "def", total: 6 });
});

test("saveReview round-trips headSha and cwd", () => {
  const s = store();
  s.saveReview({ targetKey: "pr-1", kind: "pr", number: 1, status: "generating", createdAt: 1, headSha: "abc", cwd: "/repo" });
  const meta = s.getReview("pr-1");
  expect(meta?.headSha).toBe("abc");
  expect(meta?.cwd).toBe("/repo");
});

test("file views upsert, read, and unset", () => {
  const s = store();
  s.saveReview({ targetKey: "pr-1", kind: "pr", number: 1, status: "ready", createdAt: 1 });
  s.setFileViewed("pr-1", "a.ts", "hash-a");
  s.setFileViewed("pr-1", "a.ts", "hash-a2"); // upsert same file → new hash
  s.setFileViewed("pr-1", "b.ts", "hash-b");
  const views = s.getFileViews("pr-1");
  expect(views).toHaveLength(2);
  expect(views.find((v) => v.file === "a.ts")?.hash).toBe("hash-a2");
  s.unsetFileViewed("pr-1", "a.ts");
  expect(s.getFileViews("pr-1").map((v) => v.file)).toEqual(["b.ts"]);
});

test("agent thread id round-trips", () => {
  const s = store();
  expect(s.getAgentThread("pr-1")).toBeNull();
  s.setAgentThread("pr-1", "th_9");
  expect(s.getAgentThread("pr-1")).toBe("th_9");
});

test("agent messages append and list oldest-first with context", () => {
  const s = store();
  s.appendAgentMessage("pr-1", "user", "why flagged?", { file: "a.ts", startLine: 3, endLine: 5 });
  s.appendAgentMessage("pr-1", "assistant", "because it's a test file");
  const msgs = s.listAgentMessages("pr-1");
  expect(msgs.map((m) => m.role)).toEqual(["user", "assistant"]);
  expect(msgs[0].context).toEqual({ file: "a.ts", startLine: 3, endLine: 5 });
  expect(msgs[1].context).toBeNull();
});

test("deleteReview clears every per-review table and leaves other reviews intact", () => {
  const { bb } = createFakePluginHost({ pluginId: "guided-review" });
  const s = createStore(bb);
  for (const key of ["pr-1", "pr-2"]) {
    s.saveReview({ targetKey: key, kind: "pr", number: 1, status: "ready", createdAt: 1 });
    s.savePatch(key, "diff --git a/a.ts b/a.ts\n");
    s.beginGeneration(key);
    s.saveGuide(key, { title: "T", intent: "I", sections: [], unplacedFiles: [] });
    s.upsertDraftComment(key, { file: "a.ts", line: 1, side: "RIGHT", body: "x" });
    s.setFileViewed(key, "a.ts", "hash");
    s.setAgentThread(key, `th-${key}`);
    s.appendAgentMessage(key, "user", "question");
    s.setLifecycle(key, { userArchivedAt: 1 });
    s.saveReviewerNotes(key, "private", 0);
  }
  s.deleteReview("pr-1");

  // Every table keyed by review, including ones added after this test.
  const db = bb.storage.database();
  const tables = (db.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all() as { name: string }[])
    .map((t) => t.name)
    .filter((name) => (db.prepare(`PRAGMA table_info(${name})`).all() as { name: string }[]).some((c) => c.name === "target_key"));
  expect(tables.length).toBeGreaterThan(0);
  const count = (table: string, key: string) => (db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE target_key=?`).get(key) as { n: number }).n;
  for (const table of tables) {
    expect({ table, rows: count(table, "pr-2") }).not.toEqual({ table, rows: 0 });
    expect({ table, rows: count(table, "pr-1") }).toEqual({ table, rows: 0 });
  }
  expect(s.getReview("pr-1")).toBeNull();
  expect(s.getReview("pr-2")).toMatchObject({ userArchivedAt: 1 });
});

test("draft comments upsert and delete", () => {
  const s = store();
  s.saveReview({ targetKey: "pr-1", kind: "pr", number: 1, status: "ready", createdAt: 1 });
  s.upsertDraftComment("pr-1", { file: "a.ts", line: 1, side: "RIGHT", body: "x" });
  s.upsertDraftComment("pr-1", { file: "a.ts", line: 1, side: "RIGHT", body: "updated" });
  let d = s.getDraft("pr-1");
  expect(d.comments).toHaveLength(1);
  expect(d.comments[0].body).toBe("updated");
  d = s.removeDraftComment("pr-1", 0);
  expect(d.comments).toHaveLength(0);
});
